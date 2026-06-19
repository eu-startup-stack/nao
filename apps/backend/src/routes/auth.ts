import { App } from '../app';
import { getAuth } from '../auth';
import { isAuthentikProxyAuthEnabled, resolveAuthentikSession } from '../services/authentik-auth.service';
import { convertHeaders } from '../utils/utils';

function serializeBody(body: unknown, contentType: string | undefined): string | undefined {
	if (!body) {
		return undefined;
	}
	if (contentType?.includes('application/x-www-form-urlencoded') && typeof body === 'object') {
		return new URLSearchParams(body as Record<string, string>).toString();
	}
	return JSON.stringify(body);
}

export const authRoutes = async (app: App) => {
	app.route({
		method: ['GET', 'POST'],
		url: '/auth/*',
		async handler(request, reply) {
			try {
				const url = new URL(request.url, `http://${request.headers.host}`);
				const headers = convertHeaders(request.headers);

				// When Authentik proxy auth is the configured auth path, the
				// frontend's `useSession()` calls `GET /api/auth/get-session`
				// to decide whether to redirect to /login. Synthesize that
				// response from the proxy headers so the SPA works without
				// a native login round-trip.
				if (
					isAuthentikProxyAuthEnabled() &&
					request.method === 'GET' &&
					url.pathname === '/api/auth/get-session'
				) {
					const session = await resolveAuthentikSession(headers, request.ip);
					reply
						.status(200)
						.header('Content-Type', 'application/json')
						.send(session ? JSON.stringify(session) : 'null');
					return;
				}

				// Create Fetch API-compatible request
				const req = new Request(url.toString(), {
					method: request.method,
					headers,
					body: serializeBody(request.body, request.headers['content-type']),
				});
				// Process authentication request
				const auth = await getAuth();
				const response = await auth.handler(req);
				// Forward response to client
				reply.status(response.status);
				response.headers.forEach((value, key) => reply.header(key, value));
				reply.send(response.body ? await response.text() : null);
			} catch (error) {
				app.log.error(error, 'Authentication Error');
				reply.status(500).send({
					error: 'Internal authentication error',
					code: 'AUTH_FAILURE',
				});
			}
		},
	});
};
