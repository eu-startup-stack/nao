import { describe, expect, it, vi } from 'vitest';

// Stub out modules that pull in Bun-only / DB-heavy code so the test file
// can be evaluated in plain Node/Vitest. The functions under test (group
// parsing, CIDR matching, secret comparison, identity resolution) are pure
// and never touch the database.
vi.mock('../src/db/db', () => ({ db: {} }));
vi.mock('../src/queries/user.queries', () => ({ getUser: vi.fn(), createUser: vi.fn() }));
vi.mock('../src/queries/organization.queries', () => ({
	getOrCreateDefaultOrganization: vi.fn(),
	ensureDefaultProjectForOrg: vi.fn(),
	getOrgMember: vi.fn(),
	addOrgMember: vi.fn(),
	updateOrgMemberRole: vi.fn(),
}));
vi.mock('../src/queries/project.queries', () => ({
	getDefaultProject: vi.fn(),
	getProjectMember: vi.fn(),
	addProjectMember: vi.fn(),
	updateProjectMemberRole: vi.fn(),
}));
vi.mock('../src/auth', () => ({ getAuth: vi.fn() }));

import {
	hasValidProxySecret,
	isIpInAnyCidr,
	isIpInCidr,
	isTrustedProxy,
	parseAuthentikGroups,
	resolveAuthentikIdentity,
} from '../src/services/authentik-auth.service';

describe('parseAuthentikGroups', () => {
	it('maps nao-admin to admin', () => {
		expect(parseAuthentikGroups('nao-admin', 'nao')).toBe('admin');
	});

	it('maps nao-user to user', () => {
		expect(parseAuthentikGroups('nao-user', 'nao')).toBe('user');
	});

	it('maps nao-viewer to viewer', () => {
		expect(parseAuthentikGroups('nao-viewer', 'nao')).toBe('viewer');
	});

	it('ignores groups without the prefix and picks the prefixed one', () => {
		expect(parseAuthentikGroups('some-other-group|nao-user', 'nao')).toBe('user');
	});

	it('returns the highest-privilege role when multiple prefixed groups are present', () => {
		expect(parseAuthentikGroups('nao-admin|nao-viewer', 'nao')).toBe('admin');
		expect(parseAuthentikGroups('nao-viewer|nao-user', 'nao')).toBe('user');
	});

	it('returns null when only an unknown suffixed group is present (no valid prefix match)', () => {
		expect(parseAuthentikGroups('nao-unknown|other', 'nao')).toBeNull();
	});

	it('returns null for empty / null / undefined input', () => {
		expect(parseAuthentikGroups('', 'nao')).toBeNull();
		expect(parseAuthentikGroups(null, 'nao')).toBeNull();
		expect(parseAuthentikGroups(undefined, 'nao')).toBeNull();
	});

	it('returns null when no prefixed group is present', () => {
		expect(parseAuthentikGroups('other-group', 'nao')).toBeNull();
	});

	it('respects a custom prefix', () => {
		expect(parseAuthentikGroups('myapp-admin', 'myapp')).toBe('admin');
	});

	it('matches the role suffix case-insensitively', () => {
		expect(parseAuthentikGroups('NAO-Admin', 'nao')).toBe('admin');
		expect(parseAuthentikGroups('nao-ADMIN', 'nao')).toBe('admin');
	});
});

describe('isIpInCidr', () => {
	it('matches an exact /32 IPv4', () => {
		expect(isIpInCidr('127.0.0.1', '127.0.0.1/32')).toBe(true);
	});

	it('rejects a different host inside the same /32', () => {
		expect(isIpInCidr('127.0.0.2', '127.0.0.1/32')).toBe(false);
	});

	it('matches a host inside an IPv4 /24', () => {
		expect(isIpInCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
	});

	it('rejects a host outside an IPv4 /24', () => {
		expect(isIpInCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
	});

	it('matches an exact /128 IPv6', () => {
		expect(isIpInCidr('::1', '::1/128')).toBe(true);
	});

	it('rejects mismatched address families (v4 in v6 CIDR)', () => {
		expect(isIpInCidr('192.168.0.1', '::1/128')).toBe(false);
	});

	it('rejects mismatched address families (v6 in v4 CIDR)', () => {
		expect(isIpInCidr('::1', '192.168.0.0/24')).toBe(false);
	});

	it('matches a plain IP entry as exact match', () => {
		expect(isIpInCidr('1.2.3.4', '1.2.3.4')).toBe(true);
	});

	it('rejects a different IP in plain-IP CIDR entry', () => {
		expect(isIpInCidr('1.2.3.5', '1.2.3.4')).toBe(false);
	});

	it('strips whitespace from CIDR entry', () => {
		expect(isIpInCidr('127.0.0.1', '  127.0.0.1/32  ')).toBe(true);
	});

	it('rejects an out-of-range IPv4 octet', () => {
		expect(isIpInCidr('10.0.0.5', '256.0.0.0/8')).toBe(false);
	});
});

describe('isIpInAnyCidr', () => {
	it('matches when any entry in the list matches', () => {
		expect(isIpInAnyCidr('10.0.0.5', ['127.0.0.1/32', '10.0.0.0/24'])).toBe(true);
	});

	it('does not match when no entry matches', () => {
		expect(isIpInAnyCidr('8.8.8.8', ['127.0.0.1/32', '10.0.0.0/24'])).toBe(false);
	});

	it('returns false for undefined input', () => {
		expect(isIpInAnyCidr(undefined, ['127.0.0.1/32'])).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(isIpInAnyCidr('', ['127.0.0.1/32'])).toBe(false);
	});
});

describe('isTrustedProxy', () => {
	it('matches a trusted IP in the comma-separated list', () => {
		expect(isTrustedProxy('127.0.0.1', '127.0.0.1/32, ::1/128')).toBe(true);
	});

	it('rejects an IP not in the trusted list', () => {
		expect(isTrustedProxy('8.8.8.8', '127.0.0.1/32, ::1/128')).toBe(false);
	});

	it('handles extra whitespace between entries', () => {
		expect(isTrustedProxy('10.0.0.1', '  127.0.0.1/32 , 10.0.0.0/8  ')).toBe(true);
	});

	it('returns false for undefined IP', () => {
		expect(isTrustedProxy(undefined, '127.0.0.1/32')).toBe(false);
	});
});

describe('hasValidProxySecret', () => {
	it('returns true when no secret is configured (open trust)', () => {
		expect(hasValidProxySecret('anything', undefined)).toBe(true);
		expect(hasValidProxySecret(null, undefined)).toBe(true);
	});

	it('returns true when provided matches expected', () => {
		expect(hasValidProxySecret('secret', 'secret')).toBe(true);
	});

	it('returns false when provided does not match expected', () => {
		expect(hasValidProxySecret('wrong', 'secret')).toBe(false);
	});

	it('returns false when provided is missing but expected is set', () => {
		expect(hasValidProxySecret(undefined, 'secret')).toBe(false);
		expect(hasValidProxySecret(null, 'secret')).toBe(false);
	});

	it('returns false for length-mismatched values without throwing', () => {
		expect(hasValidProxySecret('a', 'abcdef')).toBe(false);
	});
});

describe('resolveAuthentikIdentity', () => {
	const baseHeaders = () =>
		new Headers({
			'x-authentik-username': 'alice',
			'x-authentik-email': 'alice@example.com',
			'x-authentik-name': 'Alice Example',
			'x-authentik-uid': 'uid-alice',
			'x-authentik-groups': 'nao-admin',
		});

	it('returns an identity with role admin for nao-admin group', () => {
		const identity = resolveAuthentikIdentity(baseHeaders(), 'nao');
		expect(identity).toEqual({
			username: 'alice',
			email: 'alice@example.com',
			name: 'Alice Example',
			uid: 'uid-alice',
			role: 'admin',
		});
	});

	it('returns null when email is missing', () => {
		const headers = baseHeaders();
		headers.delete('x-authentik-email');
		expect(resolveAuthentikIdentity(headers, 'nao')).toBeNull();
	});

	it('returns null when username is missing', () => {
		const headers = baseHeaders();
		headers.delete('x-authentik-username');
		expect(resolveAuthentikIdentity(headers, 'nao')).toBeNull();
	});

	it('returns null when groups lack any prefixed group', () => {
		const headers = baseHeaders();
		headers.set('x-authentik-groups', 'other');
		expect(resolveAuthentikIdentity(headers, 'nao')).toBeNull();
	});

	it('defaults name to username when x-authentik-name is missing', () => {
		const headers = baseHeaders();
		headers.delete('x-authentik-name');
		const identity = resolveAuthentikIdentity(headers, 'nao');
		expect(identity?.name).toBe('alice');
	});

	it('defaults uid to username when x-authentik-uid is missing', () => {
		const headers = baseHeaders();
		headers.delete('x-authentik-uid');
		const identity = resolveAuthentikIdentity(headers, 'nao');
		expect(identity?.uid).toBe('alice');
	});

	it('returns null when groups header is missing entirely', () => {
		const headers = baseHeaders();
		headers.delete('x-authentik-groups');
		expect(resolveAuthentikIdentity(headers, 'nao')).toBeNull();
	});

	it('maps multiple valid groups to the highest-privilege role', () => {
		const headers = baseHeaders();
		headers.set('x-authentik-groups', 'nao-viewer|nao-admin');
		expect(resolveAuthentikIdentity(headers, 'nao')?.role).toBe('admin');
	});
});
