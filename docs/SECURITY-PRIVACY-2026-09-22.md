# Security & privacy overhaul — 2026-09-22 (0.8.4 beta)

> **Historical snapshot.** Statements below describe an earlier `DEMO_API_KEY` and browser-session design. The current authentication model is documented in [MCP OAuth](MCP-OAUTH.md) and [Roblox setup](ROBLOX.md): public tools remain anonymous; protected account tools use short-lived, per-tool DEMO OAuth grants bound to a verified identity.

A focused hardening pass over the 0.8.3 beta codebase. No architecture changed,
no capability was removed, no tool schema changed, and the public `/mcp`
transport (ChatGPT → Demo) still requires no bearer. Each item below is a small,
additive guard with a regression test in `tests/security-hardening.test.ts`.

## What was already in good shape (verified, left as-is)

* **Transport model.** `/mcp` is public by design (see
  `docs/MCP-AUTH-AUDIT-2026-09-20.md`); `DEMO_API_KEY` gates only the private
  account/paid tools (`roblox_account_*`, `jev_decide`). Preserved unchanged.
* **SSRF guard.** `src/core/url-guard.ts` blocks non-http schemes, literal and
  resolved private ranges, metadata endpoints, and re-validates redirect targets
  for browser navigation; DNS checks use DoH with documented fail-open policy.
* **Roblox OAuth.** Authorization-code + PKCE, single-use state, cookie flags,
  Origin/Sec-Fetch-Site checks, per-route rate limits keyed on a **truncated
  SHA-256 of the client IP** (minimized: hashed, never stored or logged),
  AES-GCM-256 token encryption at rest, revocation — 54 existing tests still
  green.
* **Artifacts.** Screenshot/video-asset ids are high-entropy random or
  content hashes; both routes validate id shape, honour per-object `expiresAt`
  metadata, answer 410 for expired artifacts, and the hourly cron deletes
  expired `screenshots/` and `video-artifacts/` objects.
* **Telemetry.** `/platform/stats` is presence-only flags; a test now pins that
  it carries no client identifiers and no cookies. No IP logging, no analytics,
  no fingerprinting, no third-party calls anywhere in the codebase.
* **Secrets.** wrangler.jsonc declares no secret-shaped vars; `.env.example` is
  placeholders only; git history scan found no committed credentials. Secrets
  stay in Worker secrets (`DEMO_API_KEY`, `ROBLOX_CLIENT_SECRET`,
  `ROBLOX_TOKEN_KEY`, `TYPESAFE_API_KEY`, `YOUTUBE_API_KEY`,
  `TRANSCRIPTION_*`).

## Changes in this pass

| # | File(s) | Change | Why |
| --- | --- | --- | --- |
| 1 | `src/core/credential.ts` (new), `src/mcp/roblox-tools.ts`, `src/mcp/jev-tools.ts` | Private-tool bearer check now compares SHA-256 digests (`bearerCredentialMatches`) instead of `===` against the secret. | Removes a timing side channel on the credential check; behavior (accept/reject matrix) is byte-identical. |
| 2 | `src/core/guarded-fetch.ts` (new), `index.ts` | `http_fetch` follows redirects manually and re-runs the SSRF guard on **every hop**; body reads are bounded (2 MB cap, streamed, content-length pre-check). | Closes redirect-based SSRF (public URL → 302 → internal address) and unbounded body reads. |
| 3 | `src/core/headers.ts` (new), `index.ts`, `platform-entry.ts` | `POST/PUT` bodies to `/mcp` larger than `LIMITS.maxMcpBodyBytes` (5 MB) are rejected with `413` before the MCP transport reads them, in both entrypoints. | Resource-exhaustion guard; ordinary JSON-RPC traffic (a 40-action workflow is a few KB) is unaffected. Bodies without a content-length header pass through and rely on the platform's own request-size cap. |
| 4 | `src/core/headers.ts`, `index.ts`, `platform-entry.ts`, `ui.ts` | Every JSON/asset response now carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; the inspector UI additionally sends a restrictive CSP (`default-src 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`, inline style/script allowed) and `X-Frame-Options: DENY`. | Static, per-response headers only — no request data is read. Blocks sniffing, framing/clickjacking of the UI and exfiltration via third-party endpoints. |
| 5 | `src/core/limits.ts`, `src/session/durable-object.ts` | A retention sweep runs when a session DO wakes: state idle for more than `LIMITS.sessionStateRetentionMs` (7 days) has its tab records (URLs/titles), pause and handoff records, provider session id and last error wiped; the next browser tool re-acquires cleanly. | Idle sessions no longer retain browsing metadata forever. The sweep logs only booleans + idle duration, never URLs. |
| 6 | `package.json`, `index.ts`, `platform-entry.ts`, `src/roblox/oauth.ts`, `src/commands/jev-command.ts`, tests | Version unified at **0.8.4 beta** (two stale hardcoded copies of 0.8.3 in the Roblox User-Agent and the Jev command fallback were found and fixed by the version-consistency test). | Release marking; eliminates version drift. |

## Data handling after the pass

Stored, and why: encrypted Roblox token envelopes (RobloxAuth DO, AES-GCM-256,
single-use refresh rotation), per-session browser metadata (tab ids/URLs/titles,
pause/handoff records — now swept after 7 idle days), screenshots/frames/video
artifacts in R2 (`expiresAt` metadata + hourly sweep + 1 h default TTL,
high-entropy or hash ids, served with `nosniff` and `private` cache control).

Logged: redacted structured lines only (`safeLog` → `redactText`/`redactValue`):
lifecycle labels, ids, byte counts, status codes, safe error codes. Never: IP
addresses, user agents, cookies, authorization headers, secrets, page text,
transcripts, or typed field values.

## Verification

* `npm run typecheck` — clean.
* `npm test` — 526 passed, 17 skipped (credential-gated live suites), including
  the 22 new hardening tests and the full existing matrix (browser sessions,
  captcha handoff, video pipeline, Roblox OAuth, Jev, MCP surface/auth).
* `npm run build:check` — `wrangler deploy --dry-run` succeeds; bindings,
  migrations and crons unchanged.

## Remaining risks (documented, not silently accepted)

* The public transport means anyone can drive the *public* browser tools within
  Cloudflare's own rate limits and Browser Run concurrency. This is the product
  design (ChatGPT has no header to send); mitigations are platform quotas and
  the SSRF/evasion guardrails, not authentication.
* `browser_evaluate` executes arbitrary JS in the Demo browser on a caller-chosen
  URL — by contract. It cannot reach Worker secrets or other sessions.
* Guard-to-fetch TOCTOU: the SSRF guard resolves DNS separately from the
  subsequent fetch. Workers cannot reach link-local/metadata targets, which makes
  practical exploitation unlikely, but DNS pinning is not implemented.
* MCP bodies without a `content-length` header bypass the 413 pre-check (the
  Workers platform request-size cap still applies).
* R2 lifecycle rules are recommended as the second line of defence for artifact
  retention; the Worker cron covers it but runs hourly, not instantly.
* Skilled/skill or page content remains untrusted input for the connected model:
  results are redacted and structured, and server instructions teach the model to
  treat them as data, but prompt-injection resistance is ultimately the
  client's responsibility too.
