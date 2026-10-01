# Reverse Engineering

Evidence-driven reverse engineering of binaries, containers, captures and
archives, exposed as ordinary MCP tools on the public `/mcp` endpoint.

The methodology is adapted from
[`PyModel/reverse-engineering-skill`](https://github.com/PyModel/reverse-engineering-skill)
(MIT). Two of its rules are load-bearing here and are enforced by code, not by
convention:

1. **Scripts do the math; the model does the semantics.** Entropy, container
   identification, section/symbol/import parsing, Go `pclntab` recovery,
   checksum recomputation and struct-layout validation are computed. Nothing
   numeric is ever left to a language model.
2. **Evidence or it didn't happen.** Every claim carries a label —
   `observed`, `inferred`, `proposed`, `web`, `unknown` — and no claim may appear
   without naming the tool that produced it.

---

## 1. The tools

| Tool | What it does |
| --- | --- |
| `reverse_engineer` | The orchestrator. One `action` argument selects the phase: `capabilities`, `triage`, `analyze`, `protocol`, `deobfuscate`, `cleanroom`, `evidence`, `report`, `compare`, `dynamic`. |
| `reverse_capabilities` | Which engines **this deployment** actually has, the policy caps, the safety contract and the recommended workflow for an objective. No target needed. |
| `reverse_triage` | The deterministic first pass: container, architecture, bits, endianness, entry point, sections with per-section entropy, symbol surface, imports, toolchain hints, packing assessment, string surface. |
| `reverse_analyze` | Triage plus objective-specific work, with findings, labelled evidence, unknowns and the engines that were missing. |
| `reverse_evidence` | Paged, filtered evidence for a stored analysis, including which claims rest on a single source. |
| `reverse_report` | The deliverable: executive summary, triage table, architecture summary, findings by label, unknowns, artifacts, next steps. |
| `reverse_compare` | Mechanical comparison of two artifacts (or two stored analyses): hash, container, size, entropy, symbol/import/section/string overlap, toolchain. |

Every tool is annotated `readOnlyHint: true`. There is no write, patch, deploy or
execute tool in this capability.

## 2. A typical session

```
reverse_capabilities { objective: "triage" }          → what can I actually do here?
reverse_triage       { target: { inlineBase64: … } }  → container, arch, entropy, symbols
reverse_analyze      { target: {…}, objective: "architecture", depth: "standard" }
reverse_evidence     { evidence: { analysisId: "analyze-…", label: "observed" } }
reverse_report       { report: { analysisId: "analyze-…" } }
```

`analysisId` is the handle for everything that follows: evidence, reports and
comparisons all reference it. Analyses are kept per isolate and additionally
persisted to the `SCREENSHOTS` R2 bucket as an expiring JSON document, so a
report survives an isolate restart until its TTL expires.

## 3. Targets

A target resolves from exactly one of four sources, all size-capped before any
parsing:

| Source | Argument | Notes |
| --- | --- | --- |
| Inline bytes | `target.inlineBase64` | The only source that needs no configuration. |
| Public URL | `target.url` | Fetched through DEMO's existing SSRF guard (scheme allow-list, private/loopback/link-local/metadata ranges, DNS checks, per-hop redirect re-validation). |
| Stored artifact | `target.artifactId` | An artifact returned by a previous analysis. |
| Workspace path | `target.workspacePath` | A path inside the isolated `re-workspace/…` prefix. |

`target.name` is a display string only — it is never treated as a filesystem
path, and `sanitizeTargetName()` strips separators and control characters.

## 4. The workflow

### Phase 0 — tool access

`reverse_capabilities` reports the 21 deterministic engines that ship inside the
Worker, the 20 external tools that need the optional analysis service, the
current caps and the safety contract. A missing engine is reported as missing;
DEMO never simulates Ghidra, radare2, Frida or Jadx.

### Phase 1 — triage

`reverse_triage` / `reverse_analyze` run, in order:

1. **Container identification** — magic table over ELF, PE, Mach-O (including
   fat), WASM, Java class, JAR/ZIP, DEX, .NET, ASAR, PCAP/PCAPNG, Python
   bytecode, SQLite, plus an explicit `unknown` verdict for anything else.
2. **Architecture** — bits, endianness, `e_machine` / `Machine` / `cputype`.
3. **Entry points** and the program/segment/section tables.
4. **Sections** with per-section Shannon entropy.
5. **Symbols and imports** — full / partial / stripped / none / not-applicable.
6. **Toolchain fingerprint** — from `.comment`, `.go.buildinfo`, CodeView PDB
   paths, section names and the string surface.
7. **Entropy profile** — whole file, per-section, and per 4 KiB block when there
   is no section table.
8. **Packing assessment** — entropy, packer-shaped section names, packer strings,
   thin import surface, stub-like layout.
9. **String surface** — URLs, paths, crypto markers, error strings, registry
   keys, format strings.
10. **Language metadata** — Go `pclntab`, Rust/Swift mangled symbols.

### Phase 2 — research

`web`-labelled evidence can be recorded by the caller; DEMO does not fetch
research on its own and never fabricates a citation.

### Phase 3 — deep semantics

`reverse_analyze` with `objective: architecture | functions | symbols | strings |
behavior | decompile | vulnerability`. Everything that needs a disassembler or a
decompiler is reported as a missing engine with the exact requirement.

### Phase 4 — protocol / IPC

`reverse_engineer { action: "protocol", messages: [...] }`:

1. align the captured messages column-wise,
2. classify every column (constant / small cardinality / monotonic / length /
   checksum),
3. verify every checksum hypothesis by **recomputing** it (crc32, crc32c,
   adler32, RFC 1071 sum16, crc16-ccitt, xor8) over a candidate byte range,
4. reconstruct the state machine from observed transitions,
5. emit a specification where every field carries the evidence that produced it.

An unclassifiable column is reported as `unknown`, with its observed values. It
is never given a meaning.

`reverse_engineer { action: "analyze", objective: "protocol" }` runs the same
analysis inside the full pipeline, so the framing evidence is stored with the
analysis.

### Phase 5 — deobfuscation

`reverse_engineer { action: "deobfuscate" }` reports the packing assessment, the
encrypted-string candidates (single-byte XOR with a printable-ASCII score), the
anti-analysis markers found in the string surface, and — explicitly — what
DEMO *cannot* do: static unpacking, memory-dump unpacking, symbolic execution for
opaque predicates, and VM-handler identification. Those are listed as
`requiresAnalysisService`, not as caveats in a comment.

### Phase 6 — clean-room

`reverse_engineer { action: "cleanroom", observations: [...] }`:

1. freezes a behavioural specification from labelled observations,
2. derives golden test cases from captures,
3. compares a reimplementation's **captured** outputs against them byte-exactly.

The one-way wall is structural: the specification contains only
evidence-referenced behaviour, and `excluded` lists what it deliberately does
**not** contain (decompiled source, original identifiers, assets, verbatim code).
DEMO never executes the reimplementation and never executes the original target.

### Phase 7 — report

`reverse_report` produces the deliverable and appends the single-source list, so
a reader can see exactly which conclusions still need a second opinion.

## 5. Evidence labels

| Label | Meaning | Who produces it |
| --- | --- | --- |
| `observed` | A tool read the bytes and reports exactly what it saw. | The deterministic parsers. |
| `inferred` | A conclusion derived from observations by code (e.g. "packing is likely"). | The parsers, with a confidence. |
| `proposed` | A hypothesis that has not been verified. | The synthesis step, or the caller. |
| `web` | Something a document says. | The caller. |
| `unknown` | Explicitly unresolved. | Any parser that could not classify something. |

`EvidenceStore` enforces the rest:

* `crossCheck(leftId, rightId)` only records agreement between **different**
  sources — the same tool twice is not a cross-check;
* `singleSourced()` returns every non-`unknown` claim with no cross-check, and
  the report lists them;
* a label can never be promoted: there is no API that turns an `inferred` claim
  into an `observed` one.

## 6. Security model

### Static by default

Bytes are read as data. There is no code path in this capability that executes a
target, spawns a process, or accepts a command line. Uploading a file produces
evidence, never a process.

### Dynamic analysis is opt-in, and refused by default

`dynamic: true` plus an `authorization` are required, and even then
`evaluateDynamicRequest()` refuses unless **all** of these hold:

1. the request explicitly asked for dynamic analysis;
2. `RE_DYNAMIC_ENABLED` is set on the deployment (default `false`);
3. an external analysis service is configured (`RE_ANALYZER_URL`);
4. the execution environment reports an **enforceable** sandbox;
5. the caller supplied an authorization with `confirmed: true` and a statement;
6. the authorization scope is not `public-source` — a public URL is never
   authorized to be executed.

A refusal reports exactly which requirement is missing. It is never simulated.

### No arbitrary command execution

The analysis service accepts a closed allow-list of operations
(`ANALYZER_OPERATIONS`): `tool-inventory`, `identify`, `sections`, `symbols`,
`strings`, `disassemble`, `decompile`, `unpack`, `instrument`, `network-trace`.
A caller can never pass a command, a script path or a target path — the target is
sent as bounded base64 bytes with the resource limits the sandbox must enforce.

### Refusals are data

`REFUSED_OPERATIONS` and `safetyContract()` are exported and returned by
`reverse_capabilities`, so the model can state the limits rather than guess them:

* arbitrary shell or command execution on behalf of a caller;
* executing a target merely because it was uploaded;
* destructive patching of a target in place;
* deployment of malware;
* decryption of protected archives or credentials supplied by a caller;
* stealth, evasion or anti-forensics against a real target.

### Path isolation

Every extracted file, cached artifact and temporary blob lives under the
per-analysis `re-workspace/…` prefix. `assertSafeWorkspacePath()` is
allow-list based: a path may only contain `[A-Za-z0-9._-]` segments separated by
`/`. `..`, `.`, an absolute prefix, a backslash, a drive letter, `~`, an empty
segment or a NUL byte is refused before it can be joined to anything.

### Bounded everything

* `RE_MAX_TARGET_MB` (default 16, hard ceiling 64 MiB) caps the target;
* static budgets scale with `depth` (`quick` / `standard` / `deep`) and bound
  strings, sections and symbols;
* evidence is capped at 2 000 entries per analysis and documents at 64 per
  isolate;
* artifacts are capped well below the target cap and expire with a TTL;
* every service request carries a timeout and a bounded response read.

### No secrets, no internal URLs

`RE_ANALYZER_URL` is per-deployment infrastructure and is **not** declared in
`wrangler.jsonc`; `RE_ANALYZER_KEY` is a Worker secret
(`wrangler secret put RE_ANALYZER_KEY`). Neither is ever echoed, logged, or
returned by a tool. `/capabilities/reverse` and `reverse_capabilities` report
presence booleans only.

## 7. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RE_ENABLED` | `true` | Master switch. Off → every tool reports `capability_unavailable`. |
| `RE_MAX_TARGET_MB` | `16` | Maximum accepted target size (a tool argument may only lower it). |
| `RE_MAX_ANALYSIS_MS` | `20000` | Wall-clock budget for one analysis. |
| `RE_DYNAMIC_ENABLED` | `false` | Opt-in for dynamic analysis. Does not make it run on its own. |
| `RE_ARTIFACT_TTL_SECONDS` | `3600` | TTL for stored analysis artifacts. |
| `RE_RATE_LIMIT_PER_MINUTE` | `12` | Per-minute budget for the whole capability. |
| `RE_ANALYZER_URL` | *(unset)* | External analysis service. Server-side only, never committed. |
| `RE_ANALYZER_KEY` | *(unset)* | Service credential. A Worker secret, never a var. |
| `RE_ANALYZER_TIMEOUT_MS` | `8000` | Per-request timeout for the analysis service. |

All values are clamped against published ceilings, so a hostile or mistaken
environment can shrink a cap but never grow one.

## 8. Engines

### Deterministic, inside the Worker (21)

`demo.triage`, `demo.entropy`, `demo.strings`, `demo.evidence`, `demo.elf`,
`demo.pe`, `demo.macho`, `demo.wasm`, `demo.jvm`, `demo.dex`, `demo.dotnet`,
`demo.zip`, `demo.asar`, `demo.pcap`, `demo.go-metadata`, `demo.rust-symbols`,
`demo.protocol-analysis`, `demo.cleanroom`, `demo.compare`, `demo.struct`,
`demo.sandbox`.

### External, behind the optional service (20)

`file`, `strings`, `readelf`, `objdump`, `nm`, `otool`, `llvm-objdump`,
`ghidra`, `radare2`, `frida`, `jadx`, `apktool`, `javap`, `dotnet`, `wasm-objdump`,
`go tool`,`rustc-demangle`, `z3`, `binwalk`, `tshark`.

### Running the analysis service yourself

The service is deliberately **not** bundled: it is your infrastructure, on your
machine or your own container, and DEMO talks to it over HTTPS through the SSRF
guard. It must:

* accept `POST /v1/analyze` with a JSON body of
  `{ operation, target: { name, data_base64 }, selector?, limits, authorization? }`;
* accept only the allow-listed operations;
* enforce the supplied `limits` (cpu, wall, memory, processes, network);
* answer `{ ok, result, tools?, truncated?, error? }`.

With no service configured the capability stays static and reports the missing
engines — which is the honest answer, and the only one that cannot mislead.

## 9. Limitations

* **No disassembly or decompilation inside the Worker.** Everything below
  instruction level is reported as a missing engine.
* **No dynamic analysis without your own sandbox.** DEMO will not become one.
* **Go symbol recovery is candidate-level.** `pclntab` names are `inferred`;
  GoReSym or `go tool nm` is authoritative.
* **Struct validation checks arithmetic, not truth.** A layout that passes has no
  overlaps and fills its declared size; it may still be the wrong layout.
* **Protocol analysis needs captures.** With fewer than two messages there is
  nothing to align, and the tool says so instead of guessing.
* **Clean-room equivalence is bounded by the captured cases.** It is evidence,
  not a proof.
* **Analyses are per isolate.** The document is persisted to R2 with a TTL, but
  an expired analysis must be re-run.
* **The Worker build gate keeps the graph Node-API-free.** Parsers use
  `Uint8Array`/`DataView`/`crypto.subtle`; no `Buffer`, no `node:fs`.

## 10. Testing

`tests/reverse-engineering.test.ts` (78 assertions across 15 groups) covers:
container identification for ELF/PE/Mach-O/WASM/ZIP/Java/PCAP, unknown-file
handling, truncated and empty input, entropy and checksum arithmetic, XOR
recovery, evidence labels and the no-promotion rule, single-source reporting,
capability detection with and without a service, workspace path isolation,
operation allow-listing, SSRF-guard routing, timeouts, oversized-input
rejection, sandbox refusal at every gate, the clean-room workflow, the protocol
workflow (framing, length prefix, checksum recomputation, state machine,
unclassifiable columns), deobfuscation, Go/Rust/Swift metadata, struct
validation, the router pipeline, the artifact store with and without R2, the MCP
tool schemas over the real transport, and the UI catalog/category wiring.

`tests/wrangler-config.test.ts` additionally pins the reverse-engineering policy
block, that no credential or endpoint is committed, and that the caps are
clamped by the code.

Run them:

```bash
npx vitest run tests/reverse-engineering.test.ts
npx vitest run tests/wrangler-config.test.ts tests/tool-catalog.test.ts
```
