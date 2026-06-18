import { describe, expect, it } from 'vitest';

import { resolveTenantSlugFromHost } from '../src/utils/tenant';

describe('resolveTenantSlugFromHost', () => {
	const baseUrl = 'https://nao.cloud';

	it('resolves the organization slug from a base-domain subdomain', () => {
		expect(resolveTenantSlugFromHost('acme.nao.cloud', baseUrl)).toBe('acme');
	});

	it('ignores the apex host', () => {
		expect(resolveTenantSlugFromHost('nao.cloud', baseUrl)).toBeNull();
	});

	it('ignores unrelated hosts', () => {
		expect(resolveTenantSlugFromHost('acme.example.com', baseUrl)).toBeNull();
	});

	it('handles ports and forwarded host lists', () => {
		expect(resolveTenantSlugFromHost('acme.nao.cloud:5005, proxy.internal', baseUrl)).toBe('acme');
	});

	it('supports nested deployment prefixes by using the nearest tenant label', () => {
		expect(resolveTenantSlugFromHost('preview.acme.nao.cloud', baseUrl)).toBe('acme');
	});
});
