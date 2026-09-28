# MCP authorization audit and fix — 2026-09-20

> **Historical snapshot.** This audit describes the pre-OAuth public `/mcp` design and the former `DEMO_API_KEY` transport gate. It is superseded by [`MCP-OAUTH.md`](MCP-OAUTH.md): current `/mcp` stays public, with per-tool DEMO OAuth for protected operations.

## Status: locally fixed and verified; production deployment blocked

No production deployment succeeded in this session. No new Cloudflare deployment
version exists for this change. Do not treat the local results below as proof that
ChatGPT can already use the production endpoint.

## Rejection path established before changing application code

The configured entry point is `platform-entry.ts`. Before this change:

1. Its `fetch()` dispatched Roblox OAuth separately, checked the origin allowlist,
   then called `unauthorized(request, env)` for `/mcp`.
2. When `DEMO_API_KEY` was truthy and `Authorization` was not exactly
   `Bearer ${env.DEMO_API_KEY}`, that helper returned HTTP 401 with
   `{"error":"Unauthorized"}`. This happened **before** the MCP transport ran.
3. Even bypassing that wrapper would not work: `index.ts` repeated the same check
   with `authorized(request, env)` immediately before `createMcpHandler(...)`.

These are actual repository rejection paths, not an inference from the error
label. Regression tests reproduced HTTP 401 with a configured test key before
removing these checks. MCP uses the Agents SDK stateless handler; the bearer
checks were application guards, not an MCP session or Roblox OAuth failure.

The most recent successful GitHub deployment run visible during the audit was
[35290175061](https://github.com/Errordevz/demo-mcp/actions/runs/35290175061), at
commit `3f71d4f3866664259636e9e2c215200d06ca5ffd`. That source also contains both
checks. They predate the latest Wrangler-vars audit.

**Production evidence limit:** the actual deployed bundle and current dashboard
bindings could not be read. The documented hostname did not resolve from the
sandbox, and Cloudflare credentials were unavailable. Thus the live presence of
`DEMO_API_KEY`, any dashboard drift, and whether another upstream guard exists
remain unverified. The exact cause of the currently deployed response cannot be
certified solely from the repository.

## Changes

| Files | Change |
| --- | --- |
| `platform-entry.ts`, `index.ts` | Remove only the two transport bearer gates. Pass the optional request credential to existing private-tool handlers. Leave SDK transport/protocol validation intact. |
| `src/mcp/roblox-tools.ts`, `src/mcp/jev-tools.ts` | Preserve existing account/paid-tool protection by checking the actual caller credential, rather than merely checking that a secret is configured. Public Roblox capability resources no longer read linked-account state for anonymous callers. |
| `tests/mcp-auth.test.ts` | 27 regression checks across both entry points: initialization, tool listing, ping, missing/wrong/correct credentials, protocol validation, origin guard, health, private tools and account-resource isolation. |
| `tests/mcp-tools.test.ts`, `tests/roblox-account.test.ts`, `tests/video-ingest.test.ts` | Replace obsolete expectations that normal MCP requests return 401. Keep OAuth and authenticated account behavior covered. |
| `wrangler.jsonc`, `.env.example`, `README.md` | Clarify public transport versus private-tool credentials. Wrangler changes are comments only. |
| `scripts/audit-mcp-deployment.mjs` | Read-only CI audit of deployed code markers and binding names; never prints secret values or downloaded code. Not executed against production in this session. |
| `scripts/verify-mcp.mjs` | No-auth HTTP smoke check: initialize, initialized notification, discovery, ping, health, tools and OAuth status. **Corrected 2026-09-28:** the OAuth status route is private, so the check now asserts that it *refuses* an anonymous caller instead of expecting HTTP 200 — see the correction at the end of this document. |
| `.github/workflows/live-deploy.yml` | Add predeployment audit and mandatory no-auth smoke check; use `--keep-vars` to preserve dashboard-only variables. |
| This document | Audit evidence, verification results and deployment blocker. |

`DEMO_API_KEY` is **not deleted**: it still protects existing private account and
paid decision operations. Its obsolete use as a blanket `/mcp` requirement is
removed. No new key requirement was introduced.

## Preserved configuration and security

- All 21 committed Wrangler var values, bindings, migrations, browser/video
  settings and cron configuration are unchanged. In particular:
  `BROWSER_KEEPALIVE_MS=300000`, `BROWSER_PROVIDER=cloudflare`,
  `DEMO_PLATFORM_ORIGIN=https://demo-platform.pages.dev`,
  `OAUTH_STATE_TTL_SECONDS=600`, `ROBLOX_OAUTH_SCOPES=openid profile`.
- No secrets were read, deleted, overwritten or committed.
- `src/roblox/` is byte-for-byte unchanged from the starting commit: OAuth
  routes, PKCE/state/CSRF checks, token exchange/refresh/revocation, encryption,
  token storage, account linking/unlinking and rate limits remain intact.
- Existing private account tools still work with their existing bearer; anonymous
  calls cannot read or unlink the shared server-side account slot.
- Origin/host validation, SSRF protections, rate limits and unrelated routes are
  unchanged. No Worker-wide authentication bypass was introduced.

## Actual verification results

Against a local Cloudflare Workers runtime (`wrangler dev --local`) with
`DEMO_API_KEY` deliberately configured, and **no Authorization header or cookie**:

| Request | Result |
| --- | --- |
| `initialize` | HTTP 200; DEMO 0.8.3 beta; protocol 2025-03-26 |
| `notifications/initialized` | HTTP 202 |
| `tools/list` | HTTP 200; all 66 tools registered |
| `tools/call` → `demo_ping` | HTTP 200; `ok: true`; 66 tools |
| `/health` | HTTP 200; `ok: true` |
| `/tools` | HTTP 200; same tool list as MCP |
| `/oauth/roblox/status` | HTTP 200; route still present — **not reproducible and not a valid expectation**: the merged route requires a verified Access identity and answers an anonymous caller with HTTP 401 (see the correction below) |

No normal MCP smoke-check response was Unauthorized. A real Roblox login with
production credentials was not attempted. Existing offline OAuth tests cover
exchange, refresh, encryption, callbacks, revocation and state/CSRF safeguards.

- `npm run typecheck`: passed.
- `npm test`: **471 passed, 17 skipped**, 26 test files passed. Skipped tests are
  credential-gated live suites, not claimed as verified.
- `npm run build:check`: passed.
- Both deployment scripts pass `node --check`.

## Deployment blocker and resume procedure

- `wrangler whoami`: not authenticated.
- `CI=1 npx wrangler deploy --keep-vars`: failed for missing Cloudflare API access;
  no production change was made.
- Push to `arena/01a0be6d-demo-mcp`: rejected because the GitHub App lacks
  `workflows` permission to update `.github/workflows/live-deploy.yml`.
- Workflow dispatch: HTTP 403, `Resource not accessible by integration`.

Reconnect GitHub in Arena with workflow-update and Actions-dispatch permissions.
The existing deployment workflow can then use its configured Cloudflare secrets;
do not send credentials in chat. Resume on the same session branch:

```sh
git push origin arena/01a0be6d-demo-mcp
gh workflow run live-deploy.yml --ref arena/01a0be6d-demo-mcp -f skip_live=true
```

The new MCP smoke check runs even with `skip_live=true` (that flag skips only the
costly video suite). Review the predeployment audit and capture the deployment
URL/version and successful smoke-check step before declaring production fixed.
The repository documents `https://demo-mcp.www-notamirrblx.workers.dev/mcp`, but
that address was not reachable in this sandbox; use the URL returned by the
successful deployment for final live verification.

## Correction — 2026-09-28: the smoke check must not expect HTTP 200 from `/oauth/roblox/status`

The table above recorded `GET /oauth/roblox/status` answering an anonymous
request with HTTP 200, and `scripts/verify-mcp.mjs` was written to expect that.
In the merged repository this is wrong, and it is what broke the post-deploy
smoke test.

Re-observed against the real Worker in-process (`platform-entry.ts` `fetch`,
empty env, `Accept: application/json`, no `Authorization` header, no cookie, no
`CF-Access-Jwt-Assertion`):

| Request | Result |
| --- | --- |
| `GET /oauth/roblox/status` | **HTTP 401**, `{"error":"unauthenticated","message":"A verified human Cloudflare Access identity is required for this Roblox route.",…}` |
| `GET /health` | HTTP 200, `ok: true` |
| `GET /tools` | HTTP 200, same tool list as MCP `tools/list` |

Why 401 is the correct and intended answer:

- `src/roblox/routes.ts` calls `requireIdentity(...)` on the status route *before*
  anything else, and `verifyCloudflareAccessIdentity` (`src/auth/access-identity.ts`)
  returns `null` without a valid signed assertion.
- The assertion must be RS256, signed by the configured team's JWKS, with a
  matching issuer and audience, unexpired, and `type: "app"`. **Service tokens are
  rejected deliberately**, so no machine credential can stand in for a human.
- The route additionally calls `requireRobloxStorage(...)`: without the
  `ROBLOX_AUTH` Durable Object and `ROBLOX_TOKEN_KEY` it fails closed with 503.
  Even a verified identity gets no status from an unencrypted deployment.

What changed:

- `scripts/verify-mcp.mjs` no longer lists `/oauth/roblox/status` among the
  endpoints expected to return HTTP 200. The no-login checks are unchanged:
  `initialize`, `notifications/initialized`, `tools/list`, `demo_ping`,
  `/health`, `/tools`.
- It now asserts the *refusal*: 401 (or 403/503, or a 3xx to the Access login
  page, observed with `redirect: "manual"` and never followed). A 2xx answer to
  an anonymous caller fails the deploy with `SECURITY REGRESSION`, because that
  would mean the private route leaked.
- Unexpected responses are reported through `scripts/safe-diagnostics.mjs`:
  at most 8 KiB read from the stream and 600 characters printed, with
  `Authorization`, `CF-Access-Jwt-Assertion`, cookies, bearer tokens, JWTs,
  `ROBLOX_*` secrets, provider keys, PEM keys, e-mail addresses and signed-URL
  parameters replaced by markers, response headers taken from a fixed allowlist,
  `Set-Cookie` reported as present only, and redirect targets printed without
  their query string (OAuth `state`/`code_challenge` live there).
- An optional authenticated probe exists behind `SMOKE_CF_ACCESS_JWT` for an
  operator who supplies a real, unexpired human assertion. It is off by default,
  is not wired into `.github/workflows/live-deploy.yml`, prints only a
  `«N chars, sha256:…»` fingerprint, and changes nothing about how the endpoint
  authorizes a caller.
- Regression coverage: `tests/verify-mcp.test.ts` runs the real script against a
  production-shaped mock (401 ⇒ pass, 200 ⇒ fail, redirect ⇒ pass without
  following, hostile/huge bodies ⇒ bounded and redacted output) and asserts
  against the real Worker that the anonymous answer is 401. It also guards the
  source: the 200-expected list must stay exactly `/health` + `/tools`, and the
  script must read no Roblox or Access secret from the environment.

Invariant going forward: **no unauthenticated deploy check may expect a
successful private Roblox status response.** If a future deploy fails on this
route, the fix is in the deployment's Access configuration or storage bindings —
never in the identity check, and never by re-adding the path to the 200 list.
