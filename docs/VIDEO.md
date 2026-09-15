# DEMO public video pipeline

This document describes the public-video contract added in DEMO 0.5. The pipeline
is designed for Cloudflare Workers and Cloudflare Browser Rendering, not for a
VPS with FFmpeg.

## Tools

| Tool | Purpose |
| --- | --- |
| `video_ingest` | **One-call ingestion**: resolve → download to R2 → decode frames → optional audio/transcript/analysis. The primary tool for "give me this public video so I can see it". |
| `video_inspect_url` | Metadata + frames for a public page/media URL (the acceptance path used by the live TikTok test). |
| `video_download_public` | Bounded download to an expiring R2 artifact only. |
| `video_extract_frames` / `video_get_frame` | Decoded frames (or one frame at a timestamp) as MCP image blocks + R2 references. |
| `video_extract_audio` | Best-effort `captureStream`/`MediaRecorder` audio artifact. |
| `video_transcribe` | Server-side speech-to-text (Workers AI Whisper or configured HTTPS provider). |
| `video_analyze` | Frame-grounded scene/OCR/object/action fields (vision model optional). |
| `video_inspect_pipeline` | **Admin-only diagnostic**: runs every stage and reports where it fails (see below). |

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

`video_ingest`, `video_extract_frames`, `video_get_frame`, and the frame
portion of `video_inspect_url` include native MCP content blocks:

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

Admin-only (see below). Input: `url`, optional `include_download` and
`include_frames`. Runs the real stages in order and returns one report entry
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

**Admin gating (fail-closed).** The tool refuses to run unless the Worker has
`DEMO_API_KEY` configured **and** the request presents it
(`Authorization: Bearer <key>`). With the key set, `/mcp` itself requires the
same bearer, so an unauthenticated caller gets HTTP 401 before any tool runs;
with the key unset, the tool returns `admin_required`. The report never
contains credentials, cookies or page bodies — only validated public URLs,
counts, sizes, durations and redacted error text.

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
| `admin_required` | `video_inspect_pipeline` called without the configured `DEMO_API_KEY`. |

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
4. **Failure honesty**: a private IP is rejected as `blocked_url` before any
   request; a public URL with no video fails with a stable code and zero
   frames.

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
