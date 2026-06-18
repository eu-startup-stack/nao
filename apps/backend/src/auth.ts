import type { ResourceServerMetadata } from '@better-auth/oauth-provider';
import {
	oauthProvider,
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { verifyAccessToken } from 'better-auth/oauth2';
import { jwt } from 'better-auth/plugins';
import { bearer } from 'better-auth/plugins/bearer';
import type { JWTPayload } from 'jose';

import { db } from './db/db';
import dbConfig, { Dialect } from './db/dbConfig';
import { env, isCloud, MCP_SERVER_URL } from './env';
import * as orgQueries from './queries/organization.queries';
import * as userQueries from './queries/user.queries';
import { emailService } from './services/email';
import { githubOAuthConfig } from './services/github';
import { hasFeature, LICENSE_FEATURES } from './services/license.service';
import {
	augmentSocialProvidersWithMicrosoft,
	getTrustedProvidersForMicrosoft,
	isSocialProviderMicrosoft,
} from './services/microsoft-auth.service';
import {
	augmentPluginsWithOidc,
	getOidcProviderId,
	getTrustedProvidersForOidc,
	isSocialProviderOidc,
} from './services/oidc-auth.service';
import { buildForgotPasswordEmail } from './utils/email-builders';
import { getRequestHost, getTenantOrigin, resolveTenantSlugFromHost } from './utils/tenant';
import { buildGithubAllowlist, isEmailDomainAllowed, resolveProviderId } from './utils/utils';

type GoogleConfig = Awaited<ReturnType<typeof orgQueries.getGoogleConfig>>;
type MetadataHandler = (request: Request) => Promise<Response>;

let defaultAuthPromise: Promise<Awaited<ReturnType<typeof createAuthInstance>>> | null = null;
const tenantAuthPromises = new Map<string, Promise<Awaited<ReturnType<typeof createAuthInstance>>>>();
let authServerMetadataPromise: Promise<MetadataHandler> | null = null;
let openIdConfigMetadataPromise: Promise<MetadataHandler> | null = null;

export const getAuth = async (headers?: Headers | null) => {
	const tenantContext = headers ? await getTenantAuthContext(headers) : null;

	if (!tenantContext) {
		if (!defaultAuthPromise) {
			defaultAuthPromise = orgQueries
				.getGoogleConfig()
				.then((config) => createAuthInstance(config, env.BETTER_AUTH_URL));
		}
		return defaultAuthPromise;
	}

	const cacheKey = `${tenantContext.cacheKey}:${tenantContext.baseURL}`;
	const cached = tenantAuthPromises.get(cacheKey);
	if (cached) {
		return cached;
	}

	const promise = createAuthInstance(tenantContext.googleConfig, tenantContext.baseURL);
	tenantAuthPromises.set(cacheKey, promise);
	return promise;
};

export function updateAuth() {
	defaultAuthPromise = null;
	tenantAuthPromises.clear();
	authServerMetadataPromise = null;
	openIdConfigMetadataPromise = null;
}

export async function verifyOAuthAccessToken(token: string, audience: string): Promise<JWTPayload> {
	const { issuer, jwksUrl } = await getAuthServerEndpoints();
	return verifyAccessToken(token, {
		verifyOptions: { audience, issuer },
		jwksUrl,
	});
}

export async function buildProtectedResourceMetadata(
	overrides: ResourceServerMetadata,
): Promise<ResourceServerMetadata> {
	const { issuer } = await getAuthServerEndpoints();
	return {
		authorization_servers: [issuer],
		...overrides,
	};
}

export function getAuthServerMetadataHandler(): Promise<MetadataHandler> {
	if (!authServerMetadataPromise) {
		authServerMetadataPromise = getAuth().then(oauthProviderAuthServerMetadata);
	}
	return authServerMetadataPromise;
}

export function getOpenIdConfigMetadataHandler(): Promise<MetadataHandler> {
	if (!openIdConfigMetadataPromise) {
		openIdConfigMetadataPromise = getAuth().then(oauthProviderOpenIdConfigMetadata);
	}
	return openIdConfigMetadataPromise;
}

async function createAuthInstance(googleConfig: GoogleConfig, baseURL: string) {
	const githubAllowlist = buildGithubAllowlist(env.GITHUB_ALLOWED_USERS);
	const disableEmailSignUp = await shouldDisableEmailSignUp();

	const ssoPlugins: BetterAuthPlugin[] = [];

	const socialProviders: Parameters<typeof betterAuth>[0]['socialProviders'] = {
		google: {
			prompt: 'select_account',
			clientId: googleConfig.clientId,
			clientSecret: googleConfig.clientSecret,
		},
	};

	const githubConfig = env.GITHUB_SSO ? githubOAuthConfig() : null;
	if (githubConfig) {
		socialProviders.github = {
			clientId: githubConfig.clientId,
			clientSecret: githubConfig.clientSecret,
			getUserInfo: async (token) => {
				const res = await fetch('https://api.github.com/user', {
					headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
				});
				const profile = await res.json();

				if (githubAllowlist.size > 0 && !githubAllowlist.has(profile.login)) {
					throw new APIError('FORBIDDEN', {
						message: 'Your GitHub account is not authorized to access this application.',
					});
				}

				return {
					user: {
						id: String(profile.id),
						name: profile.login as string,
						email: (profile.email ?? `${profile.login}@users.noreply.github.com`) as string,
						image: profile.avatar_url as string,
						emailVerified: true,
					},
					data: profile,
				};
			},
		};
	}

	const ssoEnabled = await hasFeature(LICENSE_FEATURES.sso);
	if (ssoEnabled) {
		augmentSocialProvidersWithMicrosoft(socialProviders);
		augmentPluginsWithOidc(ssoPlugins);
	}

	const trustedProviders = [
		'google',
		'github',
		...(ssoEnabled ? [...getTrustedProvidersForMicrosoft(), ...getTrustedProvidersForOidc()] : []),
	];

	return betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		baseURL,
		basePath: '/api/auth',
		database: drizzleAdapter(db, {
			provider: dbConfig.dialect === Dialect.Postgres ? 'pg' : 'sqlite',
			schema: dbConfig.schema,
		}),
		plugins: [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/login',
				consentPage: '/consent',
				accessTokenExpiresIn: 86400,
				refreshTokenExpiresIn: 604800,
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				validAudiences: [env.BETTER_AUTH_URL, MCP_SERVER_URL],
			}),
			...ssoPlugins,
		],
		trustedOrigins: baseURL ? [baseURL] : undefined,
		emailAndPassword: {
			enabled: env.ENABLE_USER_LOGIN === true,
			disableSignUp: disableEmailSignUp,
			sendResetPassword: async ({ user, url }) => {
				emailService.sendEmail(user.email, buildForgotPasswordEmail(user, url));
			},
		},
		socialProviders,
		account: {
			accountLinking: {
				enabled: true,
				trustedProviders,
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user, ctx) => {
						const providerId = resolveProviderId(ctx);

						if (providerId === 'google' && !isEmailDomainAllowed(user.email, googleConfig.authDomains)) {
							throw new APIError('FORBIDDEN', {
								message: 'This email domain is not authorized to access this application.',
							});
						}

						if (
							ssoEnabled &&
							providerId === getOidcProviderId() &&
							!isEmailDomainAllowed(user.email, env.OIDC_AUTH_DOMAINS ?? '')
						) {
							throw new APIError('FORBIDDEN', {
								message: 'This email domain is not authorized to access this application.',
							});
						}

						return true;
					},
					async after(user, ctx) {
						const providerId = resolveProviderId(ctx);
						const isSocial =
							providerId === 'google' ||
							providerId === 'github' ||
							(ssoEnabled && (isSocialProviderMicrosoft(providerId) || isSocialProviderOidc(providerId)));

						if (isCloud) {
							if (providerId === 'google' && googleConfig.orgId) {
								await orgQueries.addOrgMemberIfMissing({
									orgId: googleConfig.orgId,
									userId: user.id,
									role: env.DEFAULT_USER_ROLE,
								});
							} else {
								await orgQueries.initializePersonalOrganization(user.id);
							}
						} else {
							await orgQueries.initializeDefaultOrganizationForFirstUser(user.id);
							if (isSocial) {
								await orgQueries.addUserToDefaultProjectIfExists(user.id);
							}
						}
						await refreshAuthAfterInitialSelfHostedSignup();
					},
				},
			},
		},
		user: {
			additionalFields: {
				requiresPasswordReset: { type: 'boolean', default: false, input: false },
				messagingProviderCode: { type: 'string', default: '', input: false },
			},
		},
	});
}

async function getTenantAuthContext(headers: Headers): Promise<{
	cacheKey: string;
	baseURL: string;
	googleConfig: GoogleConfig;
} | null> {
	const host = getRequestHost(headers);
	const tenantSlug = resolveTenantSlugFromHost(host);
	if (!tenantSlug) {
		return null;
	}

	const { org, config } = await orgQueries.getGoogleConfigForOrganizationSlug(tenantSlug, false);
	return {
		cacheKey: org ? `org:${org.id}` : `unknown:${tenantSlug}`,
		baseURL: getTenantOrigin(headers) ?? env.BETTER_AUTH_URL,
		googleConfig: config,
	};
}

async function shouldDisableEmailSignUp(): Promise<boolean> {
	if (env.ENABLE_USER_SIGNUP) {
		return false;
	}

	const userCount = await userQueries.countUsers();
	return userCount > 0;
}

async function refreshAuthAfterInitialSelfHostedSignup(): Promise<void> {
	if (env.ENABLE_USER_SIGNUP) {
		return;
	}

	const userCount = await userQueries.countUsers();
	if (userCount === 1) {
		updateAuth();
	}
}

async function getAuthServerEndpoints(): Promise<{ issuer: string; jwksUrl: string }> {
	const auth = await getAuth();
	const context = await auth.$context;
	const issuer = context.baseURL;
	return { issuer, jwksUrl: `${issuer}/jwks` };
}
