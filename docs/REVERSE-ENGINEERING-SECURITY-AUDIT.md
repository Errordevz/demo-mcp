# Reverse Engineering — security audit

Scope: the `src/reverse-engineering/` capability and `src/mcp/reverse-tools.ts`,
plus the wiring in `index.ts`, `src/ui/*`, `src/commands/mcp-command.ts`,
`scripts/generate-tool-catalog.mjs`, `wrangler.jsonc` and
`tests/wrangler-config.test.ts`.

Method: manual review of every new module, plus a mechanical scan for dangerous
patterns, secret handling and Worker-runtime compatibility. Findings are listed
with their disposition; nothing below is left open.

---

## 1. Threat model

| # | Threat | Disposition |
| --- | --- | --- |
| T1 | A caller gets DEMO to execute an uploaded binary. | **Impossible by construction.** No module imports a process API, calls `eval`, builds a `Function`, or spawns anything. The only `exec` in the capability is `RegExp.prototype.exec`. Bytes are read as data by `ByteReader`. |
| T2 | A caller smuggles a command through the analysis service. | **Closed allow-list.** `ANALYZER_OPERATIONS` is a fixed 10-entry tuple; `isAnalyzerOperation()` rejects everything else, and `runAnalyzerOperation()` re-checks before any network I/O. The target is sent as bounded base64 bytes with resource limits — never as a path or a command string. |
| T3 | A caller escapes the isolated workspace with a crafted path. | **Allow-list path validation.** `assertSafeWorkspacePath()` permits only `[A-Za-z0-9._-]` segments separated by `/`, and refuses `..`, `.`, absolute prefixes, backslashes, drive letters, `~`, empty segments, NUL bytes and >512-byte paths. The root is always prefixed, so prefixing it again cannot escape it. |
| T4 | A caller uses a URL target to reach an internal service (SSRF). | **Existing guard, reused.** `guardedFetchBytes` + `createSsrfGuard` validate scheme, private/loopback/link-local/metadata ranges, infrastructure ports and DNS, and re-validate every redirect hop. The SSRF guard is also applied to the analysis-service endpoint on every call. |
| T5 | A huge or streaming artifact exhausts Worker memory. | **Bounded at every boundary.** `RE_MAX_TARGET_MB` (default 16, hard ceiling 64 MiB) caps the target before parsing; `decodeBase64Bounded()` refuses an oversized payload; `ZIP_LIMITS` caps entries and expansion and the ZIP reader **never decompresses**; PCAP parsing stops at 512 packets; evidence is capped at 2 000 entries and documents at 64 per isolate; artifacts are capped at 2 MiB. |
| T6 | Dynamic analysis is used as an execution primitive. | **Refuse-first.** `evaluateDynamicRequest()` requires `dynamic: true` **and** `RE_DYNAMIC_ENABLED` **and** a configured service **and** an enforceable sandbox **and** a confirmed authorization **and** a scope that is not `public-source`. The default sandbox policy is `network: none`, `enforceable: false`, ≤4 processes. A refusal names the missing requirement; it is never simulated. |
| T7 | A caller reads another analysis's evidence or artifacts. | **Ids are per-analysis and unguessable.** `randomAnalysisId()` produces `re_` + 20 hex characters; artifacts are namespaced `re-analysis/<analysisId>/<id>`; `reverse_evidence` only returns a document that exists in this isolate (or an expired R2 object). No listing surface is exposed. |
| T8 | A crafted header crashes a parser. | **Bounds-checked reads.** `ByteReader.has()` gates every read and returns `null` instead of throwing; every parser produces a partial report plus a warning rather than an exception. `tests/reverse-engineering.test.ts` exercises empty, 2-byte, 4-byte and 3 MB all-`0xff` inputs against all six parsers. |
| T9 | A crafted archive is a decompression bomb. | **Never expanded.** `listZipEntries()` reads the central directory only and refuses to report an archive whose declared expansion exceeds the caps. No member is ever written anywhere. |
| T10 | A caller reads a secret or an internal URL. | **Not present in any output.** `RE_ANALYZER_URL` is not declared in `wrangler.jsonc`; `RE_ANALYZER_KEY` is a Worker secret, read only as a boolean presence check and never echoed, logged or returned. `/capabilities/reverse` and `reverse_capabilities` return presence booleans and caps only. A test asserts the tool result never matches `/RE_ANALYZER_KEY|analyzerKey|apiKey/i`. |
| T11 | The model presents an inference as an observation. | **Labels are structural.** `EvidenceStore` has no API that promotes a label; `crossCheck()` only records agreement between *different* sources; `singleSourced()` and the report's single-source list make unverified claims visible. |
| T12 | The model claims a capability DEMO lacks. | **Missing engines are data.** `detectCapabilities()` returns the missing engines with the reason, `reverse_capabilities` reports them, and `recommendWorkflow()` names `request-analysis-service-for-*` steps explicitly. |
| T13 | Rate-limit abuse of the capability. | **Shared limiter.** Every tool charges `publicToolRateLimiter` under `RE_RATE_LIMIT_PER_MINUTE` before doing work, keyed by target. |
| T14 | Stored artifacts outlive their purpose. | **TTL in metadata.** `createReverseEngineeringStore()` writes `customMetadata.expiresAt` and refuses to serve an expired object, matching the existing screenshot/video convention on the same `SCREENSHOTS` bucket. |
| T15 | The UI leaks policy or credentials. | **Presence booleans only.** The capability card renders the evidence contract and tool list; `catStatus("reverse")` reads `reverseEngineering` / `reverseEngineeringAnalyzer` / `reverseEngineeringDynamic` booleans from `/health`. No env values, no endpoints, no keys. The strict CSP is unchanged. |
| T16 | A new nav section breaks the pinned UI contract. | **No new nav section.** Discovery is a `CAPABILITY_CATEGORIES` entry (`id: "reverse"`, `route: "capabilities"`) plus an `EXPLORER_FILTERS` entry. `NAV_PRIMARY` and `SECTIONS` are untouched, so `tests/ui-app.test.ts` and `tests/ui-shell.test.ts` still pass. |

## 2. What was checked mechanically

```
grep -rn "child_process|execSync|exec(|eval(|new Function|require(|node:fs|node:child|process\.env|Buffer\." \
     src/reverse-engineering/ src/mcp/reverse-tools.ts index.ts
```

Result: one match, `RegExp.prototype.exec` in `modern-binaries.ts`. No process
API, no dynamic code evaluation, no Node built-in, no `Buffer`, no `process.env`
in the Worker graph. All binary work uses `Uint8Array` / `DataView` /
`crypto.subtle`, which the Cloudflare Worker build gate
(`tests/worker-build.test.ts`, a real `wrangler deploy --dry-run`) accepts.

```
grep -rn "RE_ANALYZER_KEY" src/ index.ts wrangler.jsonc
```

Result: two comments, one boolean presence check (`analyzerKeyConfigured`), one
`wrangler secret put` instruction in a comment. The value is never stored,
returned, logged or compared.

Credential-shaped variable scan (`/(?:SECRET|API_KEY|TOKEN|PASSWORD|_KEY)$/i`
over `wrangler.jsonc` vars) returns `[]` — `tests/wrangler-config.test.ts`
asserts this, and the same test now also asserts that `RE_ANALYZER_URL` and
`RE_ANALYZER_KEY` are documented but never declared.

## 3. What was checked behaviourally

| Property | Test |
| --- | --- |
| No execution, whatever the objective | `never executes a target, whatever the objective` |
| Non-allow-listed operation refused before any request | `refuses a non-allow-listed operation at the client` |
| Service URL routed through the SSRF guard | `routes the service URL through the SSRF guard` |
| Timeout enforced | `enforces a timeout instead of hanging` |
| URL target the guard blocks is refused | `refuses a URL target the SSRF guard blocks` |
| Traversal / absolute / drive / home / NUL / empty segments refused | `refuses traversal, absolute paths, drive letters, home and NUL bytes` |
| Oversized inline payload refused | `refuses an inline payload above the deployment cap` |
| Caps can only shrink | `never lets a tool argument raise the deployment cap` |
| Dynamic refused at every gate | the five `sandbox and dynamic analysis` cases |
| Public-source target never executable | `refuses a public-source target from ever being executed` |
| Labels never promoted | `never lets a label be promoted without naming a second, different source` |
| Single-source claims reported | `reports single-sourced claims instead of burying them` |
| Unknowns surfaced, not hidden | `surfaces the unknown as an unknown evidence label` and `leaves an unclassifiable column as unknown` |
| No secrets in the MCP result | `runs reverse_capabilities over the real MCP transport` and `exposes GET /capabilities/reverse with policy and no secrets` |
| Truncated/empty input never throws | `never crashes on truncated or empty input` |

## 4. Accepted residual risks

1. **The analysis service is trusted once configured.** DEMO validates its URL
   with the SSRF guard and sends it only allow-listed operations, but the service
   itself is operator-run infrastructure. Its isolation is the operator's
   responsibility, which is why `sandbox.enforceable` must be `true` before any
   dynamic run.
2. **Deterministic parsers can be wrong.** A magic-byte match is evidence, not
   truth. Every parser reports its own confidence and warnings, and the triage
   report says so.
3. **Go `pclntab` names are candidates.** They are labelled `inferred`, and the
   warning points at GoReSym.
4. **The single-byte XOR heuristic is a heuristic.** It reports a score, and
   `deobfuscation.ts` states that a match is a hypothesis about the transform,
   not proof.
5. **Clean-room equivalence is bounded by the captured cases.** The verdict and
   the notes say exactly that.

## 5. Changes to existing security-relevant files

| File | Change | Why it is safe |
| --- | --- | --- |
| `wrangler.jsonc` | Added six `RE_*` policy vars (all non-secret, all strings). | No endpoint, no credential. `RE_DYNAMIC_ENABLED` defaults to `false`. |
| `tests/wrangler-config.test.ts` | Added `src/reverse-engineering/config.ts` to the reader list and a new describe block. | Tightens the existing "declared vars are actually read" rule rather than relaxing it. |
| `index.ts` | Registered the tools, added them to `DEMO_TOOL_NAMES`, added `/capabilities/reverse`, added the flags to `demo_ping`, added a SERVER_INSTRUCTIONS paragraph. | No new binding, no new secret, no new route that writes. |
| `src/ui/*` | One capability category, one explorer filter, one status case, one rules constant. | Presence booleans only; the strict CSP and the pinned nav are untouched. |
| `scripts/generate-tool-catalog.mjs` | `reverse_*` → `Reverse Engineering` group. | Mirrors `groupTools()` in `src/commands/mcp-command.ts`, as the catalog test requires. |

No existing tool, route, storage layout, OAuth flow or browser path was modified.
