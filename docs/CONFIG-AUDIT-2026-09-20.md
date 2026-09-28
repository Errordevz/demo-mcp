# Wrangler configuration audit — 2026-09-20

> **Historical snapshot.** This records an earlier deployment configuration. Use the current [MCP OAuth](MCP-OAUTH.md), [Roblox setup](ROBLOX.md), and [`wrangler.jsonc`](../wrangler.jsonc) as authoritative; obsolete session/account-slot settings are not part of the current design.

Scope: synchronize `wrangler.jsonc` with the intended DEMO MCP runtime
configuration (21 `vars` values), without duplicating keys, converting
secrets into plaintext vars, or disturbing bindings/migrations.

**Outcome: no configuration changes were required.** The committed
`wrangler.jsonc` already declares all 21 requested variables, each exactly
once, each with exactly the requested value. This document records what was
checked so the audit is reviewable.

## Requested vars — verified present, exact value, exactly once

| Variable | Value | Declared |
| --- | --- | --- |
| `BROWSER_KEEPALIVE_MS` | `300000` | once |
| `BROWSER_PROVIDER` | `cloudflare` | once |
| `DEMO_PLATFORM_ORIGIN` | `https://demo-platform.pages.dev` | once |
| `OAUTH_STATE_TTL_SECONDS` | `600` | once |
| `ROBLOX_OAUTH_SCOPES` | `openid profile` | once |
| `ROBLOX_OPEN_CLOUD_RATE_PER_MINUTE` | `10` | once |
| `ROBLOX_RATE_LIMIT_PER_MINUTE` | `20` | once |
| `ROBLOX_SESSION_TTL_SECONDS` | `1209600` | once |
| `SSRF_DNS_CHECK` | `true` | once |
| `SSRF_DNS_FAIL_OPEN` | `true` | once |
| `TYPESAFE_ACCEPT_THRESHOLD` | `0.7` | once |
| `TYPESAFE_DECISION_TIMEOUT_MS` | `2500` | once |
| `TYPESAFE_ENABLED` | `true` | once |
| `TYPESAFE_MODEL` | `jev-latest` | once |
| `TYPESAFE_REVIEW_THRESHOLD` | `0.5` | once |
| `VIDEO_ARTIFACT_TTL_SECONDS` | `3600` | once |
| `VIDEO_MAX_DOWNLOAD_MB` | `50` | once |
| `VIDEO_MAX_DURATION_SECONDS` | `600` | once |
| `VIDEO_RATE_LIMIT_PER_MINUTE` | `12` | once |
| `VIDEO_TRANSCRIPTION_MODEL` | `@cf/openai/whisper` | once |
| `VIDEO_VISION_MODEL` | `@cf/llava-hf/llava-1.5-7b-hf` | once |

The `vars` block contains nothing beyond this set: the only other entries
(`ROBLOX_ALLOWED_HOSTS`, `TRANSCRIPTION_ENDPOINT`) are commented-out
examples. Values are strings throughout, matching how dashboard-set vars
arrive at runtime.

## Secrets — still secrets

No credential-shaped name appears in `vars`. The following remain
dashboard/`wrangler secret put` secrets by design (documented in comments in
`wrangler.jsonc`, never committed):

- `DEMO_API_KEY` — bearer token for `/mcp`
- `TYPESAFE_API_KEY` — Jev/TypeSafe decision API key
- `ROBLOX_CLIENT_SECRET`, `ROBLOX_TOKEN_KEY` — Roblox OAuth client
  credentials and token-at-rest encryption key (`ROBLOX_CLIENT_ID` may be a
  var but is not currently declared)
- `YOUTUBE_API_KEY` — YouTube Data API v3, read-only public operations
- `TRANSCRIPTION_API_KEY` — optional external speech-to-text provider

No secret values were read or recorded during this audit.

## Bindings, migrations, and deployment settings — untouched

`browser` (BROWSER), `r2_buckets` (SCREENSHOTS → `demo-mcp-screenshots`),
`durable_objects` (BROWSER_SESSIONS/BrowserSession, ROBLOX_AUTH/RobloxAuth),
`migrations` (v1, v2), `ai` (AI), cron trigger (`0 * * * *`), `workers_dev`,
`compatibility_date`/`compatibility_flags`, `main` (platform-entry.ts) and
`name` (demo-mcp) are all unchanged. No `env` section exists, so these vars
are the production values for the no-`--env` deploy in
`.github/workflows/live-deploy.yml`.

## Verification performed

- `npm run typecheck` (`tsc --noEmit`) — passed.
- `npm test` — 445 passed, 17 skipped (credential-gated live suites),
  including the 9 tests in `tests/wrangler-config.test.ts` that pin the
  vars, secret hygiene, and DO/migration bindings against the code.
- `CI=1 npx wrangler deploy --dry-run --outdir dist` — passed; wrangler
  resolved all 21 vars and every binding (Durable Objects, R2, Browser Run,
  AI) in the deploy plan.
- Duplicate-key scan (raw occurrence count per var name in the source) —
  no duplicates.
- Jev integration: `src/jev/` reads exactly the five `TYPESAFE_*` policy
  vars declared; `TYPESAFE_API_KEY` is consumed as a secret and the engine
  stays inert without it.

Not verified (no Cloudflare credentials in the audit environment): whether
the encrypted secrets are currently set on the deployed Worker
(`wrangler secret list`), and the deployed-vs-committed configuration diff.
