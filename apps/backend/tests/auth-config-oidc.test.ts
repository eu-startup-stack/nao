import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, unknown> = {};
let mockSsoEnabled = true;
const mockGetGoogleConfig = vi.fn();
const mockGetGoogleConfigForOrganizationSlug = vi.fn();

vi.mock('../src/env', () => ({
	get env() {
		return mockEnv;
	},
	get isCloud() {
		return mockEnv.NAO_MODE === 'cloud';
	},
}));

vi.mock('../src/auth', () => ({
	updateAuth: vi.fn(),
}));

vi.mock('../src/queries/organization.queries', () => ({
	getFirstOrganization: vi.fn().mockResolvedValue(null),
	getGoogleConfig: mockGetGoogleConfig,
	getGoogleConfigForOrganizationSlug: mockGetGoogleConfigForOrganizationSlug,
}));

vi.mock('../src/services/email', () => ({
	emailService: { isEnabled: () => false },
}));

vi.mock('../src/services/license.service', () => ({
	hasFeature: vi.fn().mockImplementation(() => Promise.resolve(mockSsoEnabled)),
	LICENSE_FEATURES: { sso: 'sso' },
}));

vi.mock('../src/db/db', () => ({ db: {} }));

describe('authConfigRoutes.oidc.getConfig', () => {
	beforeEach(() => {
		Object.keys(mockEnv).forEach((key) => delete mockEnv[key]);
		mockSsoEnabled = true;
		mockGetGoogleConfig.mockReset();
		mockGetGoogleConfig.mockResolvedValue({
			clientId: '',
			clientSecret: '',
			authDomains: '',
		});
		mockGetGoogleConfigForOrganizationSlug.mockReset();
		mockGetGoogleConfigForOrganizationSlug.mockResolvedValue({
			org: null,
			config: {
				clientId: '',
				clientSecret: '',
				authDomains: '',
			},
		});
	});

	it('returns null when OIDC_CLIENT_ID is missing', async () => {
		mockEnv.OIDC_CLIENT_SECRET = 'secret';
		mockEnv.OIDC_DISCOVERY_URL = 'https://example.com/.well-known/openid-configuration';

		const result = await callGetConfig();
		expect(result).toBeNull();
	});

	it('returns null when OIDC_CLIENT_SECRET is missing', async () => {
		mockEnv.OIDC_CLIENT_ID = 'client-id';
		mockEnv.OIDC_DISCOVERY_URL = 'https://example.com/.well-known/openid-configuration';

		const result = await callGetConfig();
		expect(result).toBeNull();
	});

	it('returns null when OIDC_DISCOVERY_URL is missing', async () => {
		mockEnv.OIDC_CLIENT_ID = 'client-id';
		mockEnv.OIDC_CLIENT_SECRET = 'secret';

		const result = await callGetConfig();
		expect(result).toBeNull();
	});

	it('returns config with defaults when all required vars are set', async () => {
		mockEnv.OIDC_CLIENT_ID = 'client-id';
		mockEnv.OIDC_CLIENT_SECRET = 'secret';
		mockEnv.OIDC_DISCOVERY_URL = 'https://example.com/.well-known/openid-configuration';

		const result = await callGetConfig();
		expect(result).toEqual({
			providerId: 'oidc',
			providerName: 'SSO',
		});
	});

	it('returns null when SSO license feature is not enabled', async () => {
		mockSsoEnabled = false;
		mockEnv.OIDC_CLIENT_ID = 'client-id';
		mockEnv.OIDC_CLIENT_SECRET = 'secret';
		mockEnv.OIDC_DISCOVERY_URL = 'https://example.com/.well-known/openid-configuration';

		const result = await callGetConfig();
		expect(result).toBeNull();
	});

	it('returns custom provider ID and name when set', async () => {
		mockEnv.OIDC_CLIENT_ID = 'client-id';
		mockEnv.OIDC_CLIENT_SECRET = 'secret';
		mockEnv.OIDC_DISCOVERY_URL = 'https://dev-test.okta.com/oauth2/default/.well-known/openid-configuration';
		mockEnv.OIDC_PROVIDER_ID = 'okta';
		mockEnv.OIDC_PROVIDER_NAME = 'Okta';

		const result = await callGetConfig();
		expect(result).toEqual({
			providerId: 'okta',
			providerName: 'Okta',
		});
	});
});

describe('authConfigRoutes.google.isSetup', () => {
	beforeEach(() => {
		Object.keys(mockEnv).forEach((key) => delete mockEnv[key]);
		mockEnv.BETTER_AUTH_URL = 'https://nao.cloud';
		mockGetGoogleConfig.mockReset();
		mockGetGoogleConfig.mockResolvedValue({
			clientId: 'global-client',
			clientSecret: 'global-secret',
			authDomains: '',
		});
		mockGetGoogleConfigForOrganizationSlug.mockReset();
		mockGetGoogleConfigForOrganizationSlug.mockResolvedValue({
			org: { id: 'org-acme' },
			config: {
				clientId: 'acme-client',
				clientSecret: 'acme-secret',
				authDomains: 'acme.com',
			},
		});
	});

	it('does not expose Google SSO on the cloud apex host', async () => {
		mockEnv.NAO_MODE = 'cloud';

		await expect(callGoogleIsSetup('nao.cloud')).resolves.toBe(false);
		expect(mockGetGoogleConfig).not.toHaveBeenCalled();
	});

	it('uses the tenant subdomain Google config', async () => {
		mockEnv.NAO_MODE = 'cloud';

		await expect(callGoogleIsSetup('acme.nao.cloud')).resolves.toBe(true);
		expect(mockGetGoogleConfigForOrganizationSlug).toHaveBeenCalledWith('acme', false);
	});

	it('falls back to global Google config outside cloud tenant hosts', async () => {
		mockEnv.NAO_MODE = 'self-hosted';

		await expect(callGoogleIsSetup('localhost:5005')).resolves.toBe(true);
		expect(mockGetGoogleConfig).toHaveBeenCalled();
	});
});

async function callGetConfig() {
	vi.resetModules();
	const { authConfigRoutes } = await import('../src/trpc/auth-config.routes');
	const procedure = authConfigRoutes.oidc.getConfig;
	// The procedure is a tRPC query — extract the resolver function
	// @ts-expect-error accessing internal tRPC structure for testing
	const resolver = procedure._def.query ?? procedure._def.resolver;
	if (resolver) {
		return resolver({ ctx: {}, input: undefined });
	}
	// Fallback: try calling directly if the structure differs
	return null;
}

async function callGoogleIsSetup(authHost: string) {
	vi.resetModules();
	const { authConfigRoutes } = await import('../src/trpc/auth-config.routes');
	const procedure = authConfigRoutes.google.isSetup;
	// @ts-expect-error accessing internal tRPC structure for testing
	const resolver = procedure._def.query ?? procedure._def.resolver;
	if (resolver) {
		return resolver({ ctx: { authHost }, input: undefined });
	}
	return null;
}
