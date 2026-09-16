/**
 * Video capability description — one source of truth.
 *
 * The connected AI must be able to see, before it promises anything to a user,
 * which platforms DEMO can resolve, whether it can obtain the *actual video
 * bytes*, whether it can decode *frames*, whether it can *transcribe* audio, and
 * which optional providers are configured. This module produces that report;
 * the MCP resource (`demo://capabilities/video`), `demo_ping`, `/health`,
 * `video_resolve` and `video_analyze` all read from it.
 *
 * It reports provider *names and presence only*. No key, token or binding value
 * is ever included.
 */

import { LIMITS } from "../core/limits.js";
import type { VideoEnv } from "./types.js";

/** Browser-side capability inputs (from `SessionManager.capabilities()`). */
export interface BrowserCapabilityInput {
  browserAvailable: boolean;
  provider: string;
  videoFrames: boolean;
  reason?: string | null;
  screenshots?: boolean;
}

export interface ProviderReport {
  /** Stable provider id, e.g. `workers-ai:whisper`. */
  id: string;
  /** Whether it is configured in this deployment. */
  configured: boolean;
  /** What it enables when configured. */
  enables: string;
  /** How to configure it (env binding/secret name), never its value. */
  configureWith: string;
}

export interface PlatformSupport {
  platform: "tiktok" | "instagram" | "youtube" | "x" | "reddit" | "generic";
  /** Short/share links are followed as normal public redirects. */
  shortLinks: boolean;
  /** DEMO can usually obtain a literal playable stream URL. */
  directStreamDiscovery: boolean;
  /** Frames can be decoded from the rendered page in Browser Rendering. */
  frameDecoding: boolean;
  notes: string;
}

export interface VideoCapabilityReport {
  /** Schema version of this report. */
  schema: "demo.video-capabilities/1";
  supportedPlatforms: PlatformSupport[];
  /** Can DEMO obtain the real video bytes (not just metadata/thumbnail)? */
  actualVideoBytes: {
    available: boolean;
    mechanism: string;
    requires: string[];
    limitations: string[];
  };
  frames: {
    available: boolean;
    mechanism: string;
    requires: string[];
    maxFrames: number;
    limitations: string[];
  };
  audio: { available: boolean; mechanism: string; requires: string[]; limitations: string[] };
  transcription: {
    available: boolean;
    provider: string | null;
    requires: string[];
    languageDetection: boolean;
    timestamps: boolean;
    limitations: string[];
  };
  visionAnalysis: { available: boolean; provider: string | null; requires: string[]; limitations: string[] };
  storage: { available: boolean; kind: "cloudflare-r2"; ttlSeconds: number; route: string; cleanup: string };
  browser: { available: boolean; provider: string; reason: string | null };
  providers: ProviderReport[];
  limits: {
    maxDownloadMb: number;
    maxDurationSeconds: number;
    maxFrames: number;
    inlineImageBytes: number;
    inlineTotalBytes: number;
    audioMaxSeconds: number;
    rateLimitPerMinute: number;
    artifactTtlSeconds: number;
  };
  security: {
    ssrfGuard: string;
    dnsVerification: boolean;
    neverBypassed: string[];
    signedUrlPolicy: string;
  };
  /** What works with no external provider configured at all. */
  worksWithoutProviders: string[];
  /** What genuinely needs an external provider. */
  requiresExternalProvider: string[];
}

function number(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const raw = value === undefined || (typeof value === "string" && value.trim() === "") ? undefined : value;
  if (raw === undefined) return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.trunc(parsed), max)) : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim().toLowerCase() !== "false";
}

/**
 * Describe what this deployment can actually do with video.
 *
 * `env` is read for *presence* of bindings only. A missing Browser Rendering
 * binding means frames are unavailable and the report says so; a missing AI
 * binding means transcription/vision are unavailable and the report says so.
 */
export function describeVideoCapabilities(env: VideoEnv & Record<string, unknown>, browser: BrowserCapabilityInput): VideoCapabilityReport {
  const hasR2 = Boolean(env.VIDEO_ARTIFACTS ?? env.SCREENSHOTS);
  const hasAi = Boolean(env.AI && typeof (env.AI as { run?: unknown }).run === "function");
  const transcriptionEndpoint = typeof env.TRANSCRIPTION_ENDPOINT === "string" && /^https:\/\//i.test(env.TRANSCRIPTION_ENDPOINT) ? env.TRANSCRIPTION_ENDPOINT : null;
  const transcriptionModel = typeof env.VIDEO_TRANSCRIPTION_MODEL === "string" && env.VIDEO_TRANSCRIPTION_MODEL ? env.VIDEO_TRANSCRIPTION_MODEL : "@cf/openai/whisper";
  const visionModel = typeof env.VIDEO_VISION_MODEL === "string" && env.VIDEO_VISION_MODEL ? env.VIDEO_VISION_MODEL : "@cf/llava-hf/llava-1.5-7b-hf";
  const canTranscribe = hasAi || Boolean(transcriptionEndpoint);
  const ttlSeconds = number(env.VIDEO_ARTIFACT_TTL_SECONDS, LIMITS.videoArtifactTtlSeconds, 60, 86_400);
  const maxDownloadMb = number(env.VIDEO_MAX_DOWNLOAD_MB, LIMITS.videoMaxDownloadMb, 1, LIMITS.videoMaxDownloadMb);
  const maxDuration = number(env.VIDEO_MAX_DURATION_SECONDS, LIMITS.videoMaxDurationSeconds, 1, 3_600);
  const rateLimit = number(env.VIDEO_RATE_LIMIT_PER_MINUTE, 12, 1, 120);

  const providers: ProviderReport[] = [
    {
      id: "cloudflare-browser-rendering",
      configured: browser.browserAvailable,
      enables: "Decoding real video frames and best-effort audio capture from public HTML5 media.",
      configureWith: "browser.binding=BROWSER in wrangler.jsonc",
    },
    {
      id: "cloudflare-r2",
      configured: hasR2,
      enables: "Temporary expiring storage for video/audio artifacts and decoded frames.",
      configureWith: "r2_buckets binding SCREENSHOTS (or VIDEO_ARTIFACTS)",
    },
    {
      id: `workers-ai:${transcriptionModel}`,
      configured: hasAi,
      enables: "Speech-to-text transcription with language detection and timestamps.",
      configureWith: "AI binding in wrangler.jsonc (optional VIDEO_TRANSCRIPTION_MODEL)",
    },
    {
      id: "configured-transcription-endpoint",
      configured: Boolean(transcriptionEndpoint),
      enables: "Speech-to-text through an explicitly configured HTTPS provider.",
      configureWith: "TRANSCRIPTION_ENDPOINT + TRANSCRIPTION_API_KEY secrets",
    },
    {
      id: `workers-ai:${visionModel}`,
      configured: hasAi,
      enables: "Frame-grounded scene labels, on-screen text (OCR) and action descriptions.",
      configureWith: "AI binding in wrangler.jsonc (optional VIDEO_VISION_MODEL)",
    },
  ];

  return {
    schema: "demo.video-capabilities/1",
    supportedPlatforms: [
      {
        platform: "tiktok",
        shortLinks: true,
        directStreamDiscovery: true,
        frameDecoding: browser.browserAvailable,
        notes: "vt./vm. short links are followed as normal public redirects. Canonical @user/video/<id> URLs are parsed from the page's own hydration payload (__UNIVERSAL_DATA_FOR_REHYDRATION__), SIGI_STATE, JSON-LD and OpenGraph metadata — never from a single fragile selector. Deleted/private/region-restricted items are named via TikTok's published status code. CAPTCHA walls are reported, never bypassed.",
      },
      {
        platform: "instagram",
        shortLinks: true,
        directStreamDiscovery: true,
        frameDecoding: browser.browserAvailable,
        notes: "Reel/post shortcode, owner, caption, duration and literal video_url/playable_url CDN MP4s are parsed from the page's own shortcode-media JSON; expiring URLs are never persisted. Login walls, private accounts and photo posts (no video track) are reported as precise access failures, never guessed at.",
      },
      {
        platform: "youtube",
        shortLinks: true,
        directStreamDiscovery: false,
        frameDecoding: browser.browserAvailable,
        notes: "Video id, title, author, duration and YouTube's own playability verdict (private / login-required / unplayable) are parsed from ytInitialPlayerResponse. Only literal unciphered progressive MP4 URLs are ever used — ciphered renditions are never deciphered and HLS/DASH manifests are reported, never streamed or assembled — so most watch pages resolve metadata without a downloadable file. Frames may still be decoded from a publicly playable embed where the platform allows it.",
      },
      {
        platform: "x",
        shortLinks: false,
        directStreamDiscovery: true,
        frameDecoding: browser.browserAvailable,
        notes: "Status id, author, tweet text and video_info MP4 variants (video.twimg.com) are parsed from the page's __NEXT_DATA__ payload; the HLS variant is reported, never streamed. Protected accounts, deleted posts and photo-only posts are reported as precise access failures.",
      },
      {
        platform: "reddit",
        shortLinks: true,
        directStreamDiscovery: true,
        frameDecoding: browser.browserAvailable,
        notes: "Post id, author, title, duration and the shreddit-player fallback_url are parsed from the public page. The fallback is a video-only DASH rendition (no audio track), so transcription from it is impossible; HLS/DASH manifests are reported, never assembled. Private/quarantined subreddits and image posts are reported as precise access failures.",
      },
      {
        platform: "generic",
        shortLinks: false,
        directStreamDiscovery: true,
        frameDecoding: browser.browserAvailable,
        notes: "Any public page exposing a literal MP4/WebM URL, or a direct media file URL.",
      },
    ],
    actualVideoBytes: {
      available: hasR2,
      mechanism: "video_fetch streams the public media body through a bounded transform straight into R2 (no full-file buffering, no local disk), verifies the container by byte signature, and returns an expiring /video-assets/<reference> URL.",
      requires: hasR2 ? [] : ["An R2 binding (SCREENSHOTS or VIDEO_ARTIFACTS) is required to persist retrieved video bytes."],
      limitations: [
        `Bounded to ${maxDownloadMb} MiB and ${maxDuration}s per deployment policy.`,
        "HLS/DASH manifests are not assembled into a single file; they are reported as unsupported for download.",
        "DRM, login-walled and private media are never retrieved.",
        "Signed platform URLs expire; artifacts are temporary and expire with them.",
      ],
    },
    frames: {
      available: browser.browserAvailable,
      mechanism: "Cloudflare Browser Rendering seeks the real HTML5 <video> element and screenshots the rendered pixels at bounded timestamps. No FFmpeg, no Worker-side decoder.",
      requires: browser.browserAvailable ? [] : ["A Cloudflare Browser Rendering binding (BROWSER) is required to decode frames."],
      maxFrames: LIMITS.videoFramesMaxCount,
      limitations: [
        "Frames are samples, not continuous playback.",
        "DRM-protected media cannot be captured and is never decrypted.",
        browser.reason ?? "Browser Rendering is available in this deployment.",
      ],
    },
    audio: {
      available: browser.browserAvailable,
      mechanism: "The browser's own captureStream()/MediaRecorder path records an audio track it already decoded.",
      requires: browser.browserAvailable ? [] : ["A Cloudflare Browser Rendering binding (BROWSER)."],
      limitations: [
        "Best effort: some browser versions do not expose MediaRecorder, and some streams have no audio track.",
        `Capped at ${LIMITS.videoAudioMaxSeconds}s and ${Math.round(LIMITS.videoAudioMaxBytes / (1024 * 1024))} MiB.`,
        "no_audio_track is reported explicitly; audio is never fabricated.",
      ],
    },
    transcription: {
      available: canTranscribe,
      provider: hasAi ? `workers-ai:${transcriptionModel}` : transcriptionEndpoint ? "configured-transcription-endpoint" : null,
      requires: canTranscribe ? [] : ["Bind Workers AI (AI) or set TRANSCRIPTION_ENDPOINT + TRANSCRIPTION_API_KEY."],
      languageDetection: canTranscribe,
      timestamps: canTranscribe,
      limitations: [
        "Needs an audio track; a silent video returns no_speech_detected, not a fabricated transcript.",
        "The provider is optional: without it DEMO reports TRANSCRIPTION_UNAVAILABLE and never invents dialogue.",
        "A platform post caption is reported separately and is never presented as speech.",
      ],
    },
    visionAnalysis: {
      available: hasAi,
      provider: hasAi ? `workers-ai:${visionModel}` : null,
      requires: hasAi ? [] : ["Bind Workers AI (AI) for server-side frame-grounded scene/OCR labels."],
      limitations: [
        "Optional: without it the raw frames are still returned so the connected vision model can inspect them directly.",
        "Labels are produced only from frames DEMO actually decoded.",
      ],
    },
    storage: {
      available: hasR2,
      kind: "cloudflare-r2",
      ttlSeconds,
      route: "/video-assets/<video|audio>_<64-hex-reference>",
      cleanup:
        "Every object carries expiresAt; the route refuses expired objects and an hourly cron deletes them. " +
        "Second line of defence: R2 lifecycle rule `demo-video-artifacts-expiry` on prefix `video-artifacts/` " +
        "(`wrangler r2 bucket lifecycle add <bucket> demo-video-artifacts-expiry video-artifacts/ --expire-days 2`).",
    },
    browser: { available: browser.browserAvailable, provider: browser.provider, reason: browser.reason ?? null },
    providers,
    limits: {
      maxDownloadMb,
      maxDurationSeconds: maxDuration,
      maxFrames: LIMITS.videoFramesMaxCount,
      inlineImageBytes: LIMITS.inlineImageMaxBytes,
      inlineTotalBytes: LIMITS.videoInlineMaxTotalBytes,
      audioMaxSeconds: LIMITS.videoAudioMaxSeconds,
      rateLimitPerMinute: rateLimit,
      artifactTtlSeconds: ttlSeconds,
    },
    security: {
      ssrfGuard: "Every URL and every redirect hop passes the SSRF guard: private/loopback/link-local IP ranges, localhost, internal hostnames, non-http(s) schemes and IP-literal tricks are rejected before any request.",
      dnsVerification: flag(env.SSRF_DNS_CHECK as string | undefined, true),
      neverBypassed: ["CAPTCHA / bot challenges", "login walls and private accounts", "DRM / EME-protected media", "paywalls", "platform signature/cipher cracking", "private platform APIs"],
      signedUrlPolicy: "Signed CDN URLs are returned to the caller when needed for retrieval but are never logged, never persisted in R2 metadata (only the original public page URL is), and can be omitted with include_signed_urls=false.",
    },
    worksWithoutProviders: [
      "video_resolve: short-link resolution, canonical URL/video id, creator, caption, duration, dimensions and the literal stream URLs the page publishes, plus an honest access status.",
      "video_fetch: verified retrieval of the actual MP4/WebM bytes into expiring R2 storage (needs R2, which is already bound).",
      "video_extract_frames / video_get_frame / inspect_video: real decoded frames as MCP image blocks (needs the Browser Rendering binding).",
      "video_analyze / video_react: the grounded evidence package the connected vision model inspects.",
      "Full SSRF, size, duration, timeout, content-type and byte-signature enforcement.",
    ],
    requiresExternalProvider: [
      hasAi || canTranscribe ? "Transcription is configured in this deployment." : "video_transcribe and transcript output require Workers AI (AI binding) or a configured HTTPS TRANSCRIPTION_ENDPOINT.",
      hasAi ? "Server-side vision labels are configured in this deployment." : "Optional frame-grounded scene/OCR labels (detectedScenes, extractedText, visionSummary) require Workers AI; without it the raw frames are still returned for the connected model to read.",
      "DEMO has no Worker-side video decoder: frame extraction always requires Cloudflare Browser Rendering. A separate external ffmpeg-style backend is NOT required, and nothing silently depends on one.",
    ],
  };
}

/** Compact flags for `/health`, `/`, `demo_ping` and the platform telemetry. */
export function videoCapabilityFlags(report: VideoCapabilityReport) {
  return {
    publicVideo: true,
    automaticVideoInspection: true,
    videoResolution: true,
    videoBytesRetrieval: report.actualVideoBytes.available,
    videoFrames: report.frames.available,
    videoAudioExtraction: report.audio.available,
    videoTranscription: report.transcription.available,
    videoVisionAnalysis: report.visionAnalysis.available,
    videoArtifacts: report.storage.available,
    transcriptionProvider: report.transcription.provider,
    visionProvider: report.visionAnalysis.provider,
  };
}
