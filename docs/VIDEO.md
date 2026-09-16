# DEMO public video pipeline

This document describes the public-video contract added in DEMO 0.5 and the
high-level automatic video understanding tool (`inspect_video`) added in DEMO
0.6.1. The pipeline is designed for Cloudflare Workers and Cloudflare Browser
Rendering, not for a VPS with FFmpeg.

## Tools

| Tool | Purpose |
| --- | --- |
| `inspect_video` | **One high-level tool for automatic video viewing, understanding and reactions (0.6.1)**: intent detection, dynamic frame planning, real decoded frames as MCP image blocks, scene/OCR/audio context, and an explicit honesty contract. This is the tool a connected AI should call when a user sends a video link. |
| `video_ingest` | **One-call ingestion**: resolve → download to R2 → decode frames → optional audio/transcript/analysis. The primary tool for "give me this public video so I can see it". |
| `video_inspect_url` | Metadata + frames for a public page/media URL (the acceptance path used by the live TikTok test). |
| `video_download_public` | Bounded download to an expiring R2 artifact only. |
| `video_extract_frames` / `video_get_frame` | Decoded frames (or one frame at a timestamp) as MCP image blocks + R2 references. |
| `video_extract_audio` | Best-effort `captureStream`/`MediaRecorder` audio artifact. |
| `video_transcribe` | Server-side speech-to-text (Workers AI Whisper or configured HTTPS provider). |
| `video_analyze` | Frame-grounded scene/OCR/object/action fields (vision model optional). |
| `video_inspect_pipeline` | **Diagnostic**: runs every stage and reports where it fails (see below). No separate key required; standard `/mcp` auth still applies if configured. |

## Processing flow

```text
public URL
   │
   ├─ URL guard + DNS-over-HTTPS (every redirect hop)
   ├─ bounded public GET/HEAD (no cookies or Authorization)
   ├─ HTML/OpenGraph/JSON-LD/platform-literal media extraction
   │       └─ TikTok hydration data when the page exposes it
   ├─ optional Browser Run navigation to a public HTML5 video
   │       └─ seek + rendered screenshot at bounded timestamps
   ├─ optional captureStream + MediaRecorder audio extraction
   ├─ optional server-side Workers AI Whisper / vision model
   └─ expiring R2 artifacts and native MCP image content
```

The resolver is deliberately not a downloader disguised as a platform API. It
only accepts a media URL that a normal public request can reach. It does not
steal cookies, use a login session, solve a CAPTCHA, defeat a bot check, crack a
signature/cipher, bypass a private account, or decrypt DRM.

## MCP result visibility

`inspect_video`, `video_ingest`, `video_extract_frames`, `video_get_frame`, and
the frame portion of `video_inspect_url` include native MCP content blocks:

```json
{
  "content": [
    { "type": "image", "mimeType": "image/jpeg", "data": "...base64..." },
    { "type": "text", "text": "{\"frames\":[{\"timestamp\":8,...}]}" }
  ]
}
```

The text result also has `image_reference`, an HTTPS `/screenshots/<id>` URL when
R2 is available. Inline image data is capped at the existing
`LIMITS.inlineImageMaxBytes`; an oversized frame is still retrievable from R2,
and a frame that has neither delivery path is reported as `FRAMES_UNAVAILABLE`.
A thumbnail or an image returned by OpenGraph is never put in the `frames` array.

## Tool contracts

### `inspect_video` (DEMO 0.6.1)

The single entry point for "the user sent a video link". The AI calls it
automatically — server `instructions` and the tool description tell ChatGPT-like
clients to invoke it when the user asks about a video's contents, requests a
reaction, asks for an explanation, or sends only the link. The user never
downloads the video, extracts frames, uploads screenshots, provides timestamps
or chains lower-level tools.

Input (only `url` is required):

```json
{
  "url": "string (public page, direct media file, or TikTok/Instagram/X/Reddit/YouTube link incl. vt./vm. short URLs)",
  "userIntent": "string? — the user's original message, e.g. 'React to this'",
  "question": "string? — the explicit question, e.g. 'Is this real?'",
  "reactionMode": "boolean? — explicit override; auto-detected when omitted",
  "frameCount": "number? — 1..16; duration-aware plan when omitted",
  "timestamps": "number[]? — explicit seconds; automatic plan when omitted",
  "includeMetadata": "boolean = true",
  "includeAudio": "boolean = false — best-effort, Cloudflare-compatible capture only",
  "analyzeScenes": "boolean = true",
  "analyzeOnScreenText": "boolean = true"
}
```

Automatic behaviour:

* **Intent detection** (`src/video/intent.ts`): "react", "what do you think",
  "look at this", "watch this", "rate the vibe", 💀-style emoji — or a bare link
  with no message — enable `reactionMode`. Questions map to an analysis focus:
  `authenticity` ("is this real?"), `text_ocr` ("what does the text say?"),
  `ending` ("what happens at the end?"), `beginning`, `scary`, `humor`, `people`,
  `game`, `summary`. The focus biases frame allocation and adds a *curated*
  hint to the vision prompt — raw user text is never injected into the prompt.
* **Dynamic frame plan** (`src/video/frame-plan.ts`): under 10 s → 5–8 frames;
  10–60 s → 8–12; longer → up to 16 with strict caps; unknown duration → 8 and
  even sampling once the browser decodes the real duration. The first and final
  meaningful frames are always included; `ending`/`beginning` focuses pack about
  half the budget into the relevant quarter; near-duplicate timestamps (<100 ms
  apart) are removed.
* **Real frames**: decoding happens exactly like `video_ingest`'s frame path —
  Cloudflare Browser Rendering seeks the actual `<video>` element and DEMO
  screenshots the rendered pixels. Frames within the inline cap travel as MCP
  `image` content blocks (in frame order, before the JSON manifest); every
  stored frame also gets a short-lived R2 `imageReference`. Thumbnails, cover
  images, metadata and webpage screenshots are never returned as frames.
* **Scenes / OCR**: `analyzeScenes` and `analyzeOnScreenText` run frame-grounded
  analysis through the optional server-side vision model (up to
  `LIMITS.videoMaxVisionFrames` frames). Without a model the fields are `null`
  and a limitation says so — the calling vision model can still read text and
  scenes directly from the returned frame images.
* **Audio**: only when `includeAudio` is true, via the existing browser
  `captureStream`/`MediaRecorder` path, with optional speech-to-text on the
  captured artifact. `audioStatus` is `"available" | "unavailable" | "failed"`;
  nothing is fabricated and visual analysis never depends on audio.
* **Policy gates** run before browser time is spent: SSRF guard (incl. private
  IPs → `blocked_url`), declared size > `VIDEO_MAX_DOWNLOAD_MB` →
  `DOWNLOAD_TOO_LARGE`, known duration > `VIDEO_MAX_DURATION_SECONDS` →
  duration-policy failure.

Result (JSON manifest; `frames[].image` names the MCP image block that carries
the actual pixels, e.g. `mcp_image_block_0`):

```json
{
  "tool": "inspect_video",
  "inspectionStatus": "complete | partial | failed",
  "source": { "platform": "…", "url": "…", "resolvedUrl": "…", "durationSeconds": 9.2, "width": 720, "height": 1280, "title": "…", "mimeType": "video/mp4" },
  "intent": { "userIntent": "…", "question": "…", "reactionMode": true, "focus": "reaction" },
  "frames": [{ "timestamp": 0.184, "image": "mcp_image_block_0", "mimeType": "image/jpeg", "bytes": 98213, "imageReference": "https://…/screenshots/<id>", "sceneDescriptionHint": "…" }],
  "detectedScenes": [{ "start": 0.184, "end": 4.6, "significance": "…" }],
  "extractedText": ["…"],
  "audioStatus": null,
  "transcript": null,
  "framesDelivered": 7,
  "imageBlocksDelivered": 7,
  "visualEvidenceDelivered": true,
  "error": null,
  "message": null,
  "challenge": { "detected": false, "kind": null, "reason": null },
  "limitations": ["…"],
  "honestyNote": "…",
  "responseGuidance": "…"
}
```

Status semantics:

* `complete` — every planned frame decoded and delivered as inline MCP image
  blocks, no stage errors.
* `partial` — real frames delivered but something was reduced: reference-only
  delivery (inline budget exhausted), fewer frames than planned, or a requested
  audio extraction failed.
* `failed` — no frames at all; the MCP result is an error (`isError: true`) with
  the stable code (`blocked_url`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_PUBLIC`,
  `PLATFORM_BLOCKED`, `DOWNLOAD_TOO_LARGE`, `FRAMES_UNAVAILABLE`, …),
  `frames: []` and `visualEvidenceDelivered: false`.

Honesty contract: `visualEvidenceDelivered` is true only when actual decoded
frame pixels reached the caller. `honestyNote` states what the AI may claim:
with frames — describe what is visible, never claim continuous playback, never
invent audio/dialogue; without frames — the AI MUST NOT claim to have seen the
video. The MCP server `instructions` repeat this rule at the protocol level, so
clients that read server instructions apply it before any tool call.

### `video_ingest`

Input: `url` (public page or direct media URL, including TikTok
`www`/`vm`/`vt` short links), optional `max_duration_seconds`, `frame_count`,
`frame_interval_seconds`, `include_audio`, `include_transcript`, and
`output_mode` (`frames` | `video_artifact` | `analysis` | `all`, default
`all`).

Behaviour, in order:

1. **Validate + resolve** — the SSRF guard checks the URL and every redirect
   hop (DoH DNS verification, fail-closed). TikTok short links are followed as
   normal public redirects; the original URL is always preserved in
   `source_url`.
2. **Media discovery** — literal public media candidates from the page
   (OpenGraph, meta, JSON-LD, platform hydration payloads). Never a platform
   private API, never cookies.
3. **Download** — bounded public GET of the resolved media to an expiring,
   content-addressed R2 artifact (`video_<sha256>`, served at
   `/video-assets/<reference>`). Skipped for `output_mode: frames`.
4. **Frame extraction** — Browser Run decodes the video (direct media URL or
   the page's `<video>` element) and captures rendered frames at bounded
   timestamps. Frames are stored in R2 and returned with timestamps, MIME
   types and expiring URLs; frames within the inline cap also travel as native
   MCP `image` content blocks.
5. **Audio / transcript** — only when requested; audio via the browser's
   public capture API (best effort, non-DRM), transcript via a server-side
   provider (never implicit).
6. **Analysis** — `output_mode: analysis` additionally fills
   frame-grounded `scene_changes`, `visible_text_ocr`, `objects_people`,
   `actions_events` (vision model required; otherwise the limitation is
   reported, not guessed).

`success: true` means at least one requested output was produced (decoded
frames and/or the R2 artifact). When nothing can be produced, `error` carries
the stable code of the failing stage and `frames` is `[]` — a thumbnail or
metadata is never reported as a frame. `visibility_note` states exactly what
the client received (inline image blocks vs. HTTPS references vs. nothing).

### `video_inspect_pipeline`

Input: `url`, optional `include_download` and
`include_frames`. No separate key is required (the standard `/mcp` endpoint
auth still applies if `DEMO_API_KEY` is configured). Runs the real stages in
order and returns one report entry
per stage with `status` (`ok` | `failed` | `skipped`), bounded `detail` and a
redacted `error`:

| Stage | What it proves |
| --- | --- |
| `url_validation` | The SSRF guard accepts the URL (static checks + DoH DNS). |
| `redirect_resolution` | The public page was fetched and safe redirects followed. |
| `media_discovery` | How many literal media candidates the page exposed, and which one resolved. |
| `browser_access` | Browser Run launched and loaded the best known public URL. |
| `media_retrieval` | The actual media URL answers a bounded 64 KiB ranged GET; reports content type and container shape (mp4/mov, webm, HLS…). |
| `frame_extraction` | Browser Run decoded real frames (count, duration, dimensions). |
| `r2_upload` | A real R2 put + read-back + cleanup round trip. |
| `artifact_url_generation` | Artifact storage is available and the `/video-assets/<reference>` contract + TTL. |
| `mcp_serialization` | What the client would actually receive (payload size, content shape, `contains_secrets: false`). |

`overall` is `ok`, `partial` (a non-fatal stage failed — e.g. frames blocked
but everything else works) or `failed` (URL rejected). `first_failure` names
the stage to inspect.

**No per-tool key.** `video_inspect_pipeline` is open to any caller that can
reach `/mcp`; it does not require a separate token. The standard `/mcp`
endpoint auth still applies unchanged — when `DEMO_API_KEY` is configured, the
whole endpoint (including this tool) requires the bearer, and unauthenticated
requests get HTTP 401 before any tool runs. The report never contains
credentials, cookies or page bodies — only validated public URLs, counts,
sizes, durations and redacted error text.

### `video_inspect_url`

Input: `url`, optional `max_duration`, `frame_interval`, `include_transcript`.
It returns the final public URL, platform, type, duration/dimensions where known,
processing status, frame timestamps, transcript status, challenge signals and
limitations. `analysis_ready` is true only after at least one video element was
decoded and a frame was exposed.

### `video_download_public`

Input: `url`, optional `max_size_mb`. The download path is bounded by:

* the lower of the request, `VIDEO_MAX_DOWNLOAD_MB`, and 50 MiB;
* a 45-second request timeout and five manually validated redirects;
* `video/*` content types or a literal video extension;
* a known duration from page metadata or a bounded MP4 `mvhd` header; unknown
  duration is refused so a download cannot silently evade the duration policy;
* R2 storage availability and an expiring content-addressed artifact.

The returned `video_reference` has the form `video_<sha256>`. It is not a local
filesystem path. The Worker serves it at `/video-assets/<reference>` while it is
valid.

### `video_extract_frames` and `video_get_frame`

These use Browser Run to load the resolved public media, create a normal HTML5
`video` element when necessary, wait for metadata, seek, and screenshot the video
rectangle. They do not copy media through a Node FFmpeg process. DRM media,
unknown/undecodable duration, access-denied media and missing Browser Run all
produce a structured limitation. Timestamps are seconds from the decoded video;
they are not thumbnail timestamps.

### `video_extract_audio`

The Worker asks the browser for `captureStream()` and records only an audio track
that the browser already decoded. This is best effort because Browser Run/browser
versions may not expose `MediaRecorder`, some streams have no audio, and DRM media
cannot be captured. `no_audio_track` is a successful, explicit result; unsupported
capture is not represented as fabricated audio.

### `video_transcribe`

If `AI` is bound, DEMO calls the server-side `VIDEO_TRANSCRIPTION_MODEL` (default
`@cf/openai/whisper`). Otherwise it can use an explicitly configured HTTPS
`TRANSCRIPTION_ENDPOINT`; `TRANSCRIPTION_API_KEY` is read only in the Worker.
No provider is enabled implicitly. Provider output is normalized to
`start_seconds`, `end_seconds`, and `text`. Empty provider output is
`no_speech_detected`, not a failed request.

### `video_analyze`

The response always contains `scene_changes`, `visible_text_ocr`,
`objects_people`, `actions_events`, and `audio_transcript_summary`. These arrays
are populated with frame timestamps only after actual frames were retrieved. If
`AI`/vision is missing, the arrays stay empty and `limitations` says that OCR,
object and action labels were not available; DEMO does not claim it saw pixels it
did not inspect.

## Error codes

| Code | Meaning |
| --- | --- |
| `VIDEO_NOT_FOUND` | No public video candidate was exposed. |
| `VIDEO_NOT_PUBLIC` | Login/private access, an unverified duration, failed public media request, or an expired public URL. |
| `PLATFORM_BLOCKED` | A bot challenge, CAPTCHA, access denial or platform rate limit blocked normal public retrieval. |
| `UNSUPPORTED_MEDIA` | Audio-only input, HLS playlist for the file-download tool, unsupported type, or a duration that cannot be verified. |
| `DOWNLOAD_TOO_LARGE` | `Content-Length` or streamed bytes exceeded the bounded size. |
| `PROCESSING_TIMEOUT` | Public request or bounded processing time expired. |
| `FRAMES_UNAVAILABLE` | No browser-decodable frame could be exposed. |
| `TRANSCRIPTION_UNAVAILABLE` | No audio/provider or the configured provider failed. |

These codes are returned in the MCP text payload and, for hard failures, in the
MCP `isError` result. `no_speech_detected` is a normal transcript status.

## Cloudflare deployment

The current deployment already binds `SCREENSHOTS` to R2. DEMO stores temporary
video/audio objects in that bucket under `video-artifacts/` by default so the
existing deployment keeps working. A separate `VIDEO_ARTIFACTS` R2 binding can be
provided through the environment without changing the tool contracts. Objects
carry `createdAt`, `expiresAt`, content type and a content hash. The route checks
expiry before serving; `platform-entry.ts` also runs a bounded hourly cron cleanup
for `video-artifacts/` and `screenshots/` objects. Configure an R2 lifecycle rule
as an account-level second line of defence.

`AI` is optional. To enable Workers AI, bind an AI service in the deployment and
keep model configuration server-side. No AI binding or provider key is returned by
`/health`, `/tools`, MCP results, logs or the browser-facing UI.

The implementation uses no local filesystem, Docker daemon, permanently running
process, or FFmpeg binary. Browser Run and R2 are the only heavy Cloudflare
services required for actual decoded frames/artifacts.

## Live acceptance tests

Run against a deployed Worker (or a local `wrangler dev` with Cloudflare
credentials — see `docs/TESTING.md`):

```bash
DEMO_MCP_LIVE=1 LIVE_WORKER_URL=https://demo-mcp.<sub>.workers.dev npm run test:live:video
# or: DEMO_MCP_LIVE=1 CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run test:live:video
```

`tests/video-live.test.ts` proves, in order:

1. `video_ingest` on a **stable public MP4**
   (`LIVE_PUBLIC_VIDEO_URL`, default a small Google sample bucket clip):
   the response must contain decoded frames with timestamps + image MIME,
   MCP image blocks and/or retrievable HTTPS references, and a `video_artifact`
   whose `/video-assets/video_<sha256>` URL is fetched back with a matching
   SHA-256 — i.e. real R2 upload **and** retrieval, with the artifact bytes
   verified, not just claimed.
2. `video_ingest` on a **public TikTok URL** (`LIVE_TIKTOK_URL`): pass with
   real frames (and real video dimensions), or with one of the stable error
   codes, `frames: []` and `analysis_ready: false` — a blocked platform is an
   accepted outcome only when the response is explicit.
3. `video_inspect_url` on the supplied short link
   `https://vt.tiktok.com/ZSq4b6A3K/` with the same honest pass criteria.
4. `inspect_video` on a **plain public MP4 link with no other arguments**:
   the automatic flow must enable reaction mode, decode frames, return them as
   consumable MCP image blocks (validated JPEG/PNG bytes) and/or HTTPS
   references, and carry the honesty note.
5. `inspect_video` on the supplied short link `https://vt.tiktok.com/ZSqVLjkpU/`
   with `userIntent: "React to this:"`: pass with real frames, or with an
   explicit `failed` status, a stable error code, `frames: []` and a
   `honestyNote` forbidding the AI from claiming it saw the video.
6. **Failure honesty**: a private IP is rejected as `blocked_url` before any
   request (for both `video_ingest` and `inspect_video`); a public URL with no
   video fails with a stable code and zero frames.

**Sandbox vs. live.** The suite prefights the worker (`/health`) and
distinguishes three very different failures:

* the *test host* cannot reach the worker → the file aborts with a message
  naming the sandbox egress restriction (not a pipeline bug);
* the *worker* cannot reach the public source (e.g. `wrangler dev` inside a
  restricted sandbox) → the test **skips** with a note that the deployed
  worker has normal outbound access;
* the platform blocks the worker (TikTok challenge) → asserted as an honest
  structured error, which is a passing outcome.

A metadata-only thumbnail is never a passing frame result.
