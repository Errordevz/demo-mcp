# The Laya Decision Provider (External) in DEMO

DEMO can ask **Laya** — an external, independently hosted typed-decision server — for the
same narrow typed judgments it asks TypeSafe/Jev. This document is the whole contract:
what Laya is here, how it is wired in next to the existing Jev integration, exactly what
DEMO sends it, what it does with the answers, and what it refuses to do.

Read [`docs/JEV.md`](JEV.md) first: everything it says about the System One API shape, the
three decision templates, the confidence bands and the fallback rules applies to Laya
unchanged. This file only covers what is *different*: Laya is a **second provider** behind
a configurable endpoint, not a pinned vendor integration.

---

## 1. What Laya is in this repository

| Thing | What it is | Where it lives here |
| --- | --- | --- |
| **Laya (the server)** | An external HTTP server speaking the Jev-compatible API: `POST /v1/systemone` with `state` + typed questions → typed answers (`choice` / `score` / `noul`) with probabilities, plus `usage`. | Your infrastructure. **Not in this repo, not in the Worker bundle.** |
| **Laya (the provider)** | The DEMO-side adapter: config resolution, the HTTP client, the SSRF-guarded call, response validation. | `src/laya/` |
| **The routing chain** | Which provider answers a decision, and what happens when it doesn't. | `src/decisions/` |

DEMO **never hosts, runs or bundles the Laya model**. There are no model weights, no
Python runtime, no inference code in this repository. Every capability Laya adds is a
plain HTTPS call to a server the operator points DEMO at. Without a configured server,
Laya contributes nothing and costs nothing.

**Laya is not wired in as a chat model.** Exactly like Jev, it is asked only to answer
typed questions over option sets DEMO enumerated in code. It produces no prose, no code,
no tool calls, and it can never authorize anything.

---

## 2. The API contract (unchanged from Jev)

```http
POST <LAYA_BASE_URL>/v1/systemone
Authorization: Bearer <LAYA_API_KEY>     ← only when a secret is configured
Content-Type: application/json

{ "state": "<bounded JSON, ≤ 8 000 chars>", "model": "<LAYA_MODEL>", "questions": { "<id>": { … } } }
```

The answer shapes consumed are identical to Jev's (`validateAnswer()` in
`src/decisions/systemone.ts`): `noul` → its probability *is* the answer; `choice` →
`{ choice, probabilities, confidence }`; `score` → `{ score, legend, probabilities,
confidence }`, every probability in `0…1`, confidence required. `usage` tokens are echoed
back as nullable numbers — never fabricated when the server omits them.

Anything else — a missing answer, an out-of-range probability, a choice outside the asked
set, a malformed body, a wrong type for the asked question — is a **schema failure**, and a
schema failure is a **provider failure**: the decision falls through the routing chain.

---

## 3. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAYA_ENABLED` | `true` (policy var; still inert without a base URL) | Master switch. `false`/`0`/`off`/`no` disables the provider with **zero network traffic**. |
| `LAYA_BASE_URL` | *(unset = provider off)* | Public https origin (+ optional path prefix) of the Laya server. `POST <LAYA_BASE_URL>/v1/systemone` is the decision endpoint. Not a secret; only ever a hostname on status surfaces. |
| `LAYA_API_KEY` | *(unset = unauthenticated)* | **Worker secret only** (dashboard → Settings → Variables and secrets → Encrypt, or `wrangler secret put LAYA_API_KEY`). Sent as exactly one `Authorization: Bearer …` header. Never a `vars` value, never in a URL, log, error, tool result or any status surface. |
| `LAYA_TIMEOUT_MS` | `2500` | Per-request budget (250–15 000 ms). Past it the decision is abandoned and the chain continues — never queued, never retried beyond the budget. |
| `LAYA_MODEL` | `laya-latest` | Model id sent in `model`. Set it to what your deployment actually serves. |
| `DECISION_PROVIDER_MODE` | `auto` | `auto` / `laya` / `jev` — see §4. `jev_decide` can override per call with `provider`. |

Minimal real deployment — three values, only one of them a secret:

```text
vars:    LAYA_ENABLED=true
vars:    LAYA_BASE_URL=https://your-laya-server.example    (or dashboard variable)
secret:  LAYA_API_KEY=…                                     (only if your server requires it)
```

---

## 4. Routing, fallback and the failure matrix

Decision routing is decided once per decision from `DECISION_PROVIDER_MODE` (or a per-call
`provider` on `jev_decide`):

- **`auto`** (default): available providers are asked in preference order **Laya → Jev**;
  the first successful, schema-valid answer wins. If every configured provider fails,
  DEMO uses the same deterministic fallback it has always used. Security policy,
  permission gates and confirmations are **never** part of any provider's chain — they
  stay hard-coded in DEMO.
- **`laya`**: Laya only. If Laya is unavailable or fails, the outcome says so
  explicitly ("Laya was explicitly selected …") and falls back to deterministic rules.
  It does **not** silently detour to Jev, and it never pretends to have succeeded.
- **`jev`**: the pre-Laya path, unchanged. Laya is not called.

| Situation | `auto` behaviour |
| --- | --- |
| Laya not configured / `LAYA_ENABLED=false` | Skipped with a reason in the fallback note; Jev (if configured) or deterministic rules answer. |
| Laya endpoint blocked by the SSRF guard (§5) | Provider failure (`blocked_url`); chain continues. **No fetch is made.** |
| Timeout (`AbortSignal.timeout(LAYA_TIMEOUT_MS)`) | Provider failure; chain continues. |
| HTTP 429/5xx | One in-contract retry (bounded by the same budget), then provider failure; chain continues. |
| HTTP 401/403 | `capability_unavailable` (wrong or missing credential); chain continues. |
| HTTP 422 / malformed body / invalid schema | `validation_failed`; **never treated as a decision**; chain continues. |
| Laya and Jev both fail | Deterministic fallback with a note naming both failures. Nothing is fabricated. |
| The questions themselves are invalid (`invalid_input`) | **Not** retried against the next provider — that is DEMO's own bug, not a provider outage. |

Every hop is visible in the response: `source` is `laya`, `jev` or `rules`, and when a
provider failed before the answering one, the note says who failed and who answered
instead. A Laya answer never carries a claim that Jev reviewed it, and vice versa.

---

## 5. Security architecture

Laya is an operator-configurable endpoint, so it gets the *strictest* version of every
existing DEMO protection:

- **SSRF guard on every call** (`src/core/url-guard.ts` — the same guard all outbound
  tools use): https only; loopback, private, link-local and metadata targets blocked;
  `.internal`/`.local`/metadata hostnames blocked; infrastructure ports (22, 2375, 3306,
  6379, 8080, …) blocked; URLs with embedded credentials, queries or fragments rejected at
  config time; the hostname is DNS-resolved and re-checked against private ranges before a
  single byte is sent (DNS-rebinding resistant whenever `SSRF_DNS_CHECK` is on).
- **The credential can never escape.** It exists only as a Worker secret, is attached as
  exactly one `Authorization` header, and:
  - is never included in the URL, the request body, a log line, an error or any result;
  - is never echoed by `/laya`, `/mcp`, `/health`, `/platform/stats`,
    `jev_decide`, `laya_capabilities` or `demo_ping` — those report *presence*
    (`credential_configured: true|false`);
  - if a hostile Laya server echoes the key *back* in a response body, the exact secret
    string is scrubbed from everything DEMO keeps (`[credential-redacted]`) before the
    generic sanitizer even runs; tests pin this.
- **Provider-controlled text is untrusted input.** Model ids and error details pass
  through `sanitizeUntrustedProviderText`: bearer/JWT/API-key shapes, `NAME=value`
  secret dumps, internal URLs, filesystem paths and blobs are all redacted, capped, then
  capped again by DEMO's global redaction layer.
- **Data minimization.** Laya receives only the bounded decision state (the same
  redacted state Jev receives — user text already stripped of credential shapes, capped at
  8 000 chars) plus the question template. No cookies, no IPs, no headers, no history.
  `/laya check` sends a fixed probe with no request content at all.
- **Advisory only.** A Laya answer can influence *which canned template value* DEMO
  records; it cannot authorize a tool, skip a confirmation, read a secret, relax the URL
  guard or emit code. The option sets live in this repository.
- **No network side effects while off.** Unset `LAYA_BASE_URL` (or `LAYA_ENABLED=false`)
  guarantees zero requests: the client throws before any fetch, and tests pin it.

## 6. What Laya is deliberately *not*

- Not a chat/completions model and not selectable as one; no free-text generation anywhere.
- Not an autonomous agent loop: one decision = one request set; answers do not chain.
- Not authoritative for permissions, security policy, secrets or SSRF decisions.
- Not hosted, embedded or bundled by this repository (no weights, no Python, no inference).
- Not telemetry: DEMO sends no usage/analytics anywhere, to Laya or otherwise; it adds no
  IP/cookie tracking.
- Not a Jev replacement: Jev remains first-class; `provider: "jev"` gives the pre-Laya
  behaviour bit-for-bit.

---

## 7. Operating it

- **Presence/policy report:** `GET /capabilities/laya` (or the `laya_capabilities` tool
  / `demo://capabilities/laya` resource). Presence-only — hostname, model, policy, never
  the credential.
- **Commands:** `/laya` (status), `/laya check` (one live probe round-trip with usage
  reported), `/laya mode` (the routing chain and each provider's availability), `/mcp`
  (Laya listed next to JEV in health and tools).
- **Decision surfaces:** `jev_decide` answers with `source: "laya" | "jev" | "rules"` plus
  `requestedProvider` and `effectiveRoutingMode`; the video-intent hook and both decision
  templates route through the same chain automatically.
- **Local development:** `node scripts/laya-mock-server.mjs [port]` runs a deterministic
  mock speaking this exact contract (`LAYA_MOCK_API_KEY` to require a bearer). Note the
  SSRF guard refuses loopback/http endpoints, so the mock is for poking the contract by
  hand; the test suite exercises the full integration against in-process mocks.

## 8. Tests

`tests/laya.test.ts` covers the contract and every failure mode against in-process mock
servers: success shapes (choice/score/noul, usage preserved), malformed and hostile
responses (incl. a server echoing the key — pinned never to leak), invalid schemas,
401/403/422/429/5xx mapping, single bounded retry, timeout and connection failures,
disabled/unconfigured zero-traffic behaviour, the SSRF blocklist incl. DNS-rebinding, all
three routing modes incl. honest explicit-mode failures, no infinite retry, failover
visibility, the video-intent hook, `/laya` and `/laya check`, `/health`, `/platform/stats`,
`/mcp`, the capability surfaces, `jev_decide provider: …`, and the invariant that a broken
Laya configuration cannot break unrelated tools. The pre-existing `tests/jev.test.ts`
suite runs unchanged against the shared contract implementation.
