# Reverse Engineering — final report

**Commit:** `0f186299b1c0c409f5088a73266549b0965e0200`
(`0f18629` — "Add evidence-driven reverse engineering capability")
**Branch:** `arena/01a0f7f1-demo-mcp`
**Base:** `7ca1e4ef027bf07493f1b140a0d665e3a6885f11`
**Date:** 2026-10-01

---

## 1. What was built

A production-quality, evidence-driven Reverse Engineering capability for DEMO MCP,
adapted from [`PyModel/reverse-engineering-skill`](https://github.com/PyModel/reverse-engineering-skill)
(MIT) to DEMO's Cloudflare Worker architecture rather than copied from it.

The capability is a set of **deterministic parsers plus a router**, exposed as
ordinary MCP tools. It answers "what is this artifact and what can be said about
it from the bytes alone", and it is explicit — in data, not in comments — about
everything it cannot answer.

### Tools

| Tool | Role |
| --- | --- |
| `reverse_engineer` | Orchestrator. `action` ∈ `capabilities`, `triage`, `analyze`, `protocol`, `deobfuscate`, `cleanroom`, `evidence`, `report`, `compare`, `dynamic`. |
| `reverse_capabilities` | Which engines this deployment has, the caps, the safety contract, the recommended workflow. |
| `reverse_triage` | The deterministic first pass. |
| `reverse_analyze` | Triage plus objective-specific work. |
| `reverse_evidence` | Paged, filtered, labelled evidence. |
| `reverse_report` | The deliverable. |
| `reverse_compare` | Mechanical artifact comparison. |

All seven are annotated `readOnlyHint: true`.

---

## 2. Files changed

### New — capability (21 modules, `src/reverse-engineering/`)

| Module | Lines | What it does |
| --- | --- | --- |
| `types.ts` | 190 | Shared vocabulary: `EvidenceLabel`, `Evidence`, `AnalysisDocument`, `AnalysisFinding`, `GeneratedArtifact`, `CapabilityReport`. |
| `binary-reader.ts` | 110 | Bounded `ByteReader` (`u8/u16/u32/u64/i8/i16/i32`, `cString`, `fixedString`, `slice`, `has`, `hex`) + `parseCount` (accepts decimal and hex strings). |
| `entropy.ts` | 230 | Shannon entropy (whole file and ranges), 4 KiB block entropy, classification, crc32/crc32c/crc16/adler32/RFC-1071 sum16/xor8, byte statistics, best-single-byte-XOR-key search, hexdump. |
| `strings.ts` | 130 | Bounded ASCII/UTF-16 string extraction with themes (URL, path, crypto marker, error, registry, format string, GUID, base64, IP). |
| `evidence.ts` | 175 | The evidence store: ids, labels, confidence, timestamps, `crossCheck` (different sources only), `singleSourced`, `query`, `page`, `counts`, `unknowns`. |
| `containers.ts` | 545 | Magic/arch/endian detection for ELF, PE, Mach-O (incl. fat), WASM, Java class, JAR/ZIP, DEX, .NET, ASAR, PCAP/PCAPNG, Python bytecode, SQLite, text — and an explicit `unknown` verdict. |
| `elf.ts` | 400 | ELF32/64 both endiannesses: sections with per-section entropy, symbols, dynamic symbols/needed, program headers, build-id, `.comment`, `.go.buildinfo`. |
| `pe.ts` | 300 | PE32/PE32+: machine, subsystem, DLL characteristics, sections with entropy, exports, imports, CodeView PDB path, .NET detection. |
| `macho.ts` | 240 | Mach-O 32/64 both endiannesses + fat header: cputype, filetype, flags, UUID, entry, sections, dylibs, code signature, symbols. |
| `wasm.ts` | 300 | WASM sections with entropy, imports/exports, function/memory/table/global/data counts, start function, name section, WASI imports. |
| `managed.ts` | 507 | Java class constant pool, DEX header, .NET metadata streams, ASAR header, ZIP central directory (never decompresses), `.pyc` magics + `ZIP_LIMITS`. |
| `pcap.ts` | 373 | Classic (both endiannesses, µs and ns) and PCAPNG; Ethernet/802.1Q/IPv4/IPv6/TCP/UDP; stream reassembly heads; bounded at 512 packets. |
| `modern-binaries.ts` | 300 | Go `pclntab` locator + version + candidate names, Rust v0 and legacy demangling, Swift symbol detection. |
| `protocol-analysis.ts` | 400 | Column-wise alignment, per-column classification, length-prefix discovery, checksum discovery **by recomputation**, state-machine reconstruction, specification emission. |
| `deobfuscation.ts` | 300 | Packing assessment, encrypted-string candidates, anti-analysis markers, explicit `requiresAnalysisService` list. |
| `cleanroom.ts` | 260 | Specification freeze (with an `excluded` one-way wall), golden-case derivation, byte-exact comparison. |
| `struct.ts` | 90 | Struct-layout validation: overlap, padding, alignment, total size. Port of upstream `validate_struct.py`. |
| `compare.ts` | 190 | Artifact comparison across nine dimensions with the specific differences. |
| `triage.ts` | 480 | The deterministic pass that produces the evidence everything else cites. |
| `report.ts` | 250 | Report builder grouped by label, with the single-source list. |
| `store.ts` | 190 | R2 expiring artifacts (SCREENSHOTS bucket) with an in-memory fallback. |
| `sandbox.ts` | 165 | Authorization, sandbox policy, `evaluateDynamicRequest`, `REFUSED_OPERATIONS`, `staticBudgets`, `safetyContract`. |
| `tool-discovery.ts` | 320 | 21 Worker engines, 20 external tools, `detectCapabilities`, `recommendWorkflow`. |
| `engine.ts` | 210 | The only door to the optional analysis service: closed operation allow-list, SSRF-guarded URL, bounded bytes, enforced timeout. |
| `config.ts` | 130 | `resolveReverseEngineeringPolicy` / `resolveReverseEngineeringConfig` / `reverseEngineeringFlags`, with published ceilings. |
| `router.ts` | 950 | `runReverseRequest` — the single entry point every tool delegates to. |

### New — MCP and tests

| File | What it is |
| --- | --- |
| `src/mcp/reverse-tools.ts` | The seven tool registrations, all delegating to the router. |
| `tests/helpers/reverse-fixtures.ts` | Synthetic, safe fixtures built byte-by-byte: ELF, PE, Mach-O, WASM, ZIP, Java class, PCAP, Go `pclntab`, unknown, text, PRNG. |
| `tests/reverse-engineering.test.ts` | 78 assertions across 15 groups. |
| `docs/REVERSE_ENGINEERING.md` | The capability contract (330 lines). |
| `docs/REVERSE-ENGINEERING-SECURITY-AUDIT.md` | The security audit (16 threats, dispositions, residual risks). |
| `docs/REVERSE-ENGINEERING-FINAL-REPORT.md` | This document. |

### Modified

| File | Change |
| --- | --- |
| `index.ts` | Registered the tools, added them to `DEMO_TOOL_NAMES`, added `GET /capabilities/reverse`, added the flags to `/health` and `demo_ping`, added a SERVER_INSTRUCTIONS paragraph. |
| `src/commands/mcp-command.ts` | `groupTools()` gained a `"Reverse Engineering"` group. |
| `scripts/generate-tool-catalog.mjs` | `groupFor()` gained the matching `reverse_*` → `Reverse Engineering` rule. |
| `src/ui/tool-catalog.ts` | Regenerated (113 tools; the seven RE entries carry real titles, descriptions and inputs). |
| `src/ui/content.ts` | New `reverse` capability category and a `REVERSE_ENGINEERING_RULES` constant. |
| `src/ui/app-script.ts` | Explorer filter, `catStatus("reverse")`, a capability-panel for the evidence contract and tool list, and a status row. |
| `ui.ts` | Exported the new constant to the UI data object. |
| `wrangler.jsonc` | Six non-secret `RE_*` policy vars, documented (no endpoint, no credential). |
| `tests/wrangler-config.test.ts` | Added `src/reverse-engineering/config.ts` to the reader list and a new describe block pinning the RE policy. |
| `README.md` | Architecture diagram, a new "Reverse Engineering" section, six config rows, a testing note. |

---

## 3. Architecture

```
MCP client ──► /mcp ──► src/mcp/reverse-tools.ts (7 tools, all readOnlyHint)
                          │  rate limit (RE_RATE_LIMIT_PER_MINUTE)
                          ▼
                src/reverse-engineering/router.ts
                  │ 1. RE_ENABLED?
                  │ 2. resolveTarget() — one of 4 sources, size-capped,
                  │    SSRF-guarded fetch, allow-list workspace paths
                  │ 3. staticBudgets(policy, depth)
                  │ 4. triageTarget() → EvidenceStore (labelled)
                  │ 5. objective-specific work
                  │ 6. evaluateDynamicRequest() for anything dynamic
                  ▼
   ┌──────────────┬──────────────┬───────────────┬──────────────┬─────────────┐
   │ containers   │ entropy      │ strings       │ evidence     │ sandbox     │
   │ elf/pe/macho │ shannon,     │ themes,       │ labels,      │ authorize,  │
   │ wasm/managed │ blocks,      │ bounded       │ cross-check, │ policy,     │
   │ pcap         │ checksums    │               │ single-source│ refuse-first│
   ├──────────────┴──────────────┴───────────────┴──────────────┴─────────────┤
   │ modern-binaries (Go/Rust/Swift) · protocol-analysis · deobfuscation       │
   │ cleanroom · struct · compare · report · tool-discovery · store (R2)       │
   └──────────────────────────────────────────────────────────────────────────┘
                          │ (optional, operator-run, SSRF-guarded)
                          ▼
                external analysis service
                closed operation allow-list, enforced limits
```

The Worker/analysis split is deliberate: heavy tooling cannot run inside a
Cloudflare Worker, so DEMO does the deterministic half itself and delegates the
rest to a service the operator controls, over HTTPS, through the existing SSRF
guard, with a closed allow-list of operations. With no service configured the
capability stays static and reports the missing engines.

---

## 4. Upstream concepts reused

| Upstream concept | Where it lives now |
| --- | --- |
| "Scripts do the math; the LLM does the semantics" | Every numeric result is computed in `entropy.ts`, `protocol-analysis.ts`, `struct.ts`, `elf/pe/macho/wasm/managed/pcap.ts`. |
| Evidence tags `observed/inferred/proposed/web/TBD` | `types.ts` `EvidenceLabel`, enforced by `evidence.ts`. |
| Phase 0 tool access → phase 7 report | `reverseRequestActions()` and `recommendWorkflow()`. |
| "No skipping triage — wrong toolchain assumption wastes an hour" | `triage.ts` runs first in every analysis and records why. |
| Entropy > 7.0 = packing signal | `ENTROPY_PACKED_THRESHOLD` in `entropy.ts`, used by `deobfuscation.ts`. |
| Magic-byte table for ELF/PE/Mach-O/Java/JAR/DEX/WASM/ASAR/.NET BSJB | `containers.ts`. |
| Go `pclntab` magics `0xFFFFFFFB/FA/F0/F1`, quantum, ptrSize | `modern-binaries.ts` `extractGoMetadata`, with padding/pointer-size validation before any claim. |
| `scripts/extract_go_metadata.py` | `modern-binaries.ts`. |
| `scripts/calculate_entropy.py` | `entropy.ts` (whole file + blocks + per section). |
| `scripts/validate_struct.py` | `struct.ts` (offset/size/total_size, hex strings accepted, alignment). |
| `references/05-protocol-ipc.md` §1 framing loop | `protocol-analysis.ts`: column-wise diff → constant/session/monotonic/length/enum classification, then checksum verification by recomputation. |
| `references/06-deobfuscation-dyn.md` | `deobfuscation.ts`: identify the strategy from measurable signals, then say which neutralisation is available here and which needs a heavier engine. |
| `references/07-cleanroom.md` one-way wall + golden tests | `cleanroom.ts`: `excluded` list, golden cases, byte-exact comparison. |
| `references/08-output-standards.md` deliverable package | `report.ts`: executive summary, triage table, architecture, findings by label, unknowns, artifacts, next steps, single-source list. |
| Small bounded MCP tool pattern (ReVa philosophy) | One router, seven focused tools, bounded inputs, structured refusals. |

Upstream **not** reused: the Python scripts themselves, the Ghidra/Frida
templates, and the CLI wrapper. DEMO has no Python runtime and no process API in
the Worker graph, and the sandbox/authorization model is DEMO's own.

---

## 5. Tests run

```
npx tsc --noEmit                       → clean (only pre-existing src/mcp/dev-tools.ts errors)
npx vitest run                         → 56 files, 965 passed, 17 skipped, 0 failed
npx vitest run tests/reverse-engineering.test.ts        → 78 passed
npx vitest run tests/wrangler-config.test.ts            → 12 passed
npx vitest run tests/tool-catalog.test.ts               →  4 passed
npx vitest run tests/ui-shell.test.ts tests/ui-app.test.ts → 8 passed
npx vitest run tests/security-hardening.test.ts         → 18 passed
npx vitest run tests/worker-build.test.ts               →  1 passed (real wrangler deploy --dry-run)
```

`tests/reverse-engineering.test.ts` covers, by group:

1. **container identification** — ELF, PE, Mach-O, WASM, ZIP/JAR, Java class, PCAP, text; ELF architecture/bits/endianness/sections/entry; PE machine/bits/subsystem/sections; Mach-O cputype/filetype/bits; WASM sections/version/counts; PCAP read as data (2 packets, 2 streams); ZIP central directory without decompression; Java class header and constant pool.
2. **unknown-file handling** — undocumented container reported, not guessed; truncated/empty/3 MB inputs never throw; the unknown surfaces as an `unknown` evidence label.
3. **entropy** — Shannon entropy, block entropy, classification, the packed threshold; exact checksum recomputation; XOR key recovery and the refusal to report a confident key for noise.
4. **evidence labels** — the five labels stay distinct and countable; a label can never be promoted, and the same tool twice is not a cross-check; single-sourced claims are reported; filtering and paging.
5. **capability detection** — 21 Worker engines and 20 external tools with no id collisions; every heavy engine missing until a service is configured; different workflows per container and objective; no capability advertised that the deployment lacks; the whole capability refuses when `RE_ENABLED=false`.
6. **workspace path isolation** — allow-listed paths accepted; traversal, absolute, drive letter, `~`, NUL, empty segments and a trailing slash all refused.
7. **command allow-listing** — the closed operation set; a non-allow-listed operation refused before any request; the service URL routed through the SSRF guard; a timeout enforced.
8. **oversized input rejection** — an inline payload above the cap refused with `size_limit_exceeded`; invalid base64 refused; more than one target source refused; a tool argument can never raise the deployment cap.
9. **sandbox and dynamic analysis** — static default, unenforceable sandbox; refusal with no request, no opt-in, no service, no authorization, and for a `public-source` scope; allowance only when every gate passes; the refusals are data; a refused dynamic request through the router.
10. **clean-room workflow** — the specification excludes the original implementation; captures supply inputs but prove nothing on their own; recorded outputs compare byte-exactly; an unexercised golden case is reported, not counted as a pass.
11. **protocol-analysis workflow** — column-wise alignment and classification; a length prefix verified against the message length; unclassifiable columns left as `unknown`; a checksum verified by recomputation and *not* claimed when it fails; state-machine reconstruction from observed transitions only.
12. **deobfuscation** — a packed-looking target flagged from entropy alone; a low-entropy target not accused.
13. **modern binaries** — Go `pclntab` recovery with quantum/pointer size; missing `pclntab` reported rather than invented; Rust v0 and legacy demangling; Swift detected, never fabricated.
14. **struct layout validation** — no overlaps, padding computed; overlaps and an exceeded total size rejected; hex strings and alignment accepted.
15. **router pipeline** — a full analysis with findings/evidence/unknowns/missing engines; persistence and evidence paging; an unknown analysis id refused; two-target and two-analysis comparison; no execution whatever the objective; a blocked URL target; Go metadata labelled `inferred`.
16. **artifact store** — memory fallback; R2 write-through with an expiring TTL in metadata and an expired object not served.
17. **MCP and UI integration** — exactly seven tools registered; `tools/list` exposes titles, descriptions, inputs and `readOnlyHint`; `reverse_capabilities` and `reverse_triage` run over the real transport; the UI catalog and capability category are wired; Dev/Jev/Laya remain discoverable with no collisions; `GET /capabilities/reverse` returns policy with no secrets.

The MCP tools were exercised over the real Streamable HTTP transport (not just
unit-called), on a synthetic ELF, before any of this was claimed to work.

---

## 6. Security controls

* **No execution.** No process API, no `eval`, no `new Function`, no arbitrary
  command execution anywhere in the capability. Bytes are read as data.
* **Dynamic analysis is refuse-first.** Six independent gates, and a refusal
  names the missing one.
* **Closed operation allow-list** for the analysis service; the target travels
  as bounded bytes with resource limits, never as a command or a path.
* **Existing SSRF guard reused** for URL targets and for the service endpoint,
  with per-hop redirect re-validation.
* **Allow-list workspace path validation**; everything isolated under
  `re-workspace/…`.
* **Bounded everywhere** — target size, budgets per depth, evidence, documents,
  artifacts, packets, ZIP entries and expansion.
* **TTL'd artifacts** in the existing `SCREENSHOTS` bucket, matching the
  screenshot/video convention.
* **Labels cannot be promoted**; cross-checks require different sources;
  single-sourced and unknown claims are surfaced.
* **No secrets, no endpoints** in vars, logs, tool results, `/health`,
  `/capabilities/reverse` or the UI.
* **Rate limited** through the shared `publicToolRateLimiter`.
* **No destructive patching, no malware deployment** — both are in
  `REFUSED_OPERATIONS` as data.

Full detail, including a 16-row threat table and the accepted residual risks:
[`docs/REVERSE-ENGINEERING-SECURITY-AUDIT.md`](REVERSE-ENGINEERING-SECURITY-AUDIT.md).

---

## 7. Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `RE_ENABLED` | `true` | Master switch. |
| `RE_MAX_TARGET_MB` | `16` | Hard ceiling 64 MiB; a tool argument may only lower it. |
| `RE_MAX_ANALYSIS_MS` | `20000` | Wall-clock budget per analysis. |
| `RE_DYNAMIC_ENABLED` | `false` | Opt-in; does not make dynamic analysis run on its own. |
| `RE_ARTIFACT_TTL_SECONDS` | `3600` | Artifact TTL. |
| `RE_RATE_LIMIT_PER_MINUTE` | `12` | Per-minute budget. |
| `RE_ANALYZER_URL` | *(unset)* | External analysis service. Server-side only, never committed. |
| `RE_ANALYZER_KEY` | *(unset)* | Service credential. A Worker secret, never a var, never echoed. |
| `RE_ANALYZER_TIMEOUT_MS` | `8000` | Per-request service timeout. |

---

## 8. Limitations

* No disassembly or decompilation inside the Worker — reported as missing
  engines, not faked.
* No dynamic analysis without an operator-run sandbox.
* Go `pclntab` names are candidates (`inferred`); GoReSym is authoritative.
* Struct validation checks arithmetic, not truth.
* Protocol analysis needs at least two captured messages.
* Clean-room equivalence is bounded by the captured cases.
* Analyses are per isolate; an expired document must be re-run.
* The Worker graph stays Node-API-free (`Uint8Array`/`DataView`/`crypto.subtle`),
  enforced by the real `wrangler deploy --dry-run` gate.

---

## 9. Verification that nothing else broke

* `tests/tool-catalog.test.ts` — passes (the pre-existing failure caused by the
  stale generated catalog is fixed).
* `tests/ui-app.test.ts` / `tests/ui-shell.test.ts` — pass; `NAV_PRIMARY` and
  `SECTIONS` are untouched, discovery is a capability category plus an explorer
  filter.
* `tests/wrangler-config.test.ts` — passes, and is tighter than before.
* `tests/security-hardening.test.ts`, `tests/expansion-surface.test.ts`,
  `tests/worker-build.test.ts` — pass.
* `/mcp`, storage, browser, video, OAuth, and the existing AI tools are
  unmodified: no existing tool, route, storage layout or OAuth flow changed.
