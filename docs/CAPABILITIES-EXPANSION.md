# DEMO 0.9 — capability expansion

This document describes the DEMO 0.9 capability expansion: what was added, how
it reuses the existing DEMO infrastructure, the security contract, and the
implementation report. Existing tools and integrations (browser automation,
screenshots, live sessions, human handoff, video processing, YouTube, Roblox
OAuth/account tools, Jev, Cloudflare storage/R2/Durable Objects, Workers AI,
HTTP fetching, SSRF protection, rate limiting) are untouched and still
registered under their original names.

Read the live capability report at `demo://capabilities/expanded` (MCP
resource), `GET /capabilities/expanded`, or the `expanded` block of
`demo_ping` / `GET /health`.

---

## 1. Public Git (`git_repository`)

Generic Git over the **smart-HTTP protocol** via `isomorphic-git` with DEMO's
own guarded HTTP transport underneath. Works with GitHub, GitLab, Codeberg,
Gitea, sourcehut or any `git-http-backend` — normal `https://…/repo.git` URLs,
no host-specific API integration, **no API key**.

Modes: `info` (metadata + default branch), `branches`, `tags`, `log` (with
changed files per commit), `commit` (one commit + changed files), `file` (read
at any revision), `tree`, `search` (content search at a revision), `compare`
(two revisions → structured diffs + patch), `patch` (export a commit as a
patch), `stats`, `ignore` (.gitignore inspection + path tests), `fetch`
(re-fetch).

Security:

* Every request **and every redirect hop** goes through `core/url-guard`
  (localhost, RFC1918, loopback, link-local, Cloudflare/metadata endpoints,
  internal DNS suffixes, unsafe schemes, credential URLs all blocked).
* ssh://, git:// and `git@host:path` URLs are rejected with an https:// hint.
* Private repositories: HTTP 401/403 becomes a structured `auth_required`
  refusal. There is **no credential mechanism at all** — nothing is requested,
  accepted, harvested or stored.
* Size limits (pack bytes, workspace quota, file counts), timeouts, depth
  limits and per-repository rate limits (`GIT_*` vars).
* Temporary clones live in a quota-bounded in-memory filesystem, are reused for
  at most `GIT_TEMP_REPO_TTL_MS` inside one isolate and are then wiped. No
  repository byte ever touches persistent storage.
* Hooks, LFS commands, build scripts, package installation and repository
  automation are **never executed**; all content is read as object data.

## 2. Internet Archive (`archive_search`, `archive_item`, `wayback`)

Public endpoints only (`archive.org/wayback/available`, `web.archive.org/cdx`,
`web.archive.org/web/<ts>id_/…`, `archive.org/advancedsearch.php`,
`archive.org/metadata/<id>`) through the shared SSRF-guarded fetch. No API key.

* `archive_search` — scope `items` (catalog) or `web` (Wayback captures for a
  URL/host).
* `archive_item` — item metadata + file layout; restricted items are flagged
  `restricted: true` and DEMO says it will not attempt to bypass them.
* `wayback` — `availability` (closest snapshot to a timestamp), `snapshots`
  (captures around a date), `retrieve` (archived page + extracted content).
* Results always preserve the **original URL** and the **archive timestamp**.
* "No snapshot exists", "unavailable", "restricted" and upstream throttling
  (429/503/509 → `rate_limited`) are structured outcomes, never fabricated
  content.

## 3. RSS / Atom (`feed_read`)

RSS 2.x, Atom 1.0 and RDF/RSS 1.0: feed title/description/link/language,
entries with titles, links, GUIDs/ids, publication/update dates, authors,
categories/tags, descriptions/content and enclosures, configurable entry
limits, tolerant handling of malformed feeds (warnings, never throws). Inline
`xml` parsing works fully offline. No API key. DOCTYPE/external entities are
skipped (no XXE).

## 4. PDF intelligence (`pdf_document`)

Public PDFs through the shared fetch (content-type validation, size limit
`PDF_MAX_MB`, timeouts). A dependency-free bounded parser reads the object
graph directly:

* `info` — metadata (Info dictionary + XMP), page count, scanned detection.
* `text` — page-by-page text **with page numbers preserved** (`[page N]`).
* `pages` — per-page structure (chars, lines, embedded images, tables).
* `search` — matches with page/line references.
* `tables` — column-alignment heuristic (best-effort; documented).
* `ocr` — scanned/image-only pages (JPEG/DCTDecode page images) OCR'd through
  the **existing Workers AI binding** (`VIDEO_VISION_MODEL`). Without the AI
  binding OCR reports `unavailable` — DEMO never invents text.

PDFs are untrusted input: nothing inside them is executed. Non-JPEG raster
filters (CCITT/JBIG2/Flate images) are reported as limitations rather than
guesswork. ToUnicode/CMap font mapping is out of scope (documented limitation).

## 5. Image analysis (`image_analyze`)

Public image retrieval (size limit `IMAGE_MAX_MB`, MIME allow-list) + header
metadata (format, dimensions, hash — reusing `video/probe`'s parsers) + AI
modes (`describe`, `ocr`, `analyze`) on the **existing** Workers AI vision
binding — no second vision API. `compare` handles 2–4 images with per-image
descriptions and a coarse pairwise similarity (pixel diffs belong to
`screenshot_diff`). Without the AI binding, `info` still works and AI-derived
fields report `unavailable`.

## 6. Web diff (`web_diff`) + screenshots (`screenshot_diff`)

* `web_diff` — fetch current page → extract → compare against `previous_text`,
  a stored `snapshot_key`, or none (store a fresh baseline). Detects
  added/removed/changed content after `normalizeForDiff` strips dynamic noise
  (dates, counters, tokens); returns structured + unified diffs.
* `screenshot_diff` — compares two screenshot references (or public image URLs)
  with a real pixel diff **in DEMO's existing browser** (canvas work in-page —
  the same pattern as video frame analysis, no Worker-side codec). Returns
  changed-pixel ratio, changed-region bounding boxes and a stored difference
  image via the existing `ScreenshotManager` (same link format and TTL).
  Without the browser binding it degrades to honest metadata comparison.

Snapshots live in the **existing R2 artifact bucket** (`SCREENSHOTS`) as
expiring objects (`expiresAt` customMetadata) under `web-snap/…` — cleaned up
by the same scheduled TTL sweep as screenshots and video artifacts. No new
storage system, no Durable Objects needed.

## 7. Webpage extraction (`web_extract`) + Webpage → Markdown/JSON

One shared extractor (`src/web/extract.ts` over `src/core/html-lite.ts`) used
by `web_extract`, `web_diff`, `web_monitor`, archive retrieval and research —
no duplicate extraction logic and **no second browser** (for JS-rendered pages
the existing `browser_*` tools remain the answer). Outputs:

* structured JSON: title, description, author, publication date, headings,
  paragraphs, links, images, tables, metadata and JSON-LD blocks,
* Markdown (headings, lists, tables, links, images),
* clean text.

## 8. OpenAPI inspector (`openapi_inspect`)

OpenAPI 3.x (JSON or YAML) and Swagger 2.0 where practical: title/version/
description, servers, paths, methods, parameters, request bodies, response
schemas, security schemes (name/type only — **never credentials**), reusable
schemas and endpoint summaries. The inspector **reads the document and never
calls the APIs it discovers**; remote `$ref` targets are never fetched. Uses
the shared fetch + a dependency-free YAML subset parser.

## 9. Network diagnostics (`net_diagnose`)

One public target at a time — never a scanner (no ports, no sweeps, no
fingerprinting):

* `dns` — A/AAAA/MX/NS/TXT/CNAME/SOA/CAA/SRV records via the same DoH resolver
  the SSRF guard uses, with TTLs and public/private classification.
* `http` — status, redirect chain with per-hop safety verdicts, response
  headers (Set-Cookie/Authorization never echoed), timing, resolved addresses.
* `tls` — certificate issuer/subject/expiry via the existing browser binding
  (`securityDetails`); reported `unavailable` otherwise — never guessed.

Internal targets (localhost, RFC1918, loopback, link-local, metadata, internal
names) are refused before any query.

## 10. JSON Schema validation (`schema_validate`)

Fully local (nothing is uploaded). draft-07 / 2019-09 / 2020-12 practical
subset: type, enum, const, properties, required, additionalProperties,
patternProperties, items/prefixItems, numeric/string bounds, pattern, format
subset, allOf/anyOf/oneOf/not, if/then/else, internal `$ref`. Returns
valid/invalid + **exact failing JSON-pointer paths**, expected constraint,
received value/type and messages. Remote `$ref` is refused (never fetched);
unsupported keywords are reported in `warnings`, never silently ignored.

## 11. JWT inspection (`jwt_inspect`)

**DECODING ≠ VERIFICATION.** Structure detection, header decoding (alg/typ/kid),
payload/claims (`exp`, `iat`, `nbf`, `iss`, `aud`, `sub`, custom) with window
status against a stated `now`, algorithm identification. The result always
carries `verification: "not-performed"` with the disclaimer. No signing key is
ever requested, accepted or stored — there is no verification input path at
all. The complete token is never returned or logged (redaction-first; only a
short SHA-256 fingerprint appears).

## 12. Cron parser (`cron_explain`)

Local, deterministic. Standard 5-field cron, the common 6-field seconds
extension and `@yearly/@monthly/@weekly/@daily/@hourly` macros; lists, ranges,
steps, month/weekday names; Vixie day-of-month/day-of-week OR semantics;
human-readable explanation; upcoming occurrences (UTC, bounded horizon with an
honest "no occurrence" message); precise errors for malformed expressions.

## 13. Text/document diff (`text_diff`)

Local comparison (never uploaded): `lines` (structured added/removed/changed
sections), `unified` (unified diff), `json` (deep diff with exact paths).
Markdown and other documents compare as text. Optional noise normalization.
The same engine backs `web_diff`, monitor change summaries and Git patches.

## 14. Screenshot comparison

See §6 — built on the existing screenshot + browser stack, never a second
screenshot system.

## 15. Website monitoring (`web_monitor`)

`add` / `check` / `list` / `remove` / `history` over the existing R2 bucket:
URL registration, normalized snapshot/fingerprint storage, change detection
with a structured change summary (via the shared diff engine), configurable
retention (`SNAPSHOT_RETENTION_SECONDS`, per-monitor `max_versions`), removal.
Checks run **only when requested** — or via the opt-in hourly sweep
(`WEB_MONITOR_SCHEDULED_CHECKS=true`); a registered URL never silently becomes
an unbounded recurring job. Every check respects SSRF, timeouts, size limits
and the shared rate budget.

## 16. Structured web research (`web_research`)

Orchestration over capabilities DEMO already has (guarded fetch, shared
extractor, Internet Archive fallback): discover → retrieve → extract → compare
→ findings. Deterministic query planning (DEMO has no LLM of its own — the
connected AI answers from the findings). The contract:

* every sourced statement carries **source URL + retrieval timestamp**,
* `findings.facts` are quoted sentences actually present in sources,
* `findings.inference` is explicitly labelled as unverified synthesis,
* conflicts are reported as conflicts (both variants), never resolved by
  guessing; `confidence` is a corroboration heuristic and says so,
* sources needing CAPTCHA/login/consent get a `human_handoffHint` pointing at
  the existing `browser_captcha_handoff` / `browser_pause_for_human` flow —
  protections are never bypassed.

Configurable: depth (`quick|standard|deep`), max sources, timeout, domain
allow/deny lists, archive fallback.

## 17. URL safety inspector (`url_inspect`)

Report over the **existing** SSRF stack (never a weakening of it): parsing,
scheme validation, hostname resolution + public/private classification,
suspicious-pattern flags (open-redirect parameters, alternate IP notations,
encoded control characters, userinfo tricks, downgrade/multi-host redirects),
optional redirect-chain inspection with every hop re-validated, final
destination and security-related response headers. The block list — localhost,
RFC1918/loopback/link-local, metadata services, internal Cloudflare/DNS zones,
unsafe schemes, SSRF bypass shapes — is `core/url-guard`'s, unchanged.

## 18. Webpage → Markdown / JSON

Part of `web_extract` (§7): `format=markdown` and `format=json` are the
conversion utilities; both run through the same shared extractor.

---

## Shared internal modules (no duplicate implementations)

| Module | Used by |
| --- | --- |
| `src/core/url-guard` + `src/core/guarded-fetch` (`createSsrfGuard`, `guardedFetchBytes`, `guardedFetchJson`) | git, archive, feeds, pdf, images, web, openapi, network, research, url_inspect |
| `src/core/rate-limit.ts` (`TOOL_RATE_LIMIT_PER_MINUTE` budget) | every fetch-backed capability |
| `src/core/html-lite.ts` | webpage extraction, feeds, archive, research |
| `src/core/xml-lite.ts` | feeds, XMP metadata |
| `src/core/text-diff.ts` | text_diff, web_diff, monitoring, git patches |
| `src/web/extract.ts` | web_extract, web_diff, web_monitor, archive retrieval, research |
| `src/web/storage.ts` (R2 snapshots/monitors) | web_diff, web_monitor |
| `src/documents/pdf.ts` | pdf_document (incl. OCR glue) |
| `src/documents/image.ts` (reuses `video/probe` + `AI.run`) | image_analyze |
| `src/git/*` (safety, memory-fs, client, gitignore) | git_repository |
| `src/openapi/*` | openapi_inspect |
| `src/network/diagnose.ts`, `src/security/url-safety.ts` | net_diagnose, url_inspect |
| `src/validate`, `src/tokens`, `src/time` | schema_validate, jwt_inspect, cron_explain |

## Security / privacy contract (expansion)

* No IP logging, tracking pixels, hidden analytics, fingerprinting or
  unnecessary cookies were added; no telemetry was added.
* No credential collection of any kind (Git especially); no secrets are
  required or used by any new capability.
* Nothing executes repository content, PDF content, feed content or any other
  external bytes — everything is parsed as untrusted data.
* No Cloudflare secrets, OAuth tokens, API keys, filesystem paths, internal
  URLs or environment values are ever returned; error paths go through the
  existing redaction helpers.
* All new fetches use the existing SSRF guard **per redirect hop**, with
  bounded bodies, bounded time and the shared rate budget.

## Environment variables (all non-secret policy)

| Var | Default | Meaning |
| --- | --- | --- |
| `GIT_MAX_PACK_MB` | `20` | Per-operation Git download ceiling |
| `GIT_REQUEST_TIMEOUT_MS` | `25000` | Git network budget (max 60s) |
| `GIT_RATE_LIMIT_PER_MINUTE` | `6` | Git ops per minute per repository |
| `GIT_MAX_DEPTH` | `200` | Deepest history a caller may request |
| `GIT_MEMORY_MAX_MB` | `48` | Temporary in-memory clone quota |
| `GIT_TEMP_REPO_TTL_MS` | `600000` | Temp clone lifetime inside an isolate |
| `TOOL_RATE_LIMIT_PER_MINUTE` | `12` | Shared public-source budget |
| `SNAPSHOT_RETENTION_SECONDS` | `604800` | Web snapshot/monitor retention |
| `WEB_MONITOR_SCHEDULED_CHECKS` | `false` | Opt-in hourly monitor sweep |
| `PDF_MAX_MB` | `25` | PDF download ceiling |
| `IMAGE_MAX_MB` | `8` | Image download ceiling |

**New secrets: none.** PDF OCR and image vision reuse the existing `AI`
binding and `VIDEO_VISION_MODEL` variable.

---

# Implementation report

**New tools (19):** `git_repository`, `archive_search`, `archive_item`,
`wayback`, `feed_read`, `pdf_document`, `image_analyze`, `web_extract`,
`web_diff`, `web_monitor`, `screenshot_diff`, `openapi_inspect`,
`net_diagnose`, `url_inspect`, `schema_validate`, `jwt_inspect`,
`cron_explain`, `text_diff`, `web_research`.

**Modified tools:** none (every pre-existing tool keeps its name, schema and
behaviour). Non-tool surfaces updated additively: `demo_ping`/`/health` (new
flag blocks), `GET /tools` (new resource listed), `GET /capabilities/expanded`
(new endpoint), `GET /platform/stats` (new capability flags), the `/mcp`
command (new tool groups), and the scheduled handler (existing TTL sweep now
also cleans `web-snap/` + `web-mon/` objects; opt-in monitor sweep).

**New shared modules:** `core/rate-limit`, `core/html-lite`, `core/xml-lite`,
`core/text-diff`, `core/guarded-fetch` (bytes/json/guard builders — extended),
`web/extract`, `web/fetch-page`, `web/storage`, `web/diff`, `web/monitor`,
`documents/pdf`, `documents/image`, `git/{config,safety,memory-fs,client,
gitignore}`, `archive/client`, `feeds/{parse,client}`, `openapi/{yaml,inspect}`,
`network/diagnose`, `security/url-safety`, `validate/json-schema`,
`tokens/jwt`, `time/cron`, `research/orchestrator`, plus the MCP tool modules
under `src/mcp/*-tools.ts` and `src/mcp/expansion-resources.ts`.

**New dependency:** `isomorphic-git` (pure-JS Git smart-HTTP client — the
packfile/protocol layer; all I/O goes through DEMO's own guarded transport and
memory filesystem).

**New environment variables:** the 11 policy vars listed above.
**New secrets:** none.

**Tests added:** `tests/git-repository.test.ts` (20, incl. end-to-end against a
real `git upload-pack` smart-HTTP server), `tests/archive-wayback.test.ts` (11),
`tests/feeds.test.ts` (10), `tests/pdf-intelligence.test.ts` (11),
`tests/image-analysis.test.ts` (10), `tests/web-extract-diff.test.ts` (13),
`tests/screenshot-diff.test.ts` (10), `tests/openapi-net.test.ts` (13),
`tests/local-utilities.test.ts` (17), `tests/research.test.ts` (8),
`tests/expansion-surface.test.ts` (10) — plus `tests/helpers/git-server.ts` and
`tests/helpers/fetch-router.ts`, and additive pins in
`tests/wrangler-config.test.ts`. The suites cover SSRF protection (localhost,
RFC1918, metadata, redirect poisoning), malformed inputs, oversized resources,
timeouts, rate limits, public Git repositories, Wayback search/retrieval, RSS
and Atom, normal and scanned PDFs (incl. OCR paths), image analysis, webpage
extraction, OpenAPI parsing (incl. "never calls discovered APIs"), JSON Schema,
JWT decoding (incl. redaction + no-verification guarantees), cron parsing,
text/document diffs, screenshot comparison, website snapshots/monitoring,
structured research and URL safety.

**Existing functionality verified:** the full pre-existing suite (543 tests
across browser sessions, CAPTCHA handoff, video pipeline, YouTube, Roblox
OAuth/account, Jev, MCP surface/auth, security hardening, deployment audit,
worker build) passes unchanged.

**Not implemented as specified (and why):**

* *PDF tables* use a column-alignment heuristic, not full ruling-line/glyph
  analysis — a faithful table extractor needs a PDF layout engine, which cannot
  run safely inside a Worker without shipping a large parser; the heuristic is
  documented and reports honestly when no table structure is found.
* *OCR of non-JPEG scanned pages* (CCITT/JBIG2/Flate raster) is reported as
  `no-embedded-image` rather than attempted: decoding those filters would mean
  shipping raster codecs; JPEG page images (the overwhelmingly common scan
  format) are OCR'd through Workers AI.
* *TLS certificate metadata* is only available when the Browser Rendering
  binding is present (`securityDetails`); Workers `fetch` cannot see peer
  certificates and the tool reports `unavailable` instead of guessing.
* *Screenshot pixel diffing* requires the browser binding (canvas work
  in-page); without it `screenshot_diff` returns an honest metadata-only
  comparison. Pixel work in the Worker would require shipping image codecs.
* *JWT verification* is intentionally **not** implemented: the spec forbids
  requesting signing keys, and verifying without a key would be theatre.
* *Research synthesis* is evidence collection + comparison, not LLM prose: DEMO
  has no language model; the connected AI answers from the provenance-backed
  findings (this is the architecture DEMO already uses for video).
