# Roblox account sign-in for DEMO (OAuth 2.0 + PKCE)

DEMO can hold a **Roblox account authorization** so its MCP tools can answer questions
about *your* account — profile, verified identity, optional inventory — using only
Roblox's official OAuth 2.0 / Open Cloud surface.

Everything below can be done from an iPhone in Safari. No PC, no terminal, no
local dev server, no `ngrok`.

---

## 1. What this is, and what it refuses to be

| | |
| --- | --- |
| Grant | `authorization_code` with **PKCE `S256`** (Roblox supports and recommends PKCE for confidential clients) |
| Endpoints | `https://apis.roblox.com/oauth/v1/{authorize,token,token/revoke,token/introspect,token/resources,userinfo}` and `https://apis.roblox.com/cloud/v2/...` — pinned in `src/roblox/config.ts`, not configurable, so a bad env var can never send your client secret somewhere else |
| Password / `.ROBLOSECURITY` | **Never requested, never accepted, never stored.** There is no code path for it; Roblox's login page is only ever loaded by *you* at `apis.roblox.com` |
| Where tokens live | On the Worker only: encrypted at rest in a Durable Object. Never in `localStorage`, `sessionStorage`, a readable cookie, a URL, HTML, an MCP result, or a log line |
| What the browser gets | One opaque `HttpOnly; Secure; SameSite=Lax` session id, scoped to `Path=/oauth/roblox` |
| CSRF | Random 256-bit `state`, stored only as its SHA-256, single-use with a replay tombstone, expiring (`OAUTH_STATE_TTL_SECONDS`), and bound to the browser by a second `HttpOnly` cookie |
| Revocation | `POST /oauth/v1/token/revoke` with the refresh token on logout (best effort — local state is always cleared) |
| Rate limits | Per-client limiter on all four OAuth routes, plus a self-imposed Open Cloud budget kept *below* Roblox's published per-authorization limits |
| CAPTCHA / bot protection / rate limits | Never bypassed. `prompt` only accepts Roblox's documented values |
| Unofficial access | Not implemented. Where Roblox has no OAuth/Open Cloud endpoint, the tools return `not_supported` with the reason (see [§8](#8-what-roblox-does-not-allow)) |

OAuth 2.0 for Open Cloud is a **Roblox beta**; endpoints and scopes can change. Run
`roblox_account_capabilities` (or read `demo://capabilities/roblox`) to see what this
deployment can actually do right now.

---

## 2. Register the app on Roblox (browser only)

1. Open <https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab> (long-press →
   *Request Desktop Website* on Safari makes the dashboard easier to use).
   Registering an OAuth app requires an **ID-verified** account.
2. **Create App** → name it (globally unique), accept the ToS.
3. Copy the **Client ID**, then open the secret once and copy it — Roblox shows the
   secret only at creation time.
4. **App Category**: choose **Account Linking Tools** (that is what this is: your Roblox
   account mapped onto a DEMO session). Scopes available to you depend on the category.
5. **Permissions / Scopes**: tick `openid` and `profile`. Add the optional ones from
   [§3](#3-scopes-and-why) only if you want those tools.
6. **Redirect URLs**: add the exact URL of *this* deployment's callback. The reliable way
   to get it: open `https://<your-worker-url>/oauth/roblox/status` once after deploying and
   copy `configuration.redirectUri`. For a `workers.dev` Worker it looks like:

   ```text
   https://demo-mcp.<your-subdomain>.workers.dev/oauth/roblox/callback
   ```

   Rules Roblox enforces: plain HTTPS (localhost HTTP is allowed for local testing), max
   256 characters, up to 10 URLs, and it must match **exactly** — no trailing slash, no
   extra path segments.
7. Keep the app in **private mode** for personal use: it allows up to 10 unique users,
   which is enough for your own account and needs no review. Public distribution
   requires Roblox's review process (demo video + scope justification).

> **Changing scopes later** means you must re-consent: re-run the flow in
> [§6](#6-connect-your-account-from-iphone--safari). Changing the redirect URL does not.

---

## 3. Scopes and why

DEMO requests the smallest set that satisfies "which account is this?". These scopes are
for the **authenticated** `roblox_account_*` tools; the pre-existing `roblox_user` and
`roblox_game` tools stay unauthenticated public lookups and need no scopes. Configure it with
`ROBLOX_OAUTH_SCOPES` (space- or comma-separated). It must include `openid`.

| Scope | Needed for | Effect if omitted |
| --- | --- | --- |
| `openid` | Required. Gives the `sub` claim (your Roblox user id) from `GET /oauth/v1/userinfo`, which is how DEMO knows which account it is talking about | No account identity; `roblox_account_status` cannot report a user id |
| `profile` | Display name, username, profile URL, account creation date, headshot | Only `sub` is returned |
| `user.advanced:read` **or** `user.social:read` | `roblox_account_profile` with `extended: true` → Open Cloud `GET /cloud/v2/users/{id}` (e.g. the About text) | `extendedError` on the profile tool with `insufficient_scope` |
| `user.inventory-item:read` | `roblox_account_inventory` → `GET /cloud/v2/users/{id}/inventory-items` (BETA) | The inventory tool returns `insufficient_scope` and the fix |
| `email`, `verification`, `credentials`, `age`, `premium`, `roles` | Not used by DEMO | Nothing — do not tick them |

`asset:write` and every other write scope are deliberately never requested: DEMO does not
modify your Roblox account or publish anything.

### Feature → scope → configured → implemented

The same facts are machine-readable in `roblox_account_capabilities` /
`demo://capabilities/roblox`; this table is the human version for review. "Configured" means
present in the default `ROBLOX_OAUTH_SCOPES` value (`openid profile`).

| Feature | Required Roblox scope | Configured by default? | Implemented in DEMO? |
| --- | --- | --- | --- |
| Identify the connected account (user id) — `roblox_account_status` | `openid` | ✅ yes | ✅ yes |
| Profile basics: `@username`, display name, profile URL, headshot, creation date — `roblox_account_profile` | `profile` | ✅ yes | ✅ yes |
| Extended profile (About text and other Open Cloud user fields) — `roblox_account_profile { extended: true }` | `user.advanced:read` **or** `user.social:read` | ❌ no | ✅ code ready; reports `insufficient_scope` until the scope is ticked on the app **and** granted at consent |
| Inventory items / ownership verdicts — `roblox_account_inventory` | `user.inventory-item:read` (BETA) | ❌ no | ✅ code ready; needs the tick, and still respects the owner's privacy setting (private inventory → empty/forbidden, never scraped) |
| Own avatar thumbnail — `roblox_account_avatar_thumbnail` | `openid` (Open Cloud thumbnail operation) | ✅ yes | ✅ yes |
| Check / revoke the authorization — `roblox_account_unlink`, `POST /oauth/roblox/logout` | none (documented introspection + revocation endpoints) | n/a | ✅ yes (best-effort revoke, local state cleared even if Roblox is unreachable) |
| List *my* experiences / created universes | — no OAuth scope exists for it | ❌ impossible | ❌ `not_supported`, by design — no scraping fallback |
| Robux balance, earnings, payouts, trade history | — not exposed to third-party OAuth apps | ❌ impossible | ❌ `not_supported` |
| Friends, followers, messages, groups (read or write), avatar *changes*, any account write | — none available (or deliberately not requested) | ❌ impossible | ❌ `not_supported`; `asset:write`-class scopes are never requested |
| Public lookups: another user's public page, game info (`roblox_user`, `roblox_game`) | none — unauthenticated public Open Cloud | n/a | ✅ pre-existing, unchanged by this feature |

If a row says "❌ no" in *Configured* and "✅ code ready" in *Implemented*, the work is a
dashboard tick plus `ROBLOX_OAUTH_SCOPES`, then reconnect — never a workaround. If a row says
"impossible", no configuration makes it work and Demo will keep saying so.

---

## 4. Cloudflare configuration

### Secrets (always secrets, never plain variables)

Cloudflare dashboard → **Workers & Pages → `demo-mcp` → Settings → Variables and
secrets → *Encrypt*** → Add. (CLI equivalent: `wrangler secret put <NAME>`.)

| Name | Value |
| --- | --- |
| `ROBLOX_CLIENT_ID` | The client id from §2. (If you already set it as a plain variable that is workable — it is not a secret — but a secret is tidier.) |
| `ROBLOX_CLIENT_SECRET` | The secret from §2. Never leaves the Worker; only ever sent in a POST body to `apis.roblox.com` |
| `ROBLOX_TOKEN_KEY` | 32 random bytes in base64. Encrypts tokens at rest. Generate anywhere that gives you 32+ random characters; with a terminal: `openssl rand -base64 32`. If you have no terminal, use your password manager's generator at 48 characters — anything under 24 is rejected outright |

`ROBLOX_TOKEN_KEY` is what turns durable storage on. Without it DEMO keeps a session in
Worker memory only, says so on every status surface, and **refuses to write unencrypted
tokens to durable storage** rather than doing it quietly. Rotating the key invalidates
existing sessions on purpose (they then ask you to reconnect).

### Variables

Already shipped in `wrangler.jsonc`; override only if you want different policy:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROBLOX_OAUTH_SCOPES` | `openid profile` | Scope list requested at consent |
| `OAUTH_STATE_TTL_SECONDS` | `600` | Window between `/start` and `/callback` (60–900) |
| `ROBLOX_SESSION_TTL_SECONDS` | `1209600` | Browser session lifetime (14 days) |
| `ROBLOX_RATE_LIMIT_PER_MINUTE` | `20` | Per client, per OAuth route |
| `ROBLOX_OPEN_CLOUD_RATE_PER_MINUTE` | `10` | Self-imposed budget for Open Cloud calls (1–20) |
| `ROBLOX_ALLOWED_HOSTS` | *(unset)* | Comma-separated hostnames allowed to mint/complete a flow. Set this to your Worker hostname once you have one, so a poisoned `Host` header can't redirect a code elsewhere |
| `ROBLOX_REDIRECT_URI` | *(unset → derived)* | Pin it if the Worker sits behind a custom domain or a proxy that rewrites the origin |
| `ROBLOX_ACCOUNT_KEY` | `default` | Account slot name this deployment links into |

### Bindings

The only new binding is a **Durable Object** (no KV, no D1, no R2 change):

| Binding | Type | Class |
| --- | --- | --- |
| `ROBLOX_AUTH` | Durable Object | `RobloxAuth` |

`wrangler.jsonc` already declares it, including the migration, so `wrangler deploy`
applies it:

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "BROWSER_SESSIONS", "class_name": "BrowserSession" },
    { "name": "ROBLOX_AUTH", "class_name": "RobloxAuth" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["BrowserSession"] },
  { "tag": "v2", "new_sqlite_classes": ["RobloxAuth"] }
]
```

A Durable Object rather than KV because `/start` and `/callback` are seconds apart on
different isolates (KV is eventually consistent, which would make the state lookup
intermittently fail) and because Roblox refresh tokens are **single-use**, so two isolates
racing to refresh one would destroy the session. The DO also holds the rate counters and a
single-flight refresh lease, and runs the expiry sweep from an alarm.

If you deploy from the dashboard UI instead of wrangler, add it manually:
Worker → **Settings → Bindings → Add → Durable Object Binding**, variable name
`ROBLOX_AUTH`, class `RobloxAuth` (create the class if prompted).

---

## 5. Deploy

From a terminal (any machine, or GitHub Codespaces in the browser):

```bash
npm ci
npm run typecheck     # tsc --noEmit
npm test              # offline suite, includes the Cloudflare build check
npm run build:check   # wrangler deploy --dry-run, proves the bundle is CF-compatible
npm run deploy        # applies the v2 Durable Object migration
```

No PC at all? Use the repository's GitHub Actions workflow
**“Deploy + live video tests”** (Actions tab → *Run workflow* → set `skip_live` to
`true`). It installs, typechecks, gates on the offline suite, deploys with `wrangler
deploy` (so `wrangler.jsonc` bindings and the DO migration apply), and needs no terminal. `npx wrangler
deploy` from the Cloudflare dashboard's *Code* editor also works — just re-check the
`ROBLOX_AUTH` binding afterwards, because dashboard edits do not read `wrangler.jsonc`.

Verify the wiring without any Roblox involvement:

```text
GET https://<worker>/health   →  "robloxOAuthConfigured": true,
                                 "robloxTokenStorage": "durable-object",
                                 "robloxTokenEncryption": "aes-gcm-256"
```

`memory` / `none` there means the DO binding or `ROBLOX_TOKEN_KEY` is missing.

---

## 6. Connect your account (iPhone / Safari)

1. Open the DEMO page (`https://<worker-url>/`) and tap **Connect Roblox account** — the
   Roblox card shows `Not connected`, `Connected as @username`, or the exact fix if the app
   is not configured — or open `https://<worker-url>/oauth/roblox/start` directly (that is
   the direct test link: it 302s to `https://apis.roblox.com/oauth/v1/authorize`). The same
   link is handed to a connected AI by `roblox_account_status` → `connectByOpening`, and the
   MCP server instructions tell it to offer "Connect Roblox" rather than improvise.
2. Safari navigates to Roblox's own consent page at `apis.roblox.com`. Sign in there if
   asked. Roblox requires a **13+** account to authorize third-party apps.
3. Approve the scopes. Roblox redirects back to `/oauth/roblox/callback`.
4. You land on a **“Roblox connected”** page. Nothing else is stored in your browser but
   the `HttpOnly` session id.
5. Check it at `https://<worker-url>/oauth/roblox/status` — it shows the user id, display
   name, granted scopes and expiry, and no credential material.

Rules that make step 3 work on iOS:

* Start and finish in the **same browser and tab**. The state is bound to a cookie the
  flow set at `/start`; copying the Roblox link to another device or browser will be
  refused with `state_binding_mismatch`.
* **Private Browsing** blocks the state cookie → `state_missing`. Use a normal tab.
* Do not use the **Back button** to re-view the callback: codes and states are single-use,
  so a repeat is refused as `state_replayed` by design.
* `SameSite=Lax` is what lets the redirect back from `roblox.com` carry the cookie while
  still blocking cross-site reads. Safari's ITP treats that top-level navigation as
  first-party. If `Settings → Safari → Block All Cookies` is on, the flow cannot work.

To disconnect: `POST /oauth/roblox/logout` (the DEMO page has a button) or the
`roblox_account_unlink` tool.

---

## 7. Testing the three routes

Tap-or-paste in Safari, or use `curl` if you have a shell. `<W>` = `https://<worker-url>`.

| Request | Expected |
| --- | --- |
| `GET <W>/oauth/roblox/status` (fresh browser) | `200` `{"connected":false,"configuration":{"enabled":true,"redirectUri":"<W>/oauth/roblox/callback",...}}` |
| `GET <W>/oauth/roblox/start` (browser) | `302` to `https://apis.roblox.com/oauth/v1/authorize?...`, `Set-Cookie: roblox_oauth_state=…; HttpOnly; Secure; SameSite=Lax; Path=/oauth/roblox; Max-Age=600` |
| `curl -H 'Accept: application/json' <W>/oauth/roblox/start?format=json` | `200` with `authorizeUrl` — check it contains `code_challenge_method=S256`, your scopes, and **no** `client_secret` |
| `GET <W>/oauth/roblox/callback?code=deadbeefdeadbeef&state=<43 chars>` (no flow started) | `400 {"error":"state_mismatch"}` and **no** call to Roblox's token endpoint |
| `GET <W>/oauth/roblox/callback?error=access_denied&error_description=x` | `400 {"error":"provider_denied"}` — a denial is reported, never retried |
| Re-open the same successful callback URL (Back button / refresh) | `400 {"error":"state_replayed"}` |
| `POST <W>/oauth/roblox/logout` with the session cookie, same-origin | `200 {"disconnected":true,"revokedAtRoblox":true}` + `Max-Age=0` cookies |
| `GET <W>/oauth/roblox/logout` | `400 {"error":"invalid_input"}` (POST only) |
| `POST` with `Origin: https://evil.test` or `Sec-Fetch-Site: cross-site` | `403 {"error":"origin_mismatch"}` |
| 21st `GET <W>/oauth/roblox/start` inside a minute (default limit 20) | `429` with `Retry-After` |

Two provider details that trip people up, both handled in code: an authorization code is
single-use and expires in about a minute, so a slow or repeated callback legitimately fails
with `state_replayed` / `invalid_grant` — start again rather than going Back; and Roblox
answers some rejections with its web-API envelope `{"errors":[{"code":…,"message":…}]}`
instead of OAuth's `{"error":"invalid_request"}`, which DEMO parses too (sanitizing the
message, so an echoed code or verifier can never be repeated back to you).

The automated suite (`npm test`) already asserts the security-critical ones: state
mismatch, expiry, replay, browser-binding mismatch, missing credentials, failed/refused
token exchange (400/429/5xx/network), unauthenticated access, token expiry with rotation,
revocation, scope gating, the rate limit, cookie flags, and that no token or secret
appears in a response body, the served HTML, or a console line.

For a real round-trip against Roblox, run `npm run build:check` and walk §6 once on your
phone — the consent screen itself is the only step that cannot be scripted.

---

## 8. What Roblox does not allow

`roblox_account_capabilities` (and `demo://capabilities/roblox`) return this matrix at
runtime. It is here so nobody "cleverly" works around it later:

| Action | Verdict |
| --- | --- |
| Identify the account, read profile basics | ✅ `openid` (+ `profile`) |
| Extended account info (About, verification-dependent fields) | ✅ with `user.advanced:read` / `user.social:read` |
| List inventory / verify item ownership | ✅ with `user.inventory-item:read` (BETA, 20 req/min, and gated on your Roblox privacy setting) |
| Generate your avatar thumbnail | ✅ Open Cloud long-running operation |
| **List the experiences/games you own or have played** | ❌ No OAuth scope or Open Cloud endpoint exists for it (an open Developer Forum request). Roblox's games/universes APIs are creator-scoped with an API key, not "my games" |
| Robux balance, earnings, payouts, transaction history | ❌ Not exposed to third-party OAuth apps |
| Friends, followers, private messages, chat | ❌ Cookie-authenticated website APIs |
| Avatar/outfit editing, wearing items | ❌ Cookie-authenticated |
| Trading, resale and price data | ❌ Not OAuth-enabled |
| Anything that *acts as* your account (join a server, buy, publish, vote) | ❌ Not permitted, and never attempted |

When a scope is missing you get `insufficient_scope` plus the exact dashboard steps; when
Roblox has no endpoint at all you get `not_supported`. Both are honest stops — DEMO will
not scrape `roblox.com`, solve a CAPTCHA, or use a `.ROBLOSECURITY` cookie to fill the gap,
and there is no code path in which it could.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Roblox shows *invalid redirect_uri* / the consent page refuses to load | The registered URL is not byte-identical to the one DEMO sends (scheme, host, trailing `/`, `preview.` vs production) | Copy `configuration.redirectUri` from `/oauth/roblox/status` and paste that exact string into the app's Redirect URLs |
| `503 not_configured` | `ROBLOX_CLIENT_ID` / `ROBLOX_CLIENT_SECRET` missing **in the environment you are hitting** | Secrets are per-environment: set them for Production *and* Preview. `/health` shows `robloxOAuthConfigured` |
| `400 invalid_grant` right after approving | The code was already used or aged out (~1 min). Usually the Back button, a refresh, or a slow redirect | Start again at `/oauth/roblox/start`; keep the tab in the foreground until it lands |
| `state_mismatch` on a fresh attempt | Flow started on another deployment/isolate (e.g. Preview vs Production), or the DO binding is missing so the state never reached the callback's isolate | Same origin for both requests; deploy the `ROBLOX_AUTH` binding |
| `state_binding_mismatch` | Opened the Roblox link in a different browser/device, or copied it | Do the whole flow in one tab |
| `state_missing`, "no OAuth state cookie" | Private Browsing, `Block All Cookies`, or the callback opened in a new webview (e.g. from an in-app browser in Slack/Telegram) | Normal Safari tab, cookies allowed |
| `state_expired` | Consent took longer than `OAUTH_STATE_TTL_SECONDS` (max 900) | Retry promptly, or raise the variable |
| `403 host_not_allowed` | The request host is outside `ROBLOX_ALLOWED_HOSTS` | Add your hostname, or unset the variable to accept any |
| `403 origin_mismatch` on logout | Cross-site request (or `Sec-Fetch-Site: cross-site`) | Use the DEMO page on the Worker's own origin |
| `429` from an OAuth route | Your own per-client limit | Wait `Retry-After`; raise `ROBLOX_RATE_LIMIT_PER_MINUTE` only if you run the Worker yourself |
| `429` from Open Cloud calls | Roblox's per-authorization limit | DEMO already self-limits to `ROBLOX_OPEN_CLOUD_RATE_PER_MINUTE`; lower it if you script calls in parallel |
| `insufficient_scope` | The scope is not ticked on the app, or you changed scopes without re-consenting | Tick it on the Roblox app, then reconnect |
| `roblox_account_*` returns data while the *public* lookups look different | `roblox_user` / `roblox_game` are unauthenticated public lookups of *any* user; `roblox_account_*` only ever sees the linked account | Expected — the account tools never accept a target user id |
| `reauthorization_required` | 90-day refresh expiry, revocation, or a rotated `ROBLOX_TOKEN_KEY` | Reconnect from `/oauth/roblox/start` |
| Session keeps dropping | Running in `memory` mode (`/health` shows `robloxTokenStorage: "memory"`) | Add the `ROBLOX_AUTH` binding **and** `ROBLOX_TOKEN_KEY` |
| `roblox_account_status` says the endpoint is open | `DEMO_API_KEY` is unset, so `/mcp` is anonymous — account tools refuse to run | `wrangler secret put DEMO_API_KEY`, then send `Authorization: Bearer …` in your MCP client config |
| MCP client cannot read the account tools at all | It is connecting to a different URL/host than the one you authorized | Point the MCP client at the Worker whose `/oauth/roblox/status` shows `connected: true` |
| Roblox refuses the consent screen | Account under 13+, or app not ID-verified | Roblox policy; nothing in DEMO can change it |
| Everything configured, still `not_configured` | You edited the *Workers Preview* environment | Production secrets live under the Worker's Settings, not the editor |

Two things worth knowing before you report a bug:

* Tokens live 15 minutes and refresh tokens 90 days, **consumed on use**. If a refresh
  response is lost in transit, the stored pair can become unusable — that surfaces as
  `reauthorization_required`, and reconnecting is the correct fix.
* `POST /oauth/v1/token/introspect` reports an access token as active until its 15-minute
  lifetime ends even after revocation. DEMO therefore treats `active: false` as final and a
  live `true` as advisory, and relies on the token being rejected by the API itself.

---

## 10. Reviewer checklist

* `src/roblox/oauth.ts` — URL construction. Assert no `client_secret` in any query string.
* `src/roblox/crypto.ts` — PKCE (RFC 7636 `S256`), AES-256-GCM at-rest cipher, HKDF
  stretching, constant-time comparison, `crypto.getRandomValues` only.
* `src/roblox/store.ts` — hashed, single-use, expiring, browser-bound state; vault refuses
  to write credentials in the clear to durable storage.
* `src/roblox/client.ts` — the only place a bearer token exists; refresh + rotation +
  lease; 401 → one forced refresh + one retry; 429/5xx → one bounded retry; scope gate
  before any call; `user_id` always from the stored record, never from a caller.
* `src/roblox/routes.ts` — no-store/no-referrer/nosniff/CSP on every response, escaped
  HTML, `Origin`/`Sec-Fetch-Site` checks, per-route rate limiting.
* `src/mcp/roblox-tools.ts` — field-built payloads through the redaction layer, account
  tools gated behind `DEMO_API_KEY`, `not_supported` instead of workarounds.
* `tests/roblox-oauth.test.ts` (54 cases, the last four being the user-visible
  "Connect Roblox" acceptance checklist) and `tests/roblox-account.test.ts`
  (35 cases) — 89 tests for the above, including a console-capture test that no
  token ever reaches a log.
* The UI itself (`tests/mcp-tools.test.ts`) — the served page must keep the
  **Connect Roblox account** button pointed at `/oauth/roblox/start`, keep a
  Disconnect path, and contain no form, password field or token in its markup.
