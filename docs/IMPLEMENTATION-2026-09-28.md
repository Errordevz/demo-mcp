# DEMO MCP — Authentication restoration, account system & UI overhaul (2026-09-28)

## Phase 1 — Audit findings (actual codebase, verified)

Live deployment: `https://demo-mcp.amidevz.workers.dev` — Worker, 90 MCP tools, Durable
Objects (`BROWSER_SESSIONS`, `ROBLOX_AUTH`, `MCP_AUTH`), R2, Workers AI. Baseline test
suite before changes: **48 files / 754 passed / 17 skipped / 0 failed**.

1. **Roblox OAuth regression (live).** `GET /oauth/roblox/status` rendered the error
   page *"ROBLOX_REDIRECT_URI must use the pinned MCP_PUBLIC_ORIGIN."*
   Root cause: a `ROBLOX_REDIRECT_URI` value set outside the repo (dashboard var or
   secret, preserved across deploys because CI runs `wrangler deploy --keep-vars`)
   whose **origin differs** from the pinned `MCP_PUBLIC_ORIGIN`
   (`https://demo-mcp.amidevz.workers.dev`). `resolveRobloxConfig` failed closed —
   correct instinct, wrong operational result: the derived redirect URI from the
   pinned canonical origin is authoritative and equally poisoning-proof, so a stale
   override must not hard-block the flow.
2. **MCP OAuth "not configured" (live).** `wrangler.jsonc` ships
   `MCP_AUTH_ACCESS_TEAM_DOMAIN`/`MCP_AUTH_ACCESS_AUD` placeholders; without real
   Cloudflare Access values `resolveMcpOAuthConfig` returned null → **every
   protected tool** (`roblox_account_*`, `jev_decide`) and `/oauth/authorize` were
   unavailable. Identity depended exclusively on a Cloudflare Access deployment
   the operator may not have.
3. **No DEMO account system existed** — identity was only CF Access subject → hash.
4. UI: capable but identity story was Access-only; connect hub used generic icons;
   no theme toggle (OS preference only).

## Implementation plan

- **New `DEMO_ACCOUNTS` Durable Object** (`DemoAccounts`, wrangler migration v4):
  users, per-user sessions, email-verification codes, password-reset tokens,
  rate-limit counters. Passwords: PBKDF2-HMAC-SHA256 (210k iterations, per-user salt).
  Sessions: opaque 256-bit tokens stored as SHA-256 hashes, HttpOnly Secure
  SameSite=Lax cookie, absolute expiry + server-side revocation.
- **Unified request identity** (`src/auth/request-identity.ts`): DEMO session cookie
  first, then Cloudflare Access JWT. `subjectHash` derivation is domain-separated so
  account users and Access users can never collide; existing per-principal
  `robloxAccountKey` math is unchanged.
- **MCP OAuth restored without Access**: config resolves from `MCP_PUBLIC_ORIGIN`;
  readiness requires `MCP_AUTH` binding + (Access configured **or** accounts store
  bound). `/oauth/authorize` offers inline DEMO sign-in/register when the browser is
  not authenticated; Access continues to work when configured.
- **Roblox redirect repair**: when `MCP_PUBLIC_ORIGIN` is pinned, the redirect URI is
  always derived from it; a conflicting `ROBLOX_REDIRECT_URI` override is ignored with
  a surfaced diagnostic (never silent) instead of hard-failing. Strict validation kept
  when no canonical origin is pinned.
- **Roblox linking** binds to the DEMO account session (Access still honoured);
  connect/disconnect/status available from the website Roblox dashboard.
- **UI overhaul**: full-width nav per spec, account/auth views (sign in, register,
  verify, forgot/reset, dashboard, sessions, delete), redesigned Connect MCP hub with
  five platform cards + inline SVG brand marks, light/dark/auto theme toggle.
- **Backwards compatible**: no tool removed, no route removed, no destructive
  migration, public endpoints unchanged.

## Completion log (2026-09-28, all phases executed)

**Backend**
- `src/account/passwords.ts` — PBKDF2-HMAC-SHA256 (210,000 iters, random 16-byte
  salt, format `pbkdf2$iter$saltB64$hashB64`), constant-time compare, policy
  10–128 chars + letters+digits + breached-denylist, `passwordNeedsRehash`.
- `src/account/store.ts` — `DemoAccounts` Durable Object (users, email index,
  session hashes keyed `sess:{userId}:{tokenHash}`, verification codes with
  attempt/lock counters, single-use reset tokens, rate-limit buckets, alarm sweep),
  `AccountStore` RPC wrapper, `InMemoryAccountStore` for tests.
- `src/account/config.ts` — non-secret policy (session TTL default 30d/max 90d,
  rate limit default 20/min), Resend email delivery (never throws; reports reason),
  code-shaped verification email (8-char unambiguous alphabet), single-use reset links.
- `src/account/routes.ts` — JSON API: register / login / logout / session probe /
  me (Roblox join) / verify request+confirm (resend cooldown) / password
  forgot+reset (single use, all-session revocation) + change (revoke others) /
  sessions list+revoke+revoke-others / account deletion (DELETE confirmation +
  password; best-effort Roblox unlink + grant revoke). Non-enumerating responses,
  Origin/Sec-Fetch-Site CSRF gate, 8 KB body cap, `no-store` JSON.
- `src/auth/request-identity.ts` — unified identity: `demo_session` cookie first
  (subject hash `sha256("demo-account\0"+userId)`, collision-free vs Access hashes),
  then Cloudflare Access JWT. `robloxAccountKeyForSubjectHash` math unchanged.
- MCP OAuth: config no longer hard-requires Access; readiness = `MCP_AUTH` store +
  (Access **or** `DEMO_ACCOUNTS`). `/oauth/authorize` renders an inline DEMO
  sign-in/register page when unauthenticated (same CSP/CSRF discipline as the
  consent page), issues the session and returns to the consent flow.
- Roblox redirect repair: with `MCP_PUBLIC_ORIGIN` pinned, the callback URI is
  always derived from the canonical origin; a conflicting override is ignored and a
  `staleRedirectOverride` diagnostic is exposed on `/oauth/roblox/status` (never the
  stale value).
- Roblox website connect: `POST /oauth/roblox/start` accepts a DEMO-account session
  with no one-time code (ChatGPT link-code flow untouched); the link page offers a
  direct "Connect Roblox account" button for account sessions.
- `platform-entry.ts` dispatches `/account/*`; `/platform/stats` now surfaces
  `capabilities.accounts` (presence/policy only) and lists the account connection.
- `wrangler.jsonc`: `DEMO_ACCOUNTS` binding + non-destructive migration **v4** +
  `ACCOUNT_SESSION_TTL_SECONDS` / `ACCOUNT_RATE_LIMIT_PER_MINUTE` vars.

**UI**
- Theme toggle (system/light/dark), persisted `demo_theme_v1`, pre-CSS bootstrap to
  avoid FOUC, explicit `:root[data-theme=…]` blocks; no liquid-glass styling.
- Header: straight single-row nav (Overview, Capabilities, Status, Browser, Video,
  Research, Routing, Roblox, Skills, About) + Search, theme, Sign in/Account,
  Connect MCP. Mobile menu keeps every route including Account.
- New views: `#/auth` (sign in / register with policy hints, tabs), `#/reset?token=`
  (single-use reset), `#/account` (profile, email verification with code + resend,
  password change, session management, linked-Roblox card with connect/unlink,
  danger-zone deletion with typed confirmation). All wired to the real backend —
  zero fabricated state; errors render the server's message.
- Connect MCP hub: five platform cards (ChatGPT, Claude, Cursor, Claude Code,
  VS Code) with inline SVG brand marks (official geometry, static, CSP-safe),
  honest "verified link/official screen/manual" chips, per-platform verified
  instructions retained, copy buttons, plus a generic "Other MCP Client" row.
- Fixed a pre-existing markup bug: `ic()` never closed the opening `<svg` tag, so
  every navigation icon rendered empty in real browsers.
- Roblox page reworded for the unified identity (DEMO account or Access), still no
  token exposure.

**Verification executed**
- `npx tsc --noEmit` — clean.
- `npm test` — **50 files / 782 passed / 17 skipped / 0 failed**
  (`tests/account.test.ts` 20 new, `tests/ui-app.test.ts` 5 new, 3 new redirect
  regression tests; Roblox identity test copy updated for the unified identity;
  two obsolete "no credential UI" contract assertions replaced with deliberate
  account-form guarantees).
- Live smoke vs `wrangler dev`: `/account/session`, `/account/register` (201 +
  cookie + verification decision), `/platform/stats` accounts surface — all real.
- Manual steps that no code change can perform are deferred to the operator and
  listed in the final report (deploy, stale dashboard var, `RESEND_API_KEY`).
