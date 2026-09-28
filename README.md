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
        ├── /.well-known/*    public OAuth metadata (resource + authorization server)
        ├── /oauth/{authorize,token,revoke}  ChatGPT → DEMO OAuth 2.1 + PKCE
        │        └── MCP_AUTH Durable Object (hashed codes/tokens, consent, revocation)
        ├── /oauth/roblox/*   separate DEMO → Roblox OAuth 2.0 + PKCE
        │        └── RobloxAuth Durable Object (encrypted grants, single-use state)
        ├── /capabilities/jev  Jev decision-engine report (presence + policy only)
        ├── /capabilities/laya Laya decision-provider report (presence + policy only)
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
        ├── JevDecisionEngine     TypeSafe structured decisions (advisory, opt-in)
        ├── LayaDecisionProvider  external Laya typed-decision server (advisory, opt-in)
        │        └── DecisionRouter  auto: Laya → Jev → deterministic fallback
        └── UrlGuard             SSRF protection (applies to LAYA_BASE_URL too)
```

Two independent browser layers live side by side:

| Layer | Tools | Use |
| --- | --- | --- |
| **Persistent sessions** (new) | `browser_open`, `browser_screenshot`, `browser_read`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`, `browser_tabs`, `browser_challenge_status`, `browser_pause_for_human`, `browser_resume`, `browser_captcha_handoff`, `browser_captcha_wait`, `browser_captcha_cancel`, `browser_media_info`, `browser_video_frames`, `browser_session`, `browser_close`, `browser_capabilities` | Multi-step work: open once, then click, type, scroll, wait and re-inspect the *same* rendered page. |
| **One-shot helpers** (original) | `browser_inspect`, `browser_fill`, `browser_press`, `browser_evaluate`, `browser_console`, `browser_run`, `browser_watch`, `browser_task` | Single request = one browser session. Unchanged behaviour; now shares the same provider/limits underneath. |

Both layers talk to the same `BrowserProvider`, so a change in the environment
(a missing binding, a plan limit, a rate limit) is reported the same way
everywhere: a structured `capability_unavailable` / `rate_limited` error, never a
crash.

## Inspector UI (`/`)

The Worker serves a self-contained inspector at `/` (`ui.ts` + `src/ui/*`): a
minimal, zero-dependency developer console for the deployment — a compact
Overview hero with live status, six capability categories, a searchable tool
explorer (`#/capabilities`, with the legacy `#/tools` route kept working), a
dedicated System Status page (`#/status`), in-depth Browser/Video/Research/
Routing/Roblox/Skills/About sections, a command palette (`Ctrl/⌘+K`), a
mobile menu, a polished 404 for unknown routes, and a **Connect MCP** dialog.
That dialog launches only verified official handoffs: Claude's documented
custom-connector install link, Cursor's `cursor://` MCP install deeplink, and
VS Code's `vscode:mcp/install` URL. ChatGPT opens the documented Plugins page
(`https://chatgpt.com/plugins`) — OpenAI does not document a prefilled install
URL. Claude Code and any other client get the documented command or a copyable
endpoint. The public URL is `https://demo-mcp.amidevz.workers.dev/mcp`. See
`docs/CONNECT-MCP.md`.

The UI is dark-first with a light theme following the OS preference, built on
design tokens in `src/ui/styles.ts` (no UI framework, no external requests).

Design invariants (enforced by `tests/ui-shell.test.ts`):

* **Public tools need no login.** DEMO has no mandatory signup or account system;
  initialization, discovery, resources, the inspector, and public tools stay open.
  The Connect MCP dialog contains no credentials. Only account-specific Roblox
  tools and paid `jev_decide` trigger per-tool DEMO OAuth; Roblox consent is a
  separate optional approval in the Roblox section.
* **No mocking.** Every status, count and flag is read live from same-origin
  routes (`/health`, `/platform/stats`, `/capabilities/*`, `/oauth/roblox/*`).
  Unreachable data renders an honest error state instead of fake values.
* **No secrets.** Telemetry presence booleans only — keys, tokens, cookies and
  env values never reach the page. The strict CSP (`default-src 'none'`,
  `connect-src 'self'`, inline style/script only, no external requests) is
  locked down by `tests/security-hardening.test.ts`.

The tool catalog shown in the explorer is **generated** from the real
registrations: run `npm run ui:catalog` after adding/renaming a tool and
`tests/tool-catalog.test.ts` will fail if the catalog drifts from
`DEMO_TOOL_NAMES`.

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

`/mcp` stays public: initialization, discovery, resources and public tools
(including `demo_ping`, `roblox_user`, and `roblox_game`) work without login or an
Authorization header. Account-specific `roblox_account_*` tools and paid
`jev_decide` are protected individually with short-lived DEMO OAuth 2.1/PKCE
scopes. ChatGPT should use **Mixed Authentication**: public tools are `noauth`,
protected tools are `oauth2`. A protected grant identifies a user; it does not
connect Roblox. Roblox requires a separate official consent flow. See
[`docs/MCP-OAUTH.md`](docs/MCP-OAUTH.md) and [`docs/ROBLOX.md`](docs/ROBLOX.md).

Live ChatGPT connector compatibility has not yet been exercised. Do not rely on
the protected flow until you deploy the configuration and verify the first
protected-tool challenge in your ChatGPT account.

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
| `browser_captcha_handoff` | Start the structured CAPTCHA/bot-check handoff: pause automation, keep the **same** session/tab alive, open a Live View, store a resumable task snapshot and switch on the `RUNNING → CAPTCHA_DETECTED → HUMAN_HANDOFF → …` state machine. |
| `browser_captcha_wait` | Watch the open handoff (bounded window per call, no reloads, no session rotation) until the challenge is completed (automatic resume), failed, timed out, cancelled or the session died. |
| `browser_captcha_cancel` | Explicitly abandon an open handoff; the session and its tabs stay untouched. |
| `browser_media_info` | Public media metadata: OpenGraph/Twitter/meta tags, JSON-LD, `<video>`/`<audio>`/`<source>` elements, images, plus a TikTok-specific extractor. Always lists what it could **not** see. |
| `browser_video_frames` | Samples a bounded number of frames (default 4, max 8) from a *publicly accessible, non-DRM* video element and stores them in R2. |
| `browser_session` | Inspect/refresh/extend/close the current session. |
| `browser_close` | Close the session and release the browser. |
| `browser_capabilities` | What this deployment can do right now, and why not — including plan limits. |

Every result is JSON, bounded in size, and redacted (tokens, cookies, passwords,
authorization headers, e-mails, phone numbers are stripped before logging or
returning).

## Roblox account (OAuth 2.0 + PKCE)

On top of the public `roblox_user` / `roblox_game` lookups, DEMO can hold **your own
Roblox account authorization** and answer questions about it through Roblox's official
OAuth 2.0 + Open Cloud APIs. The whole setup and the whole sign-in flow happen in a
browser — nothing to install, and it works from an iPhone (see
[`docs/ROBLOX.md`](docs/ROBLOX.md)).

| Tool | DEMO OAuth scope | What it does |
| --- | --- | --- |
| `roblox_account_status` | `roblox:read` | Connection state for the authenticated DEMO user, granted Roblox scopes, expiry and safe storage status. Never a credential. |
| `roblox_account_link_start` | `roblox:link` | Creates a five-minute, single-use code for the separate Roblox consent flow. |
| `roblox_account_profile` | `roblox:read` | Identity from `GET /oauth/v1/userinfo`; `extended: true` adds Open Cloud `GET /cloud/v2/users/{id}` when the Roblox scope allows. |
| `roblox_account_inventory` | `roblox:read` | Owned items via `GET /cloud/v2/users/{id}/inventory-items`, or an explicit ownership verdict for `assertAssetIds`. |
| `roblox_account_avatar_thumbnail` | `roblox:read` | Your own avatar image through the documented Open Cloud long-running operation. |
| `roblox_account_capabilities` | `roblox:read` | Per-action matrix: what Roblox's OAuth/Open Cloud APIs allow here, and the reason when they do not (`not_supported` — no scraping fallback, ever). |
| `roblox_account_unlink` | `roblox:disconnect` | Best-effort `POST /oauth/v1/token/revoke` and delete only this user's encrypted grant. |

The Roblox browser routes are a separate OAuth 2.0 client, started only after
ChatGPT has created a user-bound DEMO grant:

```text
GET  /oauth/roblox/link       → Access-authenticated one-time-code form
POST /oauth/roblox/start      → consumes the code; redirects to Roblox with state + PKCE S256
GET  /oauth/roblox/callback   → single-use state and server-side code exchange; no login cookie
GET  /oauth/roblox/status    → the verified Access user's status only (no secrets)
POST /oauth/roblox/logout    → same-site disconnect; deletes the user's grant and best-effort revokes Roblox
```

**Connect Roblox:** first add DEMO to ChatGPT with Mixed Authentication and authorize
`roblox:link`; call `roblox_account_link_start`, open its `linkUrl` in a browser signed
in to the same Cloudflare Access identity, paste the returned one-time `linkCode`, then
approve requested scopes on Roblox's official consent screen. **Disconnect Roblox:**
call `roblox_account_unlink` (scope `roblox:disconnect`) or use the signed-in DEMO UI's
Disconnect control. Removing the ChatGPT connector is separate and does not unlink
Roblox. See [`docs/ROBLOX.md`](docs/ROBLOX.md) for setup and troubleshooting.

The protected Roblox tools derive their storage key from the server-verified
Cloudflare Access subject behind the DEMO token. They never accept a user ID,
slot, or account selector. Roblox access/refresh/ID tokens are encrypted with
AES-256-GCM in the `ROBLOX_AUTH` Durable Object using `ROBLOX_TOKEN_KEY`; without
both the Durable Object and key, protected linking and account operations fail
closed. Refresh-token rotation is persisted atomically. The Roblox client checks
scopes before upstream calls, bounds retries, and never exposes token material.

Both approvals are required: ChatGPT → DEMO OAuth grants tool permissions;
DEMO → Roblox OAuth grants Roblox access. They are independent. No Roblox
password, `.ROBLOSECURITY` cookie, or unofficial endpoint is accepted.

## Public video understanding

DEMO 0.5 adds a separate public-media pipeline, DEMO 0.6.1 adds
**automatic video viewing, understanding and natural reactions** on top of it
(`inspect_video`), and DEMO 0.7.0 adds the **real retrieval pipeline**:
`video_resolve`, `video_fetch`, a unified mode-aware `video_analyze`,
`video_react` and runtime capability discovery. The pipeline is intentionally conservative:
it follows normal HTTP redirects, reads public HTML/JSON/OpenGraph metadata, and
uses a literal media URL only when a normal public request exposes it. It does
not use platform-private APIs or cookies and never solves CAPTCHAs, bypasses login
walls, cracks signed URLs, circumvents DRM, or accesses private accounts.

| Tool | Purpose |
| --- | --- |
| `video_resolve` | **(0.7.0)** Resolve a public video URL — including TikTok `vt.`/`vm.` short links — into canonical URL, video id, creator, caption, duration and every literal stream URL the page publishes, each with its own byte-signature probe verdict, plus an honest `access_status` (`public`, `deleted`, `private`, `login_required`, `region_restricted`, `challenge_required`, `rate_limited`, `not_found`, `expired`, `blocked_url`, `unsupported`, `unavailable`), guidance and next steps. Downloads nothing; never bypasses a CAPTCHA, login wall, DRM or private account. |
| `video_fetch` | **(0.7.0)** Retrieve the **actual video bytes**: the body is streamed into expiring R2 (never buffered whole, never on disk), the first 128 KiB must prove a real video container, and the duration policy is verified from page metadata or the container header. HTML/JSON/thumbnail/audio-only/manifest responses fail with `NOT_A_VIDEO` or `UNSUPPORTED_MEDIA` and the partial object is deleted. |
| `video_analyze` | **(0.7.0, unified)** resolve → retrieve → frames → optional audio/transcript → one structured evidence result. `analysis_mode`: `summary` \| `detailed` \| `reaction` \| `fact_check_visual` \| `transcript` \| `full`. Keeps a real speech-to-text transcript, the creator's post caption and DEMO-generated text strictly separate, and reports exactly what can and cannot be answered. |
| `video_react` | **(0.7.0)** Grounded evidence package for *the connected model* to react from: real decoded frames as MCP image blocks, transcript when available, style guidance (`casual` \| `funny` \| `serious` \| `detailed`). `reaction` is always `null` and `reaction_author` is `connected_model` — there are no canned reactions anywhere in this repo. |
| Capability discovery | **(0.7.0)** `demo://capabilities/video` + `demo://video/honesty-contract` MCP resources, `GET /capabilities/video`, and flags in `demo_ping`/`/health`: which platforms are supported, whether real bytes/frames/audio/transcription are available in *this* deployment, which optional providers are configured (names only), the enforced limits and the security policy. |
| `inspect_video` | **The one high-level tool for "watch this" requests (0.6.1)**: the connected AI calls it automatically when a user sends a video URL and asks "What do you think?", "React to this.", "Is this real?", "What happens at the end?" — or sends only the link. It resolves the platform + actual video, derives reaction mode and analysis focus from the user's message, plans a duration/intent-aware frame budget (first, middle, final + focus-biased moments), decodes real frames in Browser Rendering, and returns them as MCP image content blocks plus structured context (source, detected scenes, on-screen text, honest `audioStatus`, `inspectionStatus`). See below. |
| `video_ingest` | **One-call ingestion of a public video URL** (incl. TikTok `www`/`vm`/`vt` links): safe redirect resolution, bounded download to an expiring R2 artifact, Browser Run frame decoding, optional audio/transcript, and a single structured result with MCP image blocks + artifact URLs. `output_mode`: `frames` \| `video_artifact` \| `analysis` \| `all`. |
| `video_inspect_url` | Resolve TikTok, Instagram, YouTube, X, Reddit, generic pages, or direct media URLs; return bounded metadata, representative timestamps, transcript status, and actual MCP image blocks when frames decode. |
| `video_download_public` | Bounded download to an expiring R2 artifact (`video_<sha256>`), with public redirect, content-type, size, duration and timeout checks. |
| `video_extract_frames` | Seek a public non-DRM HTML5 video and return timestamped JPEG image blocks plus short-lived `/screenshots/` references. |
| `video_extract_audio` | Best-effort browser `captureStream`/`MediaRecorder` extraction of a decoded audio track into an expiring `audio_<sha256>` artifact. |
| `video_transcribe` | Use an optional server-side Workers AI Whisper binding or configured HTTPS provider and return timestamped segments; no speech is `no_speech_detected`. |
| `video_extract_frames` extras | **(0.7.0)** `interval_seconds` / `max_frames` aliases and an optional `resize` bound (applied by scaling the Browser Rendering viewport — no Worker-side image codec); every frame reports the pixel size it actually has. |
| `video_get_frame` | Return one actual frame at a requested timestamp as an MCP image content block when it fits the inline cap. |
| `video_inspect_pipeline` | **Diagnostic**: runs URL validation → redirect resolution → media discovery → browser access → media retrieval (64 KiB sample) → frame extraction → R2 round trip → artifact URL generation → MCP serialization, and reports exactly which stage failed. No key or Authorization header required. Never returns secrets. |

### Automatic video viewing & reactions (`inspect_video`, DEMO 0.6.1)

The user only sends the link. No manual downloading, frame extraction,
screenshot uploading, timestamps, or chained tool calls.

```text
User sends video URL ("React to this: https://vt.tiktok.com/…" or just the link)
        ↓
AI detects the message contains a video (server instructions + tool description)
        ↓
AI automatically calls inspect_video { url, userIntent, question? }
        ↓
DEMO resolves the platform + actual video (short links, redirects, pages, direct files)
        ↓
DEMO plans frames (duration + intent aware) and decodes them in Browser Rendering
        ↓
DEMO returns MCP image content blocks + structured analysis context
        ↓
AI vision model examines the actual frames
        ↓
AI answers the intent naturally (genuine reaction, honest about uncertainty)
```

Input schema (all optional except `url`):

```json
{
  "url": "https://vt.tiktok.com/ZSqVLjkpU/",
  "userIntent": "React to this",
  "question": "Is this real?",
  "reactionMode": null,
  "frameCount": null,
  "timestamps": null,
  "includeMetadata": true,
  "includeAudio": false,
  "analyzeScenes": true,
  "analyzeOnScreenText": true
}
```

Automatic defaults:

* **`reactionMode`** — auto-enabled when the user says "react", "what do you
  think", "look at this", "watch this", "rate the vibe" (💀-style emoji
  included) **or sends only the link**; an explicit boolean always wins.
* **`frameCount`** — chosen from the decoded/known duration: 5–8 frames under
  10 s, 8–12 up to a minute, up to 16 for longer videos (strict pipeline cap).
* **Frame selection** — always includes the first and final meaningful frames,
  even coverage in between, near-duplicates removed; "what happens at the end?"
  packs extra frames into the final quarter, "how does it start?" into the
  first. Explicit `timestamps` override the plan.
* **`analyzeScenes` / `analyzeOnScreenText`** — on by default; populated from
  frame-grounded vision analysis when a server-side model is configured, and
  reported as unavailable (never guessed) otherwise. The raw frames always
  travel as MCP image blocks so the *calling* vision model can read text and
  scenes itself.
* **`includeAudio`** — opt-in; attempted only through the existing
  Cloudflare-compatible browser capture path (`captureStream`/`MediaRecorder`),
  with optional speech-to-text afterwards. `audioStatus` is reported honestly as
  `"available" | "unavailable" | "failed"` and visual analysis never depends on
  it. Dialogue is never fabricated.

Result shape (JSON manifest inside the MCP `text` item; the decoded JPEG frames
travel as separate `type: "image"` content blocks in frame order):

```json
{
  "tool": "inspect_video",
  "inspectionStatus": "complete",
  "source": { "platform": "tiktok", "url": "https://vt.tiktok.com/…", "durationSeconds": 9.2, "width": 720, "height": 1280 },
  "intent": { "userIntent": "React to this", "question": null, "reactionMode": true, "focus": "reaction" },
  "frames": [
    { "timestamp": 0.184, "image": "mcp_image_block_0", "mimeType": "image/jpeg", "bytes": 98213, "imageReference": "https://demo-mcp.<sub>.workers.dev/screenshots/<id>", "sceneDescriptionHint": null }
  ],
  "detectedScenes": [{ "start": 0.184, "end": 4.6, "significance": "hard cut from a calm wide shot to a close-up" }],
  "extractedText": ["WAIT FOR IT"],
  "audioStatus": null,
  "framesDelivered": 7,
  "imageBlocksDelivered": 7,
  "visualEvidenceDelivered": true,
  "limitations": ["…"],
  "honestyNote": "7 real decoded frame(s) were delivered … sampled frames, not continuous playback …",
  "responseGuidance": "Reaction mode: … react naturally to what actually happens …"
}
```

Honesty contract (enforced by the payload itself):

* `visualEvidenceDelivered` is `true` **only** when real decoded frames were
  returned; thumbnails, cover images, metadata, timestamps, MP4 URLs and webpage
  screenshots never count.
* `inspectionStatus` is `complete` (every planned frame decoded and delivered as
  inline image blocks), `partial` (some evidence — e.g. frames delivered but
  reference-only, fewer frames than planned, or audio failed) or `failed` (no
  frames; returned as an MCP error with a stable code).
* `honestyNote` tells the AI exactly what it may claim: with frames, it may
  describe what is visible but must not claim continuous playback or invent
  audio; without frames it **MUST NOT** claim to have seen the video at all.
* The MCP server `instructions` (sent at initialize) plus the tool description
  teach ChatGPT-like clients to call `inspect_video` automatically and to answer
  with a natural, tone-matched reaction instead of a robotic metadata dump.

Expected behaviour examples:

```text
User: https://example.com/video.mp4
AI:   "💀 The sudden movement at the end is what makes this so unsettling. …
       I can't verify whether it's real or staged from the frames alone."

User: React to this: https://example.com/video.mp4
AI:   "NAH 💀😭 The timing of that reveal is ridiculous. …"

User: What happens in this?
AI:   "The clip shows a person walking toward the camera. Around the middle,
       another person enters from the side… I couldn't verify the audio."
```

The AI is never forced into exaggerated slang — `responseGuidance` asks it to
match the user's tone while staying accurate.

### AI visibility is explicit

Video frames are not returned as an opaque filesystem path. When a decoded frame is
at most `LIMITS.inlineImageMaxBytes`, the MCP result contains a native `type:
"image"` content item with base64 image data. Larger frames are stored in R2 and
returned as a high-entropy, expiring `image_reference`; the structured result
still includes its timestamp, MIME type and byte count. If neither delivery path
is possible, the tool returns `FRAMES_UNAVAILABLE` and does **not** say it saw the
video. `video_inspect_url` sets `analysis_ready` only after at least one actual
frame was captured.

**What the connected AI client actually receives** from `video_ingest` (the
payload shown here is the JSON inside the MCP `text` content item; the decoded
JPEGs additionally travel as separate `type: "image"` content items):

```json
{
  "success": true,
  "source_url": "https://vt.tiktok.com/ZSq4b6A3K/",
  "resolved_url": "https://www.tiktok.com/@creator/video/7300000000000000001",
  "media_url": "https://v16-webapp-prime.tiktok.com/video/tos/.../clip.mp4",
  "platform": "tiktok",
  "media_type": "video",
  "output_mode": "all",
  "duration_seconds": 12.4,
  "width": 1080,
  "height": 1920,
  "mime_type": "video/mp4",
  "frames": [
    { "timestamp_seconds": 0, "mime_type": "image/jpeg", "url": "https://demo-mcp.<sub>.workers.dev/screenshots/screenshots/<id>", "bytes": 182441, "inspected": true },
    { "timestamp_seconds": 6.2, "mime_type": "image/jpeg", "url": "https://demo-mcp.<sub>.workers.dev/screenshots/screenshots/<id>", "bytes": 176209, "inspected": true }
  ],
  "video_artifact": {
    "mime_type": "video/mp4",
    "url": "https://demo-mcp.<sub>.workers.dev/video-assets/video_<sha256-hex-64>",
    "reference": "video_<sha256-hex-64>",
    "bytes": 2411552,
    "sha256": "<sha256-hex-64>",
    "expires_at": "2026-09-15T20:00:00.000Z"
  },
  "audio": null,
  "transcript": null,
  "analysis_ready": true,
  "challenge": { "detected": false, "kind": null, "reason": null },
  "limitations": ["Frames are screenshots of the rendered video element..."],
  "visibility_note": "Actual decoded frame images are included as MCP image content blocks. Frame url values are short-lived R2 retrieval links; video_artifact.url is a short-lived R2 media link."
}
```

Notes:

* A frame with `"inspected": true` was decoded by the browser; thumbnails and
  OpenGraph images are never placed in `frames`.
* `video_artifact.url` is **not** a local path — it is an expiring R2 object
  (1 hour by default) served at `/video-assets/<reference>`; the live
  acceptance test fetches it back and verifies the SHA-256.
* `visibility_note` denies success whenever no inline image block was
  returned, so a client can never mistake a URL for "I can see the video" when
  it cannot inspect it.

### Why a restricted sandbox fails while the deployed live test passes

The pipeline has two distinct network actors:

1. **The test host** (your laptop, CI, or a restricted sandbox) talks to the
   Worker's `/mcp` endpoint.
2. **The Worker** talks to the public video source.

A sandbox with restricted outbound DNS/TLS breaks step 2 (and sometimes step
1): the SSRF guard's DNS-over-HTTPS verification fails closed, so the honest
result is `blocked_url` / `PROCESSING_TIMEOUT` with `frames: []` — *not* a
pipeline bug. The live test suite therefore:

* prefights the Worker (`/health`) and reports an unambiguous
  "test host cannot reach the Worker" message instead of misleading failures;
* **skips** (with a printed note) when the Worker's own egress to the source
  fails in a restricted environment, because the deployed Worker has normal
  outbound access;
* **passes** when a platform (e.g. TikTok) blocks the Worker, as long as the
  response is an explicit structured error with zero fabricated frames.

To verify locally without deployment, `npm run build:check` plus the offline
suite (`npm test`) cover the resolver, SSRF guard, artifact store, frame
mapping, MCP serialization and stage reporting — only the
*transport* (Browser Run) is faked, with jsdom page scripts.

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
* Frames are capped at sixteen per call for the public video pipeline
  (`inspect_video`'s dynamic plan stays inside 5–16 by duration; browser-session
  `browser_video_frames` sampling remains capped at eight). Audio capture is capped at 120 seconds and
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

### CAPTCHA human handoff (structured workflow)

For CAPTCHA / bot-verification pages specifically, `browser_captcha_handoff`
runs the full suspend → handoff → auto-resume workflow on top of the primitives
above. The same Durable Object session, Live View and handoff systems are used —
there is no second browser implementation.

```text
browser_captcha_handoff → { phase: "HUMAN_HANDOFF", liveViewUrl, task, deadline,
                            userNotice: "CAPTCHA detected. Demo is paused. Please complete
                            the verification in the live browser." }
        … the user completes the challenge in the live browser; the DO alarm and
          browser_captcha_wait keep checking (no reloads, no identity changes) …
browser_captcha_wait    → { outcome: "completed_and_resumed", phase: "RUNNING",
                            task: { workflow, step, context } }   ← resume the task here
```

State machine (`src/browser/handoff.ts`):
`RUNNING → CAPTCHA_DETECTED → HUMAN_HANDOFF → USER_INTERACTING → CAPTCHA_COMPLETED → RESUMING → RUNNING`,
with terminal states `FAILED` (human attempt ended, challenge still present),
`TIMEOUT` (deadline passed), `CANCELLED` (explicit `browser_captcha_cancel`) and
`SESSION_LOST` (browser died mid-handoff). Every transition is recorded as a
structured event (`captcha_detected`, `human_handoff_started`,
`human_handoff_active`, `captcha_completed`, `automation_resumed`,
`captcha_failed`, `captcha_timeout`, `human_handoff_cancelled`,
`browser_session_lost`) — challenge contents and anything the user typed are
never logged or stored.

Guarantees:

* The browser session, tab, cookies and page state are preserved; automation
  resumes from the stored task step, not from scratch.
* Completion is detected automatically (challenge verdict cleared or the page
  navigated past it); `browser_resume` remains available as an explicit fallback.
* Failure, timeout, cancel and session loss each return a clear status — no
  silent retries, no reload loops, no fingerprint/session rotation to evade the
  challenge.

### TikTok

* `video_ingest` is the one-shot path for TikTok (and any) public video URL:
  `{"url": "https://vt.tiktok.com/ZSq4b6A3K/", "output_mode": "all",
  "max_duration_seconds": 60, "frame_count": 4}` returns frames + a
  hash-verified R2 artifact in a single call. `video_inspect_url` remains the
  acceptance path for the public short URL `https://vt.tiktok.com/ZSq4b6A3K/`:
  it follows the short-link redirect, probes
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

## Typed Decision Providers (Laya + Jev/TypeSafe)

DEMO can ask a **typed decision provider** for narrow structured judgments inside its
workflows. Two providers exist behind one routing chain, and a provider is a **decision
capability, not a chat model**: it produces no user-facing prose, it is not selectable in
any model picker, it cannot name a tool to run, and it cannot satisfy or skip a permission
check.

* **Laya** — an external, operator-hosted decision server speaking the Jev-compatible
  `POST /v1/systemone` API. DEMO never hosts, runs or bundles the Laya model; without
  `LAYA_BASE_URL` the provider is simply off. The configured endpoint passes the full
  SSRF guard on every call. Full contract: [`docs/LAYA.md`](docs/LAYA.md).
* **Jev (TypeSafe)** — the pinned vendor integration. The full contract, every question,
  the thresholds and the fallback matrix live in [`docs/JEV.md`](docs/JEV.md).

Routing (`DECISION_PROVIDER_MODE`, or per-call `provider` on `jev_decide`): `auto` asks
Laya, then Jev, then falls back to DEMO's deterministic rules; `laya` or `jev` pin the
decision to that provider with an explicit, honest error if it is unavailable — never a
fabricated success. Every outcome reports `source: "laya" | "jev" | "rules"` and says who
failed before the provider that answered.

## Jev Decision Engine (TypeSafe)

DEMO can ask **Jev** — TypeSafe's System One decision model — for narrow typed judgments
inside its workflows. It is a **decision capability, not a chat model**: it produces no
user-facing prose, it is not selectable in any model picker, it cannot name a tool to run,
and it cannot satisfy or skip a permission check. The full contract, every question, the
thresholds and the fallback matrix live in [`docs/JEV.md`](docs/JEV.md).

| Tool | What it does |
| --- | --- |
| `jev_decide` | Run one of the **three decision templates defined in code** (`tool_route`, `result_review`, `video_intent_focus`) over bounded state and return the typed answer with its `probabilities`, the `certainty` the model reported, the `policy` band DEMO applied, and DEMO's deterministic value alongside. Accepts an optional `provider` (`auto`/`laya`/`jev`) to steer routing; refuses caller-supplied instructions or option sets. Requires the user's `decision:use` DEMO OAuth scope before a paid provider call; `TYPESAFE_API_KEY` remains server-side. |
| `jev_capabilities` | Live report: configured/enabled state, model id, thresholds, limits, the templates, documented status codes, and what this is *not*. Presence-only — it never reads or echoes the credential, and it names no endpoint the operator can redirect. |
| `laya_capabilities` | Live report for the Laya decision provider: enabled/configured state, endpoint **hostname only**, model, routing mode and chain, reliability budgets, SSRF guarantees and what this is *not*. Presence-only — the optional credential is reported as `credentialConfigured`, never a value, and the variable name stays out of runtime output (see `.env.example`). The `/laya` command adds operator status, a live `/laya check` probe and `/laya mode`. |
| `skill_builtin_typesafe` | The bundled TypeSafe guidance note for a connected AI, same shape as `skill_builtin_caveman`. Documentation only: DEMO does not install or execute skill code. |

One workflow calls it automatically, and only as a tie-breaker: `inspect_video` asks Jev to
classify the **analysis focus** when the user wrote something *and* DEMO's intent regexes
matched nothing. High confidence applies, the middle band applies with `requiresReview`,
low confidence or any failure (missing key, 401, rate limit, timeout, malformed answer)
falls back to the deterministic rules — and the video inspection still completes. The
engine's answer stays visible in `intent.decision`, so nothing is quietly overridden.

Set it up with one dashboard field:

```text
TYPESAFE_API_KEY   Worker secret (Cloudflare dashboard → Settings → Variables and
                   secrets → Encrypt). Not a var, never in a URL, log or result.
```

Verify from a browser: `GET /capabilities/jev` (or `/health`, which reports
`jevDecisionEngine`, `jevApiKeyConfigured`, `jevModel`). The capability flag indicates
only whether the server-side provider credential exists; `jev_decide` separately requires
the caller's `decision:use` OAuth scope. Disable everything with
`TYPESAFE_ENABLED=false`: the code path returns DEMO's own rules with zero network calls.
`jev_decide` is also reachable from a browser-free client only — see `docs/JEV.md` §6.

## DEMO 0.9 capability expansion

Nineteen new public, read-only tools join the existing surface (nothing was
removed or renamed). All of them reuse DEMO's existing SSRF guard, rate limits,
timeouts and artifact storage. Full details and the implementation report:
[`docs/CAPABILITIES-EXPANSION.md`](docs/CAPABILITIES-EXPANSION.md).

| Group | Tools | Notes |
| --- | --- | --- |
| Public Git | `git_repository` | Generic Git smart-HTTP (GitHub, GitLab, Codeberg, Gitea, any host) — **no API key**. Private repos are a hard `auth_required` refusal; hooks/LFS/build scripts never run. |
| Internet Archive | `archive_search`, `archive_item`, `wayback` | Wayback availability/snapshots/retrieval + archive.org search/items. "No snapshot exists" is a first-class result. |
| Feeds | `feed_read` | RSS 2.x / Atom / RDF with metadata, entries, GUIDs, dates, authors, categories, enclosures. |
| Documents | `pdf_document`, `image_analyze` | PDF text/pages/search/tables/scanned-detection + OCR via the existing Workers AI binding; image describe/OCR/compare on the same binding. |
| Web intelligence | `web_extract`, `web_diff`, `web_monitor`, `screenshot_diff` | Clean extraction (text/Markdown/JSON), content diff with noise normalization, R2-backed change monitors, browser-pixel screenshot comparison. |
| Network | `openapi_inspect`, `net_diagnose`, `url_inspect` | OpenAPI/Swagger document inspection (never calls discovered APIs), safe DNS/HTTP/TLS diagnostics, URL safety report. |
| Utilities | `schema_validate`, `jwt_inspect`, `cron_explain`, `text_diff` | Fully local: JSON Schema validation, JWT **decoding only** (DECODING ≠ VERIFICATION), cron explanation/schedule, text/JSON diff. |
| Research | `web_research` | Evidence-backed research with preserved provenance; conflicts reported, never resolved by guessing. |

## Configuration

See `.env.example` for a copyable template covering both the live test suite
(`DEMO_MCP_LIVE`, `LIVE_WORKER_URL`, Cloudflare credentials, fixtures) and the
deployment variables below. Placeholders only — never commit real secrets.

Bindings (`wrangler.jsonc`):

| Binding | Type | Purpose |
| --- | --- | --- |
| `BROWSER` | Browser Rendering (Browser Run) | The real browser. **Required** for any browser tool. |
| `SCREENSHOTS` | R2 bucket (`demo-mcp-screenshots`) | Screenshot + frame storage. |
| `BROWSER_SESSIONS` | Durable Object (`BrowserSession`) | Session/tab state across requests. |
| `ROBLOX_AUTH` | Durable Object (`RobloxAuth`) | Encrypted Roblox grants, single-use OAuth state, rate counters, refresh lease. Required for protected Roblox operations. |
| `MCP_AUTH` | Durable Object (`McpAuth`) | Hashed DEMO authorization codes/tokens, consent requests, link codes, revocation and rate limits. |

Variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_PUBLIC_ORIGIN` | `https://demo-mcp.amidevz.workers.dev` | Canonical HTTPS issuer/resource origin. Must match the public deployment origin exactly; never inferred from `Host`. |
| `MCP_AUTH_ACCESS_TEAM_DOMAIN` | placeholder | Cloudflare Access team domain used to verify signed identity assertions. |
| `MCP_AUTH_ACCESS_AUD` | placeholder | Audience tag for the human Cloudflare Access application. |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `900` | DEMO access-token lifetime (clamped to 5–15 minutes); no refresh token is issued. |
| `MCP_AUTH_RATE_LIMIT_PER_MINUTE` | `30` | OAuth route and client rate budget. |
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
| `ROBLOX_CLIENT_ID` | *(unset = feature off)* | Roblox OAuth app client ID; non-secret Worker variable. |
| `ROBLOX_CLIENT_SECRET` | *(unset = feature off)* | Roblox OAuth app secret; encrypted Worker secret, POSTed only to Roblox's pinned token endpoint. |
| `ROBLOX_TOKEN_KEY` | *(unset = protected linking unavailable)* | Random 32-byte secret used to derive the AES-256-GCM encryption key for Roblox tokens and pending PKCE verifiers. Rotating it invalidates existing grants. |
| `ROBLOX_OAUTH_SCOPES` | `openid profile` | Scopes requested at Roblox consent. `openid` is required; see `docs/ROBLOX.md` for additional scopes. |
| `ROBLOX_REDIRECT_URI` / `ROBLOX_ALLOWED_HOSTS` | *(derived)* | Pin the Roblox callback URI and optionally restrict accepted hosts. |
| `OAUTH_STATE_TTL_SECONDS` | `600` | Roblox authorization-state lifetime (60–900 seconds). |
| `ROBLOX_RATE_LIMIT_PER_MINUTE` / `ROBLOX_OPEN_CLOUD_RATE_PER_MINUTE` | `20` / `10` | Per-client cap on the OAuth routes; self-imposed budget kept below Roblox's published per-authorization limits. |
| `TYPESAFE_ENABLED` | on when the key exists | Jev decision-engine switch. `false`/`0`/`off`/`no` short-circuits every decision path to DEMO's own rules with **no network call**. |
| `TYPESAFE_MODEL` | `jev-latest` | The `model` id sent to the API. `jev-latest` tracks the newest stable release; pin `jev-1.13.0` if you tune thresholds against a fixed version. |
| `TYPESAFE_DECISION_TIMEOUT_MS` | `2500` | Per-request budget (250–15 000 ms). Past it the decision is abandoned and the fallback used, never queued. |
| `TYPESAFE_REVIEW_THRESHOLD` / `TYPESAFE_ACCEPT_THRESHOLD` | `0.5` / `0.7` | Confidence bands: below review → recorded but not acted on; between → applied with `requiresReview`; at or above accept → applied. `accept` is clamped to `≥ review`. Validate both on your own traffic. |
| `TYPESAFE_API_KEY` | *(unset = engine off)* | TypeSafe key. **Worker secret only** — never a `vars` value, never in a URL, log, tool result or error message. |
| `LAYA_ENABLED` | `true` (inert without `LAYA_BASE_URL`) | Laya decision-provider switch. `false`/`0`/`off`/`no` removes the provider with **zero network traffic**. |
| `LAYA_BASE_URL` | *(unset = provider off)* | Public https origin (+ optional path prefix) of an external Laya server (`POST <LAYA_BASE_URL>/v1/systemone`). Not a secret; SSRF-guarded on every call — no loopback/private/metadata targets, no infrastructure ports, no embedded credentials. |
| `LAYA_API_KEY` | *(unset = unauthenticated server)* | Optional Laya credential. **Worker secret only** — sent as exactly one `Authorization: Bearer …` header; never in a URL, log, error, tool result or status surface. |
| `LAYA_TIMEOUT_MS` | `2500` | Laya per-request budget (250–15 000 ms). Past it the decision is abandoned and the chain continues, never queued. |
| `LAYA_MODEL` | `laya-latest` | The `model` id sent to the Laya server. |
| `DECISION_PROVIDER_MODE` | `auto` | Typed-decision routing: `auto` (Laya → Jev → deterministic fallback) / `laya` / `jev`. Overridable per call via `jev_decide`'s `provider`. |

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
* **Third-party accounts** — Roblox sign-in is the official OAuth 2.0 authorization-code
  + PKCE flow; `.ROBLOSECURITY` cookies and password forms are not supported anywhere in
  the codebase. Tokens are encrypted at rest, never appear in a URL, HTML, log line, MCP
  result or cookie. Protected account tools require an appropriately scoped DEMO OAuth
  token; they bind data to the server-verified Access subject, even though `/mcp` is public.
* **DEMO OAuth** — ChatGPT → DEMO uses separate OAuth 2.1 authorization-code + PKCE,
  validated client/redirect registration, one-time codes, hashed short-lived access grants,
  replay prevention and revocation. Identity comes from a cryptographically verified
  Cloudflare Access assertion at consent, never from a tool argument. Public tools stay
  `noauth`; only account-specific Roblox tools and `jev_decide` are protected.
* **Structured decisions** — the TypeSafe key is a Worker secret read at call time, never
  stored on a config object, never in a URL or result, and the API origin is pinned in code.
  The optional Laya credential gets the same treatment, and its configurable endpoint is
  re-checked against the SSRF guard on every call; a hostile Laya server echoing the key
  back still can't smuggle it into DEMO's errors or logs (pinned by tests). Both providers
  answer only from option sets DEMO enumerated in code; an out-of-set answer is rejected
  rather than mapped, and no decision can widen a limit, skip a confirmation or enable a tool.
* **Auth separation** — `/mcp`, discovery, resources and public tools stay available
  without login. Per-tool DEMO OAuth protects account data and paid decisions; a DEMO
  grant never authorizes Roblox. Roblox consent is a separate flow. All tools remain
  registered, with public `noauth` and protected `oauth2` security schemes.

## Testing

```bash
npm test              # offline unit/integration tests, including a wrangler build gate
npm run typecheck     # tsc --noEmit (src + tests)
DEMO_MCP_LIVE=1 CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run test:live
# video acceptance only:
DEMO_MCP_LIVE=1 LIVE_WORKER_URL=https://demo-mcp.<sub>.workers.dev npm run test:live:video
```

* Unit/Integration (no network): SSRF guard, redaction, challenge detection,
  page scripts (real DOM via jsdom), snapshots, TikTok payload parsing, media
  reports, frame sampling, session/tab/challenge flows, the HTTP + MCP surface
  (tool inventory, public no-login tools, per-tool OAuth challenges, routes,
  graceful capability errors), and the `video_ingest`/`video_inspect_pipeline`
  pipeline — download-to-R2, frame mapping to MCP image blocks and stage reporting
  (`tests/video-ingest.test.ts`).
* Roblox OAuth + account (no network): the full flow against a stubbed
  `apis.roblox.com` — state mismatch/expiry/replay/browser-binding, token exchange
  400/429/5xx/network failure, refresh-on-expiry with single-use rotation, forced refresh
  on 401, `Retry-After`, scope gating, revocation on logout, cookie flags, per-route rate
  limiting, Durable Object atomicity, and a console spy proving no token is ever logged
  (`tests/roblox-oauth.test.ts`, `tests/roblox-routes.test.ts`, `tests/roblox-account.test.ts`).
* Build gate: `wrangler deploy --dry-run` must succeed and must not pull any
  Node-only code into the Worker bundle.
* Live: opt-in tests that drive the real Browser Run service; the video suite
  verifies real frames (validated image bytes), R2 upload **and** retrieval
  (SHA-256 checked) and distinguishes sandbox egress restrictions from real
  failures (`tests/video-live.test.ts`).

See [`docs/BROWSER.md`](docs/BROWSER.md) for the subsystem design,
[`docs/ROBLOX.md`](docs/ROBLOX.md) for the Roblox setup and verification walkthrough, and
[`docs/TESTING.md`](docs/TESTING.md) for the test matrix.

## Skills

DEMO continues to search, fetch, audit and apply skills from skills.sh. Skills
are treated as instruction material and cannot override system, developer,
safety or user instructions. DEMO does not execute arbitrary installer commands
merely because a skill requests them.

The **TypeSafe agent skill** was installed with the provider's documented one method —
`npx skills add typesafe-ai/skills --skill typesafe-ai` — and then read and followed while
this feature was built. The installer wrote `.agents/skills/typesafe-ai/` (the real files),
symlinks for the other agent directories, and `skills-lock.json` with the source and content
hash (tracked, so an unrefreshed copy is checkable). `skills/typesafe-ai/{SKILL.md,LICENSE}`
is the vendored copy that ships with the repo,
next to `skills/caveman/SKILL.md`, so the guidance survives a fresh clone; the agent-specific
install dirs stay git-ignored. Refresh with `npx skills update`.

None of that is runtime execution: a Worker cannot install or run skill code. Nothing was
added to `src/`, `index.ts` or the bundle; `skill_install_info` prints the command instead of
running it, `skill_builtin_typesafe` returns the guidance text, and the capability that *is*
runtime is `jev_decide` (`docs/JEV.md`).

## Screenshot delivery

Screenshot binaries are **not** returned as MCP image payloads by default. They
are stored in R2 and returned as a URL such as:

```text
https://demo-mcp.www-notamirrblx.workers.dev/screenshots/<high-entropy-id>
```

This keeps large image bytes out of the ChatGPT tool result. `inline_base64` is
available but capped (`LIMITS.inlineImageMaxBytes`) and disabled by default.
Configure an R2 lifecycle rule if you want automatic deletion.
