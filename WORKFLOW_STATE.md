# WORKFLOW_STATE — Authentik Proxy Header Auth for nao

## Current auth mechanism (found)

- Stack: Fastify + tRPC + Drizzle ORM + **Better Auth** (`better-auth`).
- `apps/backend/src/auth.ts` builds the Better Auth instance (email/password, Google, GitHub, OIDC/Microsoft SSO [EE-gated], oauthProvider + jwt + bearer plugins).
- Session resolution via `auth.api.getSession({ headers })` in 4 places:
    - `apps/backend/src/trpc/trpc.ts` `createContext`
    - `apps/backend/src/middleware/auth.ts` `authMiddleware` (used by agent + test routes)
    - `apps/backend/src/mcp/auth.ts` `resolveUserId`
    - `apps/backend/src/routes/github.ts`
- `/api/auth/*` proxied to Better Auth handler (`routes/auth.ts`).
- User model: `user` (id/name/email/...), `account` (providerId/accountId/password), `session`. Roles: `admin|user|viewer` (UserRole = OrgRole).
- JIT precedent: `services/team-member.ts` (`createUserWithPassword`).
- Self-hosted (OSS) structure: one default org + one default project (from `NAO_DEFAULT_PROJECT_PATH`).
- Frontend: Better Auth React client (`useSession`/`signIn`/`signOut`); `__root.tsx` redirects to `/login` when no session; login/signup/forgot/reset routes; sign-out button in settings account page.

## Plan (Authentik proxy header auth, community/OSS only)

1. Add env vars: `AUTHENTIK_PROXY_AUTH` (bool, default false), `AUTHENTIK_TRUSTED_PROXIES` (comma-separated IPs/CIDRs, default loopback), `AUTHENTIK_PROXY_SECRET` (optional shared secret), `AUTHENTIK_GROUP_PREFIX` (default `nao`).
2. New `services/authentik-auth.service.ts`:
    - `isAuthentikProxyAuthEnabled()`, `isTrustedProxy(ip)`, CIDR matcher.
    - `parseAuthentikGroups(raw, prefix)` → strip prefix, map to app roles, reject if no prefixed group, pick highest privilege (admin>user>viewer).
    - `resolveAuthentikIdentity(headers)` → `{ username, email, name, uid, groups, role } | null`.
    - `provisionAuthentikUser(identity)` → JIT create user+account (providerId `authentik`) if missing; ensure default org + project membership; sync role to mapped Authentik role on every request.
    - `resolveAuthentikSession(headers, ip)` → `{ session, user } | null` (synthetic session from DB user).
    - `resolveSession(headers, ip)` → Authentik-first, fallback to Better Auth `getSession`.
3. New `middleware/authentik.ts`: global `onRequest` hook — when enabled, strip all `x-authentik-*` headers from non-trusted-proxy requests (anti-spoof). Optional shared-secret check.
4. Wire `resolveSession` into trpc `createContext`, `authMiddleware`, `mcp/auth.ts resolveUserId`, `github.ts`.
5. `routes/auth.ts`: intercept `GET /api/auth/get-session` when Authentik on → return Authentik session (so frontend `useSession` works without native login).
6. `queries/organization.queries.ts`: export `ensureDefaultProjectForOrg` (reuse for JIT project creation).
7. `trpc/system.routes.ts`: expose `authentikProxyAuth` in `getPublicConfig`.
8. Frontend: login/signup routes redirect to `/` when `authentikProxyAuth` on; hide sign-out button in account settings (proxy controls session).
9. `.env.example`: document new vars.
10. Tests: `tests/authentik-auth.test.ts` — group mapping, prefix strip, reject-if-no-prefixed-group, highest privilege, trusted proxy CIDR, header stripping.

## Assumptions (documented)

- App prefix for THIS app = `nao` (per policy). Configurable via `AUTHENTIK_GROUP_PREFIX`, default `nao`.
- Role mapping: `nao-admin`→admin, `nao-user`→user, `nao-viewer`→viewer. Unknown suffixed groups ignored. No `nao-` group ⇒ deny.
- Trust boundary = source IP (`request.ip`, Fastify `trustProxy: true` already set) in `AUTHENTIK_TRUSTED_PROXIES` (IP/CIDR). Optional shared secret header `x-authentik-proxy-secret`.
- JIT keyed by email (lowercased). Account record `providerId: 'authentik'`, `accountId: X-authentik-uid`.
- Self-hosted/OSS path only (`NAO_MODE=self-hosted`); EE/license-gated SSO untouched.
- When Authentik mode is OFF (default), all existing Better Auth flows are unchanged.
- Synthetic session has far-future expiry; no DB session row created (proxy re-authenticates every request).
- MCP bearer-token flow preserved as fallback after Authentik header check.

## Task Briefs

- Task 1: env vars + authentik-auth.service.ts + CIDR matcher + tests (pure logic).
- Task 2: middleware/authentik.ts strip hook + register in app.ts.
- Task 3: wire resolveSession into trpc/middleware/mcp/github + auth routes get-session intercept + org query export.
- Task 4: system config flag + frontend login/signup redirect + hide sign-out + .env.example.
- Task 5: lint + tests + commit + push to origin main.

## Implementation Notes (2026-06-19)

- Implemented per the plan. When `AUTHENTIK_PROXY_AUTH=false` (default), every
  existing call site keeps delegating to `getAuth().api.getSession(...)`.
- `services/authentik-auth.service.ts` ships the pure helpers (`isIpInCidr`,
  `isIpInAnyCidr`, `isTrustedProxy`, `hasValidProxySecret`,
  `parseAuthentikGroups`, `resolveAuthentikIdentity`), the JIT provisioner
  (`provisionAuthentikUser`), the synthetic session builder
  (`resolveAuthentikSession`) and the unified `resolveSession` /
  `isAuthentikProxyAuthEnabled`. CIDR matcher handles IPv4 + IPv6, plain IPs
  as exact match, and family-mismatch protection. Group parser rejects
  callers without a `<prefix>-<role>` group.
- `middleware/authentik.ts` is registered as a global Fastify `onRequest`
  hook in `app.ts` so spoofed headers are removed before any route reads
  them. It also enforces the optional shared secret at the proxy boundary.
- `mcp/auth.ts` uses the Authentik path first when enabled and denies
  unauthenticated requests (no native bearer fallback in that mode) —
  consistent with the proxy owning every request.
- `routes/auth.ts` intercepts `GET /api/auth/get-session` to return the
  synthetic Authentik session so the frontend's `useSession()` works
  without a native login round-trip.
- `queries/organization.queries.ts` exports `ensureDefaultProjectForOrg`
  so the JIT provisioner can reuse the existing logic.
- Frontend: `login.tsx` and `signup.tsx` redirect to `/` when
  `authentikProxyAuth` is on; the sign-out button in
  `profile-card.tsx` (made optional) is hidden via the account page when
  proxy auth owns the session.
- Tests: `apps/backend/tests/authentik-auth.test.ts` covers 42 cases
  (group mapping, prefix strip, highest privilege, unknown suffix, no
  prefix → reject, custom prefix, case-insensitivity, IPv4 / IPv6 /
  plain-IP / family-mismatch CIDR, trusted-proxy list parsing,
  shared-secret constant-time check, and identity resolution). DB-touching
  code is mocked with `vi.mock` so the suite runs in plain Node/Vitest
  without a real SQLite/Bun runtime.

## Verification

- `npm run -w @nao/backend lint` → 0 errors, 1 pre-existing warning in
  `trpc/organization.routes.ts` (unrelated to this change).
- `npm run -w @nao/backend test -- authentik-auth` → 42 passed, 0 failed.
- `npm run format:check` → all files match Prettier.
- The full backend suite has 20 pre-existing failures in 6 files
  (compaction / context-recommendation-schema / query-app-db) that exist
  on unmodified `main` and require a live database to pass. They are not
  caused by this change.
- No DB migrations were run. No real infrastructure touched.
