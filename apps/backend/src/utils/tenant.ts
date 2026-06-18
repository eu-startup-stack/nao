import { env } from '../env';

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

export function resolveTenantSlugFromHost(
	host: string | null | undefined,
	baseUrl = env.BETTER_AUTH_URL,
): string | null {
	const normalizedHost = normalizeHost(host);
	const baseHost = normalizeHost(getBaseHost(baseUrl));

	if (!normalizedHost || !baseHost || normalizedHost === baseHost) {
		return null;
	}

	const suffix = `.${baseHost}`;
	if (!normalizedHost.endsWith(suffix)) {
		return null;
	}

	const subdomain = normalizedHost.slice(0, -suffix.length);
	const slug = subdomain.split('.').filter(Boolean).at(-1);
	return slug && !LOCALHOST_NAMES.has(slug) ? slug : null;
}

export function getRequestHost(headers: Headers): string | null {
	return getFirstHeaderValue(headers.get('x-forwarded-host')) ?? getFirstHeaderValue(headers.get('host'));
}

export function getRequestOrigin(headers: Headers): string | null {
	const host = getRequestHost(headers);
	if (!host) {
		return null;
	}

	const protocol = getFirstHeaderValue(headers.get('x-forwarded-proto')) ?? getBaseProtocol();
	return `${protocol}://${host}`;
}

export function getTenantOrigin(headers: Headers): string | null {
	const host = getRequestHost(headers);
	if (!resolveTenantSlugFromHost(host)) {
		return null;
	}
	return getRequestOrigin(headers);
}

function getBaseHost(baseUrl: string): string | null {
	try {
		return new URL(baseUrl).host;
	} catch {
		return null;
	}
}

function getBaseProtocol(): string {
	try {
		return new URL(env.BETTER_AUTH_URL).protocol.replace(':', '');
	} catch {
		return 'http';
	}
}

function normalizeHost(host: string | null | undefined): string | null {
	const value = getFirstHeaderValue(host)?.trim().toLowerCase();
	if (!value) {
		return null;
	}

	if (value.startsWith('[')) {
		const closingBracket = value.indexOf(']');
		return closingBracket === -1 ? value : value.slice(0, closingBracket + 1);
	}

	return value.split(':')[0] ?? null;
}

function getFirstHeaderValue(value: string | null | undefined): string | null {
	return value?.split(',')[0]?.trim() || null;
}
