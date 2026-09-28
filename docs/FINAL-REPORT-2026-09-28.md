# DEMO MCP — Final report: auth restoration, account system, Roblox fixes, UI overhaul

**Date:** 2026-09-28 · **Branch:** `arena/01a0e919-demo-mcp` · **Commit:** includes
`75beeab` (`feat: unified DEMO identity, account system, Roblox redirect repair, UI overhaul`)
· **Test evidence:** `npm test` → **50 files / 782 passed / 17 skipped / 0 failed**,
`npx tsc --noEmit` clean, `wrangler deploy --dry-run` OK (all bindings incl. `DemoAccounts`+`AI`).

---

## 1. What was broken (verified root causes)

| # | Symptom | Root cause (evidence) |
|---|---|---|
| 1 | Live Roblox OAuth returned an error page: *"ROBLOX_REDIRECT_URI must use the pinned MCP_PUBLIC_ORIGIN"* (503 `host_not_allowed`) | A `ROBLOX_REDIRECT_URI` override exists in the dashboard (outside the repo; preserved across deploys by CI's `--keep-vars`) whose origin differs from `MCP_PUBLIC_ORIGIN`. The canonical derivation (pinned origin + `/oauth/roblox/callback`) is authoritative and equally poisoning-proof, so the whole flow must not hard-block. |
| 2 | Live MCP OAuth reported `configured: false` — every protected tool (`roblox_account_*`, `jev_decide`) returned a 503 setup error | `wrangler.jsonc` ships placeholder Cloudflare Access values (`<your-team>.cloudflareaccess.com` etc.); config resolution required Access, so **no identity provider existed at all**. |
| 3 | No DEMO account system | Identity was *only* a Cloudflare Access subject hash; there was no registration/sign-in story. |
| 4 | UI nav density was arbitrary (dashboard-only primary row), no theme toggle, Connect hub iconography was generic | Design/IA limitation. |
| 5 | (Found during work) Nav icons invisible in real browsers | `ic()` in `src/ui/app-script.ts` never emitted the closing `>` of the opening `<svg` tag — pure markup bug. |

## 2. What was built (all shipped to the branch)

### 2.1 DEMO account system (new `DEMO_ACCOUNTS` Durable Object, wrangler migration **v4**, non-destructive)
- `src/account/passwords.ts` — PBKDF2-HMAC-SHA256, 210,000 iterations, per-user 16-byte salt, constant-time verify, policy 10–128 chars + letters/digits + breached-denylist, rehash detection.
- `src/account/store.ts` — `DemoAccounts` DO: users + email index, session records keyed by SHA-256 token hash (`sess:{userId}:{hash}`), verification codes (8-char, unambiguous alphabet, hash-only, attempt counter + lockout, 30-min TTL, 60 s resend cooldown), single-use reset tokens, rate-limit buckets, alarm sweeps. RPC wrapper `AccountStore` + `InMemoryAccountStore` for tests.
- `src/account/config.ts` — non-secret policy (30-day absolute session, 20/min), optional Resend delivery (`EMAIL_PROVIDER`/`EMAIL_FROM` vars + `RESEND_API_KEY` secret). Email send **never throws**; failure reasons are reported, and verification codes remain operator-recoverable via the DO record.
- `src/account/routes.ts` (`/account/*` JSON API, `no-store`, 8 KB cap, Origin/Sec-Fetch-Site CSRF gate):
  - `POST /account/register` — 201 + session cookie + verification decision; duplicate email → generic 200 (non-enumerating).
  - `POST /account/login` — per-email (8/5 min) and per-IP charges, equal-cost hash against unknown accounts, rehash-on-login.
  - `GET /account/session` | `GET /account/me` (joins Roblox status, never tokens) | `POST /account/logout`.
  - Verification: `POST /account/verify/request` (cooldown) + `/confirm` (locked outcomes; re-issue on success).
  - Password: `/forgot` (uniform 200) · `/reset` (single-use token + all-session revocation) · `/change` (current-password proof, revokes other sessions).
  - Sessions: `GET /account/sessions` (prefix ids, `current` flag) · `POST …/revoke` · `…/revoke-others`.
  - `POST /account/delete` — typed `DELETE` + password; revokes the Roblox grant + deletes the encrypted link best-effort, deletes every session + the user; MCP client tokens keep working until natural expiry (documented in the response); the email can be re-registered.

### 2.2 Unified request identity (backward compatible)
- `src/auth/request-identity.ts` — `demo_session` cookie first, Cloudflare Access JWT second.
  Subject hash for account users: `sha256("demo-account\0" + userId)` (domain-separated — cannot collide with Access hashes). `robloxAccountKeyForSubjectHash` and principal-hash binding were **not** changed; existing Access tests pass unmodified.
- `resolveMcpOAuthConfig` / `mcpOAuthReady` (`src/auth/oauth-config.ts`): readiness = `MCP_AUTH` store + (Access configured **or** `DEMO_ACCOUNTS` bound). Access deployments keep behaving exactly as before.
- `src/auth/oauth-routes.ts`: `GET /oauth/authorize` no longer 401s when unauthenticated — it renders a standalone CSP-locked DEMO **sign-in/register page**; `POST` issues the session cookie (Secure, HttpOnly, SameSite=Lax) and 302s back to the consent flow. Wrong credentials re-render with a generic, non-enumerating error.

### 2.3 Roblox OAuth repair + website connect
- `src/roblox/config.ts`: with `MCP_PUBLIC_ORIGIN` pinned, the redirect URI is **always derived**; a conflicting override is ignored and `config.staleRedirectOverride` is set (surfaced by `/oauth/roblox/status`; the stale value is never echoed). Strict host/path validation is unchanged when no canonical origin is pinned; HTTPS/allowlist rules unchanged everywhere.
- `src/roblox/routes.ts` (`src/roblox/routes.ts` + types): `requireIdentity` now resolves the unified identity. `POST /oauth/roblox/start` supports **two** identity-bound start modes: (a) one-time `link_code` (ChatGPT handoff — unchanged), (b) a same-site form POST carrying a DEMO-account session cookie (website-direct connect). `/oauth/roblox/link` renders a direct "Connect Roblox account" button for account sessions plus an optional code box. Tokens remain AES-encrypted in the `ROBLOX_AUTH` vault; they are never sent to the frontend, logged, or rendered.

### 2.4 UI overhaul (`ui.ts`, `src/ui/*`)
- Full primary nav row: **Overview, Capabilities, Status, Browser, Video, Research, Routing, Roblox, Skills, About** + Search (Ctrl+K) + theme toggle + Sign-in/Account + Connect MCP. Hamburger menu retains all seven "secondary" destinations for small viewports — nothing was removed.
- Theme: system/light/dark cycle, persisted (`demo_theme_v1`), applied before CSS (no FOUC), explicit `:root[data-theme]` palettes; no liquid-glass styling anywhere.
- New routes: `#/auth` (Sign in / Register tabs + forgot), `#/reset?token=…` (single-use reset link target), `#/account` (dashboard: profile, email verification with resend, password change, session management incl. revoke/revoke-others, linked-Roblox card with connect/unlink, danger-zone account deletion with typed confirmation). Every button/form hits the real backend; every error renders the server message; nothing is fabricated.
- Connect MCP hub: five platform cards (**ChatGPT, Claude, Cursor, Claude Code, VS Code**) with inline SVG brand marks constructed from official logo geometry (static, no scripts, CSP-safe, currentColor/themed), honest chips ("Verified link" / "Official page" / "Manual command"), the previously-researched per-platform step lists kept, copy buttons, and a generic "Other MCP Client" fall-back. No invented deep links; all existing `mcp-clients.ts` contract tests (URL shapes, sources-required) still pass.
- Fixed the `ic()` `<svg` closing-tag bug (nav icons actually render now).
- Roblox page copy updated for unified identity (DEMO account session *or* Access), token-free as before.
- `platform-entry.ts`: dispatches `/account/*`, exports `DemoAccounts`, and `/platform/stats` now surfaces `capabilities.accounts` (presence + policy booleans only) and adds a "DEMO accounts" connection row — no secret material anywhere.

## 3. What was deliberately preserved
- All **90 MCP tools**, every public endpoint, the `/mcp` transport contract, and tool-filtered catalogs (the tool-catalog snapshot test pins them).
- Cloudflare Access deployment behavior (identity, JWKS verification, subject hashing, `robloxPrincipal` math).
- The existing worker name/origin, bindings (only **added** `DEMO_ACCOUNTS` + migration v4), R2, crons, CORS allowlist.
- Existing user data: the migration is additive (`new_sqlite_classes`), no deletions or rewrites.

## 4. Tests — exactly what ran
- `npx tsc --noEmit` → clean.
- `npm test` → **50 test files / 782 passed / 17 skipped / 0 failed** (baseline before work: 48 files / 754 passed / 17 skipped).
  - New: `tests/account.test.ts` (**20** tests: password hashing/policy, store lifecycle + consume-once semantics, full API flows, rate limiting, CSRF, OAuth sign-in bridge, identity domain separation).
  - New: `tests/ui-app.test.ts` (**5** jsdom tests: primary nav completeness, theme cycling+persistence, auth view tabs + password rules, dashboard panels + session list, Connect hub 5 cards + SVG logos + platform detail).
  - New: 3 redirect-URI regression tests in `tests/roblox-oauth.test.ts` (stale-override ignored + diagnostic, same-origin custom path honoured, unpinned behavior preserved).
  - Adjusted (documented): 1 Roblox identity copy assertion; 2 obsolete "no credential UI" assertions replaced by the deliberate account-form security contract (hardened `autocomplete`, no token material).
- `wrangler deploy --dry-run --outdir /tmp/dry` → bundles; bindings list includes `env.DEMO_ACCOUNTS (DemoAccounts)` and `env.AI`.
- Live smoke against `wrangler dev` (real DOs locally): `/account/session` probe, `/account/register` (201 + `demo_session` cookie + verification decision), `/platform/stats` → `capabilities.accounts = {available: true, …}`. Screenshot: the running dev server is attached as the session's live preview (port 8787).

## 5. Not done here — operator actions required (no code substitute exists)
1. **Deploy:** `wrangler deploy` (CI or locally). This applies migration **v4** and creates the `DemoAccounts` storage — account features 503 until then, everything else works unchanged.
2. **Delete the stale `ROBLOX_REDIRECT_URI`** (dashboard → Worker → Variables) *or* set it to `https://demo-mcp.amidevz.workers.dev/oauth/roblox/callback`. The code now recovers even while it's wrong; the status route reports the stale override so you can confirm cleanup. Register the same canonical callback in the Roblox app at create.roblox.com.
3. **Set `RESEND_API_KEY`** (`wrangler secret put RESEND_API_KEY`) + point `EMAIL_FROM` at a verified Resend domain for verification/reset emails. Without it accounts work, but codes must be served by an operator (the API honestly reports the reason).
4. Optional: replace the placeholder Access team/AUD values with real Cloudflare Access config *if* Access is wanted as a second identity option; accounts already fill the gap.
5. Once deployed, exercise one live ChatGPT Mixed-Authentication connect end-to-end (OpenAI's docs permit the scope behavior change) and approve once via `roblox_account_link_start` (Access) or the website-direct flow (accounts).
6. **GitHub auth in this workspace is expired** (`gh auth status` → invalid token; `git push` rejected). The commit is pushed-ready on `arena/01a0e919-demo-mcp`; **reconnect GitHub in Arena**, then push the branch and open the PR (`gh pr create --base main --head arena/01a0e919-demo-mcp`).

## 6. Files changed
- New: `src/account/{passwords,store,config,routes}.ts`, `src/auth/request-identity.ts`, `tests/account.test.ts`, `tests/ui-app.test.ts`, `docs/IMPLEMENTATION-2026-09-28.md`, this report. Dev ergonomics: gitignored `wrangler.local.jsonc` (local dev without remote AI).
- Modified: `wrangler.jsonc` (+binding, +migration v4, +2 vars), `platform-entry.ts` (dispatch + telemetry + DO export), `src/auth/{oauth-config,oauth-routes}.ts`, `src/roblox/{config,routes,types}.ts`, `src/ui/{styles,content,app-script,mcp-clients… }` and `ui.ts`, contract tests (`ui-shell`, `mcp-tools`, `roblox-oauth`, `roblox-routes`, `wrangler-config`).
- **No tools, routes, bindings, secrets or user data were removed.** Total: 26 files, +3,305/−70 lines.
