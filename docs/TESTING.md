# Testing

```bash
npm test          # vitest run  — unit + integration + build gate
npm run typecheck # tsc --noEmit over src/ and tests/
npm run build:check # CI=1 wrangler deploy --dry-run --outdir dist
```

The suite is designed so that **only the browser transport is faked**. Page
scripts, the SSRF guard, redaction, challenge detection, payload parsing,
snapshot rendering and the whole MCP/HTTP surface run for real.

## Layers

| Layer | Where | What it proves |
| --- | --- | --- |
| Pure units | `tests/url-guard.test.ts`, `tests/redact.test.ts`, `tests/challenge.test.ts`, `tests/snapshot.test.ts`, `tests/tiktok.test.ts` | SSRF blocking (static + DNS), secret redaction, challenge classification, bounded rendering, TikTok payload parsing. |
| Page scripts | `tests/page-scripts.test.ts` | The serialised in-page functions run under jsdom in a `vm` context — the same way a browser would run them. |
| Runtime integration | `tests/browser-session.test.ts` | `BrowserRuntime` against a fake provider: open, redirects, screenshots → R2, a11y snapshots, tabs, timeouts, login walls, CAPTCHA pause/resume, degraded capabilities, typing secrets. |
| Media | `tests/media.test.ts` | Metadata reports and frame sampling, including the "cannot decode", "DRM protected" and "no video" honest-failure paths. |
| Public video | `tests/video.test.ts` | Safe redirect/media-candidate resolution, SSRF redirect rejection, platform challenge reporting and content-addressed expiring artifact references. |
| Video ingestion | `tests/video-ingest.test.ts` (14 cases) | `video_ingest` end-to-end with a faked browser transport only: streamed download of the real media to R2 (content-addressed `video_<sha256>`, bytes and duration verified, HTML/thumbnail bodies rejected with `NOT_A_VIDEO` and the partial object deleted), decoded frames mapped to MCP image blocks (JPEG magic bytes checked), `max_duration_seconds`/`frame_count` honoured, honest platform-block failures with zero frames, SSRF-blocked URLs never fetched. Plus `video_inspect_pipeline`: all 9 stages reported, first failure named, R2 round-trip cleaned up, secret never echoed. Plus the MCP surface: tool inventory, artifact-only result without a browser, image content blocks with a JSON manifest, and the diagnostic running with no key while the existing `/mcp` endpoint auth (401 without the bearer when `DEMO_API_KEY` is set) is preserved. |
| 0.7.0 retrieval pipeline | `tests/video-pipeline.test.ts` (63 cases) | `video_resolve` (short-link redirects, byte-verified stream discovery, per-candidate probes, the 13-state `access_status` taxonomy incl. TikTok status codes, signed-URL redaction), `video_fetch` (streamed R2 storage with `DigestStream` hashing, head/tail duration verification, `NOT_A_VIDEO` rejection with partial delete, Range reads, 410 expiry), unified `video_analyze` (evidence summary, separated text sources, no invented dialogue) and `video_react` (null reaction authored by the connected model, vision observations only from real frames), the `R2` artifact store (token→hash promotion, range reads, expiry), container probing, the Workers AI binding (capability flips, timestamped transcripts, `no_speech_detected`, no secret leakage into tools/routes), `video_extract_frames` extras (resize math, real pixel sizes, no-thumbnail guarantee), and the MCP/HTTP surface (`/health` flags, `/capabilities/video`, image blocks). |
| Platform extractors | `tests/video-platforms.test.ts` (17 cases) | Dedicated offline parsers for Instagram (shortcode media JSON), YouTube (`ytInitialPlayerResponse` incl. the playability verdict, ciphered renditions never deciphered, manifests reported never streamed), X (`__NEXT_DATA__` `video_info` variants) and Reddit (`shreddit-player`/`reddit_video` video-only fallback): URL identity, metadata, stream sources, photo-post / private / login-wall / manifest-only verdicts through the real `parsePage` → `classifyAccess` path, plus an end-to-end Reddit resolve and the capability-report wording. |
| Container probing | `tests/video-probe.test.ts` (23 cases) | `detectMediaSignature()` fixtures for AVI, FLV, OGG video/audio, WebM/Matroska, WebP, GIF, BMP and AVIF (incl. lying content-type headers and the AVIF-still-is-not-mp4 fix), `imageDimensions()` for PNG/GIF/WebP (VP8/VP8L/VP8X)/JPEG/BMP/AVIF-`ispe`, `webmDurationFromBytes()` with real EBML vint sizes, and path-level honesty: GIF/WebP rejected (`NOT_A_VIDEO`, nothing stored), AVI/FLV downloads only with a verifiable duration, WebM durations verified from the EBML header. |
| Automatic video understanding | `tests/inspect-video.test.ts` | `inspect_video` (0.6.1) end-to-end with a faked browser transport only: intent detection (bare link / "react to this" / "is this real?" / "what does the text say?" …), the duration- and intent-aware frame plan (first + final meaningful frames, ending/beginning bias, near-duplicate removal), direct MP4 and TikTok short-link resolution through public redirects, real decoded JPEG frames (magic bytes) as consumable MCP image blocks with `mcp_image_block_N` manifest pointers, question routing into the vision prompts (curated hints, never raw user text), scene + OCR fields from a fake vision model, audio-unavailable honesty with working visual analysis, truthful failures for private/expired/oversized/no-video inputs, and the `visualEvidenceDelivered=false` + `honestyNote` contract that blocks any "I watched it" claim. Plus the MCP surface: discoverable schema/annotations, server `instructions`, and every legacy tool still registered. |
| MCP surface | `tests/mcp-tools.test.ts` | The Worker itself: tool inventory (59 tools incl. every original DEMO tool and the 6 `roblox_account_*` tools), `demo_ping`, utility tools, capability reporting without bindings, URL validation, session validation, auth on `/mcp`, `/health`, `/tools`, `/platform/stats`, screenshot id validation. |
| Roblox OAuth | `tests/roblox-oauth.test.ts` (54 cases) | The real authorization-code + PKCE flow against a stubbed `apis.roblox.com`: `state` mismatch/expiry/replay/browser-binding, cookie flags and `SameSite`, `Origin`/`Sec-Fetch-Site`/host checks, per-route rate limiting, token exchange 400/429/5xx/network failure, `invalid_grant` on the callback, revocation, HTML and JSON error surfaces, and that no client secret, code, verifier or token ever appears in a URL, a response body or a redirect. |
| Roblox account | `tests/roblox-account.test.ts` (28 cases) | Token lifecycle (silent refresh before expiry, single-use rotation persisted, `invalid_grant` → `reauthorization_required` with the profile kept, forced refresh on 401, one bounded retry on 429/5xx with `Retry-After`, scope gate, self-imposed Open Cloud budget, ciphertext at rest, disconnect/revoke incl. unreachable-Roblox), the Durable Object's atomic single-use state redemption / rate counter / refresh lease / expiry sweep, storage selection (DO only with `ROBLOX_TOKEN_KEY`), Worker routing, the MCP account tools (unauthenticated refusal, no token in any result), and a console spy proving no credential reaches a log. |
| Build gate | `tests/worker-build.test.ts` | `wrangler deploy --dry-run` succeeds and the plan contains every binding, including `ROBLOX_AUTH` and its migration. |
| Live (opt-in, 17 cases) | `tests/live.test.ts` (2), `tests/video-live.test.ts` (15) | Real Browser Run: open a page, screenshot to R2, read, snapshot, TikTok short link, plus the video acceptance matrix — `video_ingest` on a stable public MP4 (real frames, MCP image blocks, R2 artifact fetched back and SHA-256 verified) and on a public TikTok URL, `video_inspect_url` on the supplied short link, `inspect_video` on a plain MP4 link (automatic reaction-mode flow, consumable image blocks) and on the supplied short link `https://vt.tiktok.com/ZSqVLjkpU/` (real frames or an explicit failed status with the anti-fabrication honesty note), the 0.7.0 tools live (`video_resolve` byte-verified discovery + access verdict, `video_fetch` streamed artifact fetched back and hash-verified over HTTPS with Range support and `NOT_A_VIDEO` rejection, `video_analyze` image blocks or an explicit "could not", `video_react` evidence package, capability resources), `video_extract_frames` with `resize: { max_width: 320 }` (viewport exactly 320 CSS pixels wide, or the documented resize-failed fallback), and honest structured failures (`blocked_url` on private IPs, stable codes with `frames: []` on missing media). Sandbox egress restrictions are skipped with an explicit note, never asserted as passes or pipeline failures. |

## Fixtures and helpers

* `tests/fixtures/pages.ts` — realistic HTML: a simple page, a login wall, a
  Cloudflare interstitial, a consent banner, an access-denied page, a 404,
  TikTok's verification wall, a TikTok video page with a real
  `__UNIVERSAL_DATA_FOR_REHYDRATION__` payload (video + image-post + no-media
  variants), a legacy `SIGI_STATE` page, TikTok status-code and multi-stream
  pages, an Instagram reel page (video + photo + private + login-wall
  variants), a YouTube watch page (`ytInitialPlayerResponse` with OK / PRIVATE /
  LOGIN_REQUIRED / UNPLAYABLE and ciphered-only variants), an X post page
  (`__NEXT_DATA__` with video, photo-only and protected variants) and a Reddit
  post page (`shreddit-player` + `reddit_video` JSON, image and private-community
  variants).
* `tests/helpers/dom.ts` — `runInPage()` serialises a function exactly like the
  runtime does and executes it inside jsdom, so page scripts are tested against
  a real DOM implementation.
* `tests/helpers/fake-provider.ts` — `FakePage`, `FakeBrowser`, `FakeProvider`
  and `FakeObjectStore`. The fake browser can toggle Live View/handoff support
  and inject launch errors, limits and rate-limit failures.
* `tests/helpers/live.ts` — opt-in live client (Streamable HTTP MCP over
  `fetch`) plus `wrangler dev` bootstrapping.

## Running the live tests

Live tests drive the real Cloudflare Browser Rendering service and consume
browser-minutes, so they only run when explicitly enabled:

```bash
# against a deployed worker
DEMO_MCP_LIVE=1 \
LIVE_WORKER_URL=https://demo-mcp.<subdomain>.workers.dev \
LIVE_API_KEY=<DEMO_API_KEY or unset> \
npm run test:live

# or boot wrangler dev locally (needs Cloudflare credentials)
DEMO_MCP_LIVE=1 \
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
npm run test:live

# video acceptance only (either mode above)
DEMO_MCP_LIVE=1 … npm run test:live:video
```

A copyable template with every variable (placeholders only) lives in
`.env.example`.

Requirements for a meaningful run:

* `BROWSER` (Browser Run) binding — **Workers Paid** for more than 3 concurrent
  sessions / 10 browser-minutes per day.
* `SCREENSHOTS` (R2) binding, otherwise screenshots are reported as unavailable.
* `BROWSER_SESSIONS` (Durable Object) binding, otherwise sessions live only in
  the isolate that handled the request.
* `LIVE_TIKTOK_URL` can point the TikTok test at a specific video; the default
  is a public TikTok video URL. TikTok may block Browser Run traffic — the test
  accepts an honest structured error (stable code, `frames: []`,
  `analysis_ready: false`) as a pass, never a thumbnail.
* `LIVE_PUBLIC_VIDEO_URL` can point the `video_ingest` round-trip test at a
  different fixture; the default is a small, short, DRM-free public MP4.

The video live suite prefights the Worker via `/health` and classifies three
kinds of failure: the **test host** cannot reach the Worker (aborts with an
unambiguous sandbox-egress message), the **Worker** cannot reach the public
source (the test **skips** with a note, since the deployed Worker has normal
outbound access), and the **platform** blocks the Worker (asserted as an honest
structured error). Tests otherwise skip (not fail) when a capability the
environment cannot provide is missing (`capability_unavailable`,
`rate_limited`).

## Verifying Cloudflare compatibility

1. `npm run build:check` — the bundle must build (`Total Upload …`).
2. The build-gate test asserts the same thing inside the suite.
3. Manual audit (kept as a review step): the built Worker must not contain a
   static import of the Node adapter. `puppeteer-core` and `NodeBrowserProvider`
   may appear only inside error strings; `providers/node` must never be imported
   on the Worker path.

## What is deliberately not tested

* No CAPTCHA solving, no anti-bot evasion, no fingerprint spoofing — there is
  nothing to test, by design.
* No fixtures containing real credentials, cookies or tokens; the redaction
  tests use obviously fake secrets.
* No unbounded scraping of video frames — frame sampling is capped in code and
  asserted in tests.
* No live Roblox consent screen. The OAuth suites stub `apis.roblox.com` rather than
  registering an app and clicking "Allow" in CI, so the handshake, the state machine and
  every failure mode are verified offline; the human step (approve consent on
  roblox.com) is the one part that can only be verified by a person on a real browser —
  the walkthrough and the expected result of each route are in
  [`docs/ROBLOX.md`](ROBLOX.md) §6–§7.
