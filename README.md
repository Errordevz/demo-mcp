# DEMO MCP — Cloudflare Browser + Skills Gateway

DEMO MCP is the execution layer behind DEMO Platform. It exposes the MCP endpoint,
skills.sh integration, native utilities and a **real, persistent browser** built on
Cloudflare Browser Rendering (Browser Run) so ChatGPT can open, inspect and
interact with modern websites — including dynamic ones like TikTok — and come back
with structured, visual information.

Everything runs on Cloudflare Workers. No local server, no Docker, no desktop
Chrome, no always-on VM.

## Architecture

```text
ChatGPT / MCP client
        │  (Streamable HTTP MCP)
        ▼
DEMO MCP Worker  ─────────────────────────────────────────────┐
        │                                                     │
        ├── /mcp                 MCP endpoint (stateless)      │
        ├── /health              liveness + capability flags   │
        ├── /tools               tool inventory                │
        ├── /platform/stats      safe telemetry                │
        ├── /screenshots/:id     R2-backed screenshot/frame    │
        ├── /frames/:id          alias for /screenshots/:id    │
        ├── /video-assets/:ref  expiring R2 video/audio artifact│
        ├── /                    inspector UI (demoUi asset)   │
        └── skills.sh (remote)                                 │
                                                              │
   Browser subsystem                                          │
        ├── SessionManager ── Durable Object (BROWSER_SESSIONS)│
        │        └── BrowserRuntime ── BrowserProvider         │
        │                                ├── Cloudflare… (BROWSER binding)
        │                                └── Node… (optional, dev only, lazy)
        ├── ChallengeManager     login walls / consent / CAPTCHA
        ├── ScreenshotManager    capture bounds + R2 storage
        ├── MediaInspector       metadata + rendered video frame sampling
        ├── VideoPipeline         safe resolve/download/audio/transcript orchestration
        └── UrlGuard             SSRF protection
```

Two independent browser layers live side by side:

| Layer | Tools | Use |
| --- | --- | --- |
| **Persistent sessions** (new) | `browser_open`, `browser_screenshot`, `browser_read`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`, `browser_tabs`, `browser_challenge_status`, `browser_pause_for_human`, `browser_resume`, `browser_media_info`, `browser_video_frames`, `browser_session`, `browser_close`, `browser_capabilities` | Multi-step work: open once, then click, type, scroll, wait and re-inspect the *same* rendered page. |
| **One-shot helpers** (original) | `browser_inspect`, `browser_fill`, `browser_press`, `browser_evaluate`, `browser_console`, `browser_run`, `browser_watch`, `browser_task` | Single request = one browser session. Unchanged behaviour; now shares the same provider/limits underneath. |

Both layers talk to the same `BrowserProvider`, so a change in the environment
(a missing binding, a plan limit, a rate limit) is reported the same way
everywhere: a structured `capability_unavailable` / `rate_limited` error, never a
crash.

## Quick start

```bash
npm install

npx wrangler r2 bucket create demo-mcp-screenshots   # once

npm run typecheck     # tsc --noEmit
npm test              # vitest (incl. the wrangler build gate)
npm run deploy        # wrangler deploy
```

Then point ChatGPT (or any MCP client) at:

```text
https://<your-worker>.workers.dev/mcp
```

If `DEMO_API_KEY` is set, send `Authorization: Bearer <DEMO_API_KEY>`.

## Browser tools (persistent sessions)

| Tool | What it does |
| --- | --- |
| `browser_open` | Opens a URL, follows redirects, waits for `load`/`domcontentloaded`/`networkidle`/a selector/a delay, and returns the final URL, title, status, challenge state and tab info. Guards against SSRF. |
| `browser_screenshot` | Viewport, element, or full-page screenshot. Stored in R2; returns a URL (base64 inline is opt-in and size-capped). |
| `browser_read` | Rendered DOM text, HTML (capped), title/URL, metadata, links, headings, forms, media counts, JSON-LD, scroll metrics — with an optional CSS selector scope. |
| `browser_snapshot` | Accessibility tree (`kind: "accessibility"`) or an interactive-element list with `[e12]` refs (`kind: "interactive"`). |
| `browser_click` | Click a CSS selector or a `[ref]` returned by a snapshot. |
| `browser_type` | Type into a field. `secret: true` types without logging or echoing the value. |
| `browser_scroll` | Scroll by pixels or a number of pages in any direction. |
| `browser_wait` | Wait for navigation, a selector, network idle, or a fixed delay. |
| `browser_tabs` | List / open / close / select tabs in the session. |
| `browser_challenge_status` | Current challenge state (login wall, consent, CAPTCHA, access denied, rate limit) plus the last screenshot and current URL. |
| `browser_pause_for_human` | Human-in-the-loop: keep the session alive and return a **Live View** URL (and optional handoff) so a person can solve a CAPTCHA or accept a cookie banner. |
| `browser_resume` | Continue after the human finished (`auto` / `completed` / `abandoned`), re-checking the page state. |
| `browser_media_info` | Public media metadata: OpenGraph/Twitter/meta tags, JSON-LD, `<video>`/`<audio>`/`<source>` elements, images, plus a TikTok-specific extractor. Always lists what it could **not** see. |
| `browser_video_frames` | Samples a bounded number of frames (default 4, max 8) from a *publicly accessible, non-DRM* video element and stores them in R2. |
| `browser_session` | Inspect/refresh/extend/close the current session. |
| `browser_close` | Close the session and release the browser. |
| `browser_capabilities` | What this deployment can do right now, and why not — including plan limits. |

Every result is JSON, bounded in size, and redacted (tokens, cookies, passwords,
authorization headers, e-mails, phone numbers are stripped before logging or
returning).

## Public video understanding

DEMO 0.5 adds a separate public-media pipeline. It is intentionally conservative:
it follows normal HTTP redirects, reads public HTML/JSON/OpenGraph metadata, and
uses a literal media URL only when a normal public request exposes it. It does
not use platform-private APIs or cookies and never solves CAPTCHAs, bypasses login
walls, cracks signed URLs, circumvents DRM, or accesses private accounts.

| Tool | Purpose |
| --- | --- |
| `video_inspect_url` | Resolve TikTok, Instagram, YouTube, X, Reddit, generic pages, or direct media URLs; return bounded metadata, representative timestamps, transcript status, and actual MCP image blocks when frames decode. |
| `video_download_public` | Bounded download to an expiring R2 artifact (`video_<sha256>`), with public redirect, content-type, size, duration and timeout checks. |
| `video_extract_frames` | Seek a public non-DRM HTML5 video and return timestamped JPEG image blocks plus short-lived `/screenshots/` references. |
| `video_extract_audio` | Best-effort browser `captureStream`/`MediaRecorder` extraction of a decoded audio track into an expiring `audio_<sha256>` artifact. |
| `video_transcribe` | Use an optional server-side Workers AI Whisper binding or configured HTTPS provider and return timestamped segments; no speech is `no_speech_detected`. |
| `video_analyze` | Return frame-grounded scene/OCR/object/action fields. Without successfully decoded frames and a configured vision model it explicitly reports unavailable instead of guessing. |
| `video_get_frame` | Return one actual frame at a requested timestamp as an MCP image content block when it fits the inline cap. |

### AI visibility is explicit

Video frames are not returned as an opaque filesystem path. When a decoded frame is
at most `LIMITS.inlineImageMaxBytes`, the MCP result contains a native `type:
"image"` content item with base64 image data. Larger frames are stored in R2 and
returned as a high-entropy, expiring `image_reference`; the structured result
still includes its timestamp, MIME type and byte count. If neither delivery path
is possible, the tool returns `FRAMES_UNAVAILABLE` and does **not** say it saw the
video. `video_inspect_url` sets `analysis_ready` only after at least one actual
frame was captured.

### Public-video safety and limits

* Only `http`/`https` URLs pass the existing SSRF guard. Every redirect and every
  media candidate is checked again; localhost, private/link-local/metadata IPs,
  internal suffixes and infrastructure ports are denied. Video hostname DNS
  verification fails closed when enabled.
* No request sends caller cookies or authorization headers. Downloaded content is
  limited to 50 MiB by default (`VIDEO_MAX_DOWNLOAD_MB`), 600 seconds
  (`VIDEO_MAX_DURATION_SECONDS`), five redirects, bounded HTML, and finite
  request timeouts. A duration that cannot be verified for a download is rejected
  rather than silently exceeding policy.
* Frames are capped at eight per call. Audio capture is capped at 120 seconds and
  8 MiB. A best-effort isolate-local rate limit (`VIDEO_RATE_LIMIT_PER_MINUTE`)
  protects expensive browser work; Cloudflare plan limits remain authoritative.
* Temporary video/audio artifacts use content-addressed keys in the existing R2
  bucket by default (`video-artifacts/<kind>/<sha256>`), expose only expiring
  `/video-assets/video_<sha256>` or `audio_<sha256>` references, and are cleaned
  by the hourly Worker cron plus expiry checks on access. Configure a separate
  `VIDEO_ARTIFACTS` R2 binding if desired; no new binding is required for the
  current deployment.

### Platform behavior

TikTok short links such as `https://vt.tiktok.com/...` are first resolved through
normal public redirects. Instagram, YouTube, X and Reddit are handled through the
same public HTML/media candidates rather than platform API credentials. A page may
expose only a thumbnail, a login wall, a bot challenge, an HLS playlist, or a
signed URL that has already expired. DEMO returns a stable error such as
`VIDEO_NOT_FOUND`, `VIDEO_NOT_PUBLIC`, `PLATFORM_BLOCKED`, `UNSUPPORTED_MEDIA`,
`DOWNLOAD_TOO_LARGE`, `PROCESSING_TIMEOUT`, or `FRAMES_UNAVAILABLE`, with the
technical limitation and the final public URL when safe. A thumbnail is never
labeled as a video frame.

See [`docs/VIDEO.md`](docs/VIDEO.md) for the processing contract and deployment
notes.

### Human in the loop (challenges)

DEMO never solves CAPTCHAs and never tries to defeat anti-bot systems. The flow
is deliberately human:

```text
browser_open        → status: "challenge_required", kind: "captcha"
browser_pause_for_human → { liveViewUrl, instructions, expiresInMs, state: "waiting_for_human" }
        … a person opens the Live View URL, solves the CAPTCHA, clicks "Done" …
browser_resume      → { resumed: true, challengeCleared: true, finalUrl }
```

If the human walks away, `browser_resume` with `action: "abandoned"` closes the
handoff cleanly and the tool says so. Sessions are kept alive with
`keep_alive` heartbeats (default 5 min, max 10 min per Cloudflare), and the state
lives in a Durable Object so the next MCP request can re-attach to the same
browser via `puppeteer.connect(env.BROWSER, sessionId)`.

### TikTok

* `video_inspect_url` is the acceptance path for the public short URL
  `https://vt.tiktok.com/ZSq4b6A3K/`: it follows the short-link redirect, probes
  only literal public media URLs, and asks Browser Run for decoded frames. If the
  current TikTok response is a bot challenge or the media URL is not playable,
  the result is still useful and honest, for example:

  ```json
  {
    "success": false,
    "error": "PLATFORM_BLOCKED",
    "challenge": { "detected": true, "kind": "bot_challenge_or_access_denied" },
    "frames": [],
    "analysis_ready": false,
    "message": "The platform returned ... instead of a public media page."
  }
  ```

  A result with `success: true`, non-empty `frames`, and MCP `image` content is
  the stronger outcome: it proves DEMO exposed decoded video pixels rather than
  only creator/caption/statistics/thumbnail metadata.
* `https://www.tiktok.com/@user/video/<id>` and short links
  (`https://vt.tiktok.com/…`, `https://vm.tiktok.com/…`, `https://m.tiktok.com/v/<id>.html`)
  are resolved by following redirects to the canonical URL.
* Public metadata is read from the rendered page: `__UNIVERSAL_DATA_FOR_REHYDRATION__`,
  the legacy `SIGI_STATE`, and OpenGraph/`<meta>` tags as a fallback — author,
  nickname, caption, hashtags, video/photo id, thumbnail, duration, dimensions,
  playable URL, stats, music, creation time.
* `<video>` detection, screenshots of the rendered page, and frame sampling from
  whichever video element the page exposes.
* When TikTok serves a verification wall, requires login, or simply does not
  expose a playable URL, the tool returns that honestly in `limitations` /
  `challenge` instead of inventing data. Cloudflare Browser Run is always
  identified as bot traffic, so some pages will block it regardless of what we
  do — the tools report that rather than hiding it.

## Configuration

Bindings (`wrangler.jsonc`):

| Binding | Type | Purpose |
| --- | --- | --- |
| `BROWSER` | Browser Rendering (Browser Run) | The real browser. **Required** for any browser tool. |
| `SCREENSHOTS` | R2 bucket (`demo-mcp-screenshots`) | Screenshot + frame storage. |
| `BROWSER_SESSIONS` | Durable Object (`BrowserSession`) | Session/tab state across requests. |

Variables (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_API_KEY` | *(unset)* | Bearer token required on `/mcp`. Unset = open. |
| `DEMO_PLATFORM_ORIGIN` | `https://demo-platform.pages.dev` | CORS allowlist for Platform. |
| `BROWSER_PROVIDER` | `cloudflare` | `cloudflare` or `node` (node = local dev only). |
| `BROWSER_KEEPALIVE_MS` | `300000` | Session keep-alive heartbeat (10 s – 10 min). |
| `SCREENSHOT_BASE_URL` | request origin + `/screenshots` | Public base URL for screenshot links. |
| `SSRF_DNS_CHECK` | `true` | Resolve hostnames via DoH and block private/internal answers. |
| `SSRF_DNS_FAIL_OPEN` | `true` | If the resolver is unreachable, allow navigation with a `dns-unverified` warning. Set to `false` to deny instead. |
| `BROWSER_ALLOWED_DOMAINS` | *(unset)* | Optional comma-separated domain allowlist latched per browser session. |
| `VIDEO_MAX_DOWNLOAD_MB` | `50` | Maximum public video download size. |
| `VIDEO_MAX_DURATION_SECONDS` | `600` | Maximum duration accepted for processing/downloads. |
| `VIDEO_ARTIFACT_TTL_SECONDS` | `3600` | TTL for video/audio/frame artifacts (also enforced on reads). |
| `VIDEO_RATE_LIMIT_PER_MINUTE` | `12` | Best-effort per-source expensive-operation limit per Worker isolate. |
| `VIDEO_TRANSCRIPTION_MODEL` | `@cf/openai/whisper` | Workers AI model used when optional `AI` is bound. |
| `VIDEO_VISION_MODEL` | `@cf/llava-hf/llava-1.5-7b-hf` | Optional Workers AI vision model for `video_analyze`. |
| `TRANSCRIPTION_ENDPOINT` | *(unset)* | Optional HTTPS speech-to-text endpoint; API key stays in the Worker secret `TRANSCRIPTION_API_KEY`. |

`AI` and `VIDEO_ARTIFACTS` are optional bindings. The current deployment reuses
`SCREENSHOTS` for temporary video artifacts so adding these bindings is not
required. If `AI` is not bound, frame extraction still works, while transcription
and model-based OCR/object/action labels return `TRANSCRIPTION_UNAVAILABLE` or
an explicit analysis limitation.

## Limits (Cloudflare Browser Rendering)

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Concurrent browser sessions | 3 | 200 |
| New sessions | 1 per 20 s | 3 per second |
| Inactivity timeout | 60 s (extendable to 10 min with `keep_alive`) | same |
| Browser minutes | 10 / day | metered |

DEMO reports these limits through `browser_capabilities` and surfaces
`rate_limited` errors (with the retry hint) instead of hanging.

## Security

* **SSRF protection** — only `http(s)` is allowed; localhost, literal private
  IPs (including obfuscated decimal/octal/hex forms and IPv6 ULA/link-local),
  the Cloudflare metadata endpoint (`169.254.169.254`, `metadata.google.internal`,
  `*.internal`, `*.local`), and infra-only ports are blocked. Hostnames are
  resolved over DNS-over-HTTPS and re-checked, so a public name that resolves to
  a private address is refused too.
* **Timeouts and bounds** — navigation, operation and wait timeouts; capped
  screenshots (viewport/full page/element), capped text/HTML/JSON-LD output,
  bounded frame sampling, and per-session tab limits.
* **Secrets** — `secret: true` inputs are never logged; all logs pass through a
  redactor that strips bearer tokens, cookies, `password`/`token`/`api_key`
  values, PEM blocks, e-mails and phone numbers. Screenshot ids are
  high-entropy and unguessable; the bucket is never listed.
* **Auth preserved** — `DEMO_API_KEY` behaviour, the `/mcp` endpoint, existing
  routes and every original tool are unchanged.

## Testing

```bash
npm test              # 100+ unit/integration tests, including a wrangler build gate
npm run typecheck     # tsc --noEmit (src + tests)
DEMO_MCP_LIVE=1 CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run test:live
```

* Unit/Integration (no network): SSRF guard, redaction, challenge detection,
  page scripts (real DOM via jsdom), snapshots, TikTok payload parsing, media
  reports, frame sampling, session/tab/challenge flows, and the HTTP + MCP
  surface (tool inventory, auth, routes, graceful capability errors).
* Build gate: `wrangler deploy --dry-run` must succeed and must not pull any
  Node-only code into the Worker bundle.
* Live: opt-in tests that drive the real Browser Run service.

See [`docs/BROWSER.md`](docs/BROWSER.md) for the subsystem design and
[`docs/TESTING.md`](docs/TESTING.md) for the test matrix.

## Skills

DEMO continues to search, fetch, audit and apply skills from skills.sh. Skills
are treated as instruction material and cannot override system, developer,
safety or user instructions. DEMO does not execute arbitrary installer commands
merely because a skill requests them.

## Screenshot delivery

Screenshot binaries are **not** returned as MCP image payloads by default. They
are stored in R2 and returned as a URL such as:

```text
https://demo-mcp.www-notamirrblx.workers.dev/screenshots/<high-entropy-id>
```

This keeps large image bytes out of the ChatGPT tool result. `inline_base64` is
available but capped (`LIMITS.inlineImageMaxBytes`) and disabled by default.
Configure an R2 lifecycle rule if you want automatic deletion.
