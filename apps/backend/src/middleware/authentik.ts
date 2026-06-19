import type { FastifyReply, FastifyRequest } from 'fastify';

import { env } from '../env';
import { hasValidProxySecret, isTrustedProxy } from '../services/authentik-auth.service';

/**
 * Strip inbound `X-authentik-*` headers from any request that does NOT
 * originate from a trusted proxy. The Authentik outpost (or equivalent
 * reverse proxy) is the only entity that should be sending those headers;
 * anything else is treated as spoofing and the headers are removed before
 * downstream code can read them.
 *
 * When a shared secret is configured, the trusted proxy must also forward
 * a matching `x-authentik-proxy-secret` header for the request to be
 * considered trustworthy.
 *
 * When `AUTHENTIK_PROXY_AUTH` is disabled this hook is a no-op.
 */
export async function authentikSecurityHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
	if (!env.AUTHENTIK_PROXY_AUTH) {
		return;
	}

	const trusted =
		isTrustedProxy(request.ip, env.AUTHENTIK_TRUSTED_PROXIES) &&
		hasValidProxySecret(getHeaderValue(request.headers['x-authentik-proxy-secret']), env.AUTHENTIK_PROXY_SECRET);

	if (trusted) {
		return;
	}

	for (const key of Object.keys(request.headers)) {
		if (key.toLowerCase().startsWith('x-authentik-')) {
			delete request.headers[key];
		}
	}
}

function getHeaderValue(value: string | string[] | undefined): string | null {
	if (Array.isArray(value)) {
		return value.length > 0 ? value[0] : null;
	}
	return value ?? null;
}
