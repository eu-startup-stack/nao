import crypto from 'node:crypto';

import type { Session, User } from 'better-auth';

import { getAuth } from '../auth';
import type { User as DBUser } from '../db/abstractSchema';
import { env } from '../env';
import * as orgQueries from '../queries/organization.queries';
import * as projectQueries from '../queries/project.queries';
import * as userQueries from '../queries/user.queries';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** Header prefix used by the Authentik proxy outpost (all headers are lowercase). */
export const AUTHENTIK_HEADER_PREFIX = 'x-authentik-';

/** App-level role derived from the Authentik group suffix. */
export type AppRole = 'admin' | 'user' | 'viewer';

/** Higher number wins when a user belongs to multiple prefixed groups. */
export const ROLE_PRECEDENCE: Record<AppRole, number> = {
	admin: 3,
	user: 2,
	viewer: 1,
};

export interface AuthentikIdentity {
	username: string;
	email: string;
	name: string;
	uid: string;
	role: AppRole;
}

export interface AuthSession {
	session: Session;
	user: User;
}

// ---------------------------------------------------------------------------
// CIDR matching
// ---------------------------------------------------------------------------

/**
 * Test whether an IP address is contained in an IPv4 or IPv6 CIDR block.
 * Plain IP entries (no `/prefix`) are treated as exact matches.
 * Returns `false` for any parse error or family mismatch (v4 vs v6).
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
	const trimmedCidr = cidr.trim();
	if (!trimmedCidr) {
		return false;
	}

	const slashIndex = trimmedCidr.indexOf('/');
	if (slashIndex === -1) {
		// Plain IP — exact match
		return normalizeIp(ip) === normalizeIp(trimmedCidr);
	}

	const network = trimmedCidr.slice(0, slashIndex);
	const prefixStr = trimmedCidr.slice(slashIndex + 1);
	const prefix = Number.parseInt(prefixStr, 10);
	if (Number.isNaN(prefix)) {
		return false;
	}

	const ipFamily = ipFamilyOf(ip);
	const netFamily = ipFamilyOf(network);
	if (!ipFamily || !netFamily || ipFamily !== netFamily) {
		return false;
	}

	const maxPrefix = ipFamily === 'v4' ? 32 : 128;
	if (prefix < 0 || prefix > maxPrefix) {
		return false;
	}

	const ipBig = ipToBigInt(ip);
	const netBig = ipToBigInt(network);
	if (ipBig === null || netBig === null) {
		return false;
	}

	if (prefix === 0) {
		return true;
	}

	const mask = ((1n << BigInt(maxPrefix)) - 1n) ^ ((1n << BigInt(maxPrefix - prefix)) - 1n);
	return (ipBig & mask) === (netBig & mask);
}

export function isIpInAnyCidr(ip: string | undefined, cidrs: string[]): boolean {
	if (!ip) {
		return false;
	}
	for (const cidr of cidrs) {
		if (isIpInCidr(ip, cidr)) {
			return true;
		}
	}
	return false;
}

function ipFamilyOf(ip: string): 'v4' | 'v6' | null {
	const v4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
	if (v4Match) {
		return 'v4';
	}
	if (ip.includes(':')) {
		return 'v6';
	}
	return null;
}

function normalizeIp(ip: string): string {
	return ip.trim().toLowerCase();
}

function ipToBigInt(ip: string): bigint | null {
	const trimmed = ip.trim();
	const v4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
	if (v4Match) {
		const octets = v4Match.slice(1).map((o) => Number.parseInt(o, 10));
		if (octets.some((o) => o < 0 || o > 255)) {
			return null;
		}
		let result = 0n;
		for (const octet of octets) {
			result = (result << 8n) | BigInt(octet);
		}
		return result;
	}
	if (trimmed.includes(':')) {
		return ipv6ToBigInt(trimmed);
	}
	return null;
}

function ipv6ToBigInt(ip: string): bigint | null {
	// Handle IPv4-mapped IPv6 ("::ffff:a.b.c.d")
	let working = ip.toLowerCase();
	const v4MappedMatch = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(working);
	if (v4MappedMatch) {
		const v4 = v4MappedMatch[1];
		const parts = v4.split('.').map((p) => Number.parseInt(p, 10));
		if (parts.some((p) => p < 0 || p > 255)) {
			return null;
		}
		const hex = parts.map((p) => p.toString(16).padStart(2, '0')).join('');
		working = `::ffff:${hex}`;
	}

	// Expand "::" shorthand
	if (working.includes('::')) {
		const sides = working.split('::');
		if (sides.length > 2) {
			return null;
		}
		const left = sides[0] ? sides[0].split(':') : [];
		const right = sides[1] ? sides[1].split(':') : [];
		const missing = 8 - left.length - right.length;
		if (missing < 0) {
			return null;
		}
		const full = [...left, ...Array<string>(missing).fill('0'), ...right];
		working = full.join(':');
	}

	const groups = working.split(':');
	if (groups.length !== 8) {
		return null;
	}
	let result = 0n;
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) {
			return null;
		}
		result = (result << 16n) | BigInt(`0x${group}`);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Group parsing
// ---------------------------------------------------------------------------

/**
 * Parse the value of `X-authentik-groups` and return the highest-privilege
 * app role whose group name starts with `<prefix>-`. Returns `null` when the
 * user has no prefixed group (caller should deny access — no default role).
 */
export function parseAuthentikGroups(rawGroups: string | null | undefined, prefix: string): AppRole | null {
	if (!rawGroups) {
		return null;
	}
	const trimmedPrefix = prefix.trim();
	if (!trimmedPrefix) {
		return null;
	}
	const tokenPrefix = `${trimmedPrefix}-`;

	const tokens = rawGroups
		.split('|')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);

	let best: AppRole | null = null;
	for (const token of tokens) {
		if (!token.toLowerCase().startsWith(tokenPrefix.toLowerCase())) {
			continue;
		}
		const candidate = token.slice(tokenPrefix.length).trim().toLowerCase();
		const role = candidateToRole(candidate);
		if (role && (!best || ROLE_PRECEDENCE[role] > ROLE_PRECEDENCE[best])) {
			best = role;
		}
	}
	return best;
}

function candidateToRole(candidate: string): AppRole | null {
	switch (candidate) {
		case 'admin':
			return 'admin';
		case 'user':
			return 'user';
		case 'viewer':
			return 'viewer';
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Extract a normalized identity from incoming `X-authentik-*` headers.
 * Returns `null` when the request is not a valid Authentik-authenticated
 * request (missing username or email) or when no role group is present.
 */
export function resolveAuthentikIdentity(headers: Headers, prefix: string): AuthentikIdentity | null {
	const username = headers.get('x-authentik-username')?.trim();
	const email = headers.get('x-authentik-email')?.trim();
	if (!username || !email) {
		return null;
	}

	const role = parseAuthentikGroups(headers.get('x-authentik-groups'), prefix);
	if (!role) {
		return null;
	}

	const name = headers.get('x-authentik-name')?.trim() || username;
	const uid = headers.get('x-authentik-uid')?.trim() || username;

	return { username, email, name, uid, role };
}

// ---------------------------------------------------------------------------
// Trusted proxy + secret
// ---------------------------------------------------------------------------

export function isTrustedProxy(ip: string | undefined, trustedProxies: string): boolean {
	if (!ip) {
		return false;
	}
	const list = trustedProxies
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return isIpInAnyCidr(ip, list);
}

/**
 * Constant-time comparison of the inbound shared secret against the expected
 * value. Returns `true` when no secret is configured (auth is open to trusted
 * proxies only). Returns `false` for missing/empty provided values.
 */
export function hasValidProxySecret(provided: string | null | undefined, expected: string | undefined): boolean {
	if (!expected) {
		return true;
	}
	if (!provided) {
		return false;
	}
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) {
		// Compare against itself so we still consume constant time before returning
		crypto.timingSafeEqual(a, a);
		return false;
	}
	return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// JIT provisioning
// ---------------------------------------------------------------------------

/**
 * Ensure a user record exists for the given Authentik identity and is a
 * member of the default organization + project with the role derived from
 * the user's Authentik groups. Idempotent — safe to call on every request.
 */
export async function provisionAuthentikUser(identity: AuthentikIdentity): Promise<DBUser> {
	const email = identity.email.toLowerCase();

	let user = await userQueries.getUser({ email });
	if (!user) {
		const userId = crypto.randomUUID();
		const accountId = crypto.randomUUID();
		user = await userQueries.createUser(
			{
				id: userId,
				name: identity.name,
				email,
				emailVerified: true,
				image: null,
			},
			{
				id: accountId,
				userId,
				accountId: identity.uid,
				providerId: 'authentik',
			},
		);
	}

	const org = await orgQueries.getOrCreateDefaultOrganization();
	await orgQueries.ensureDefaultProjectForOrg(org);

	const existingOrgMember = await orgQueries.getOrgMember(org.id, user.id);
	if (existingOrgMember) {
		if (existingOrgMember.role !== identity.role) {
			await orgQueries.updateOrgMemberRole(org.id, user.id, identity.role);
		}
	} else {
		await orgQueries.addOrgMember({ orgId: org.id, userId: user.id, role: identity.role });
	}

	const project = await projectQueries.getDefaultProject();
	if (project) {
		const existingProjectMember = await projectQueries.getProjectMember(project.id, user.id);
		if (existingProjectMember) {
			if (existingProjectMember.role !== identity.role) {
				await projectQueries.updateProjectMemberRole(project.id, user.id, identity.role);
			}
		} else {
			await projectQueries.addProjectMember({ projectId: project.id, userId: user.id, role: identity.role });
		}
	}

	// Re-read so we return the latest persisted state (messagingProviderCode, etc.)
	const fresh = await userQueries.getUser({ id: user.id });
	return fresh ?? user;
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Better Auth-shaped session from the Authentik proxy headers.
 * Returns `null` when Authentik mode is disabled, the request is not from a
 * trusted proxy, the shared secret does not match, or the headers describe
 * an unauthenticated request.
 */
export async function resolveAuthentikSession(
	headers: Headers,
	clientIp: string | undefined,
): Promise<AuthSession | null> {
	if (!env.AUTHENTIK_PROXY_AUTH) {
		return null;
	}
	if (!isTrustedProxy(clientIp, env.AUTHENTIK_TRUSTED_PROXIES)) {
		return null;
	}
	if (!hasValidProxySecret(headers.get('x-authentik-proxy-secret'), env.AUTHENTIK_PROXY_SECRET)) {
		return null;
	}

	const identity = resolveAuthentikIdentity(headers, env.AUTHENTIK_GROUP_PREFIX);
	if (!identity) {
		return null;
	}

	const user = await provisionAuthentikUser(identity);

	const now = new Date();
	const session = {
		id: `authentik-${user.id}`,
		token: `authentik-${user.id}`,
		expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
		createdAt: now,
		updatedAt: now,
		ipAddress: clientIp ?? null,
		userAgent: null,
		userId: user.id,
	} as Session;

	// Better Auth `User` is generic over additional user fields. The
	// Authentik path doesn't know about `requiresPasswordReset` or
	// `messagingProviderCode` at the type level, but the runtime session
	// handlers expect them, so cast to a structural type that includes them.
	const userWithExtras = {
		...(user as unknown as User),
		requiresPasswordReset: false,
		messagingProviderCode: user.messagingProviderCode ?? '',
	} as User;

	return { session, user: userWithExtras };
}

/**
 * Unified session resolver used by trpc, the auth middleware, the MCP
 * auth path, and the GitHub routes. When `AUTHENTIK_PROXY_AUTH` is on,
 * Authentik is the only path: if the headers don't authenticate the
 * request, the result is `null` (no native Better Auth fallback).
 * When Authentik is off, delegates to Better Auth's session API.
 */
export async function resolveSession(headers: Headers, clientIp: string | undefined): Promise<AuthSession | null> {
	if (env.AUTHENTIK_PROXY_AUTH) {
		const authentikSession = await resolveAuthentikSession(headers, clientIp);
		if (authentikSession) {
			return authentikSession;
		}
		return null;
	}

	const auth = await getAuth();
	const session = (await auth.api.getSession({ headers })) as AuthSession | null;
	return session;
}

export function isAuthentikProxyAuthEnabled(): boolean {
	return env.AUTHENTIK_PROXY_AUTH;
}
