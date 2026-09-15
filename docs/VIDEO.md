# DEMO public video pipeline

This document describes the public-video contract added in DEMO 0.5. The pipeline
is designed for Cloudflare Workers and Cloudflare Browser Rendering, not for a
VPS with FFmpeg.

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

`video_extract_frames`, `video_get_frame`, and the frame portion of
`video_inspect_url` include native MCP content blocks:

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

## Acceptance URL

Run the live acceptance test with a deployed Worker/Browser Run binding:

```bash
DEMO_MCP_LIVE=1 npm run test:live -- tests/video-live.test.ts
```

For `https://vt.tiktok.com/ZSq4b6A3K/`, pass when the result contains timestamped
frames and MCP image blocks. If TikTok returns a challenge or no normal public
media URL, pass when the result contains the exact final URL/status/challenge and
one of the stable error codes above with `frames: []` and
`analysis_ready: false`. A metadata-only thumbnail is not a passing frame result.
