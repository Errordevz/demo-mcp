import { BrowserError, asBrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { redactText, redactValue } from "../core/redact.js";
import { resolveScreenshotBase } from "../session/factory.js";
import { SessionManager } from "../session/manager.js";
import { MediaInspector } from "../browser/media.js";
import { PuppeteerPageHandle } from "../browser/providers/puppeteer-adapter.js";
import { ScreenshotManager } from "../browser/screenshot.js";
import { capturePublicAudio, installPublicVideo } from "./page-functions.js";
import { detectVideoIntent, type IntentFocus } from "./intent.js";
import { applyIntentHook } from "./intent-hook.js";
import type { IntentDecisionHook } from "./types.js";
import { planFrameCount, planFrameTimestamps } from "./frame-plan.js";
import { accessStatusGuidance, classifyAccess, type AccessStatusInfo, type VideoAccessStatus } from "./access.js";
import { describeVideoCapabilities, type VideoCapabilityReport } from "./capabilities.js";
import { detectMediaSignature, durationFromSample, imageDimensions, notAVideoMessage, type MediaSignature } from "./probe.js";
import { signedUrlExpired, unsignedUrlShape, type QualityPreference } from "./streams.js";
import {
  contentType,
  errorCodeForAccess,
  fetchPublic,
  formatBytes,
  isPlaylistContentType,
  isVideoContentType,
  looksLikeMediaUrl,
  parseLength,
  readBounded,
  resolvePublicVideo,
  videoError,
  videoGuardOptions,
} from "./http.js";
import { VideoArtifactStore, artifactBaseUrl, sha256Hex, type StreamStoreOutcome } from "./store.js";
import { assertNavigableUrl } from "../core/url-guard.js";
import type {
  InspectVideoFrame,
  InspectVideoOptions,
  InspectVideoResult,
  InspectVideoScene,
  PipelineStageReport,
  TimestampedTranscriptSegment,
  VideoAnalysisMode,
  VideoAnalyzeOptions,
  VideoAnalyzeResult,
  VideoArtifact,
  VideoEnv,
  VideoEvidenceSummary,
  VideoFetchOptions,
  VideoFetchResult,
  VideoFrameOutput,
  VideoIngestAudio,
  VideoIngestOptions,
  VideoIngestResult,
  VideoInput,
  VideoMetadata,
  VideoPipelineReport,
  VideoPlatform,
  VideoReactOptions,
  VideoReactResult,
  VideoReactStyle,
  VideoResolution,
  VideoResolveOptions,
  VideoResolveResult,
  VideoTranscript,
  VideoVerification,
} from "./types.js";

const operationWindows = new Map<string, { startedAt: number; count: number }>();

/**
 * What each `video_analyze` mode actually does. Frame budgets stay under
 * `LIMITS.videoFramesMaxCount`, and audio/transcript work is opt-in per mode so
 * a plain `summary` never spends browser time recording audio.
 */
export const ANALYSIS_MODE_PLANS: Record<VideoAnalysisMode, {
  frames: number | null;
  includeAudio: boolean;
  includeTranscript: boolean;
  reactionMode: boolean | null;
  analyzeScenes: boolean;
  analyzeOnScreenText: boolean;
}> = {
  summary: { frames: 8, includeAudio: false, includeTranscript: false, reactionMode: false, analyzeScenes: true, analyzeOnScreenText: true },
  detailed: { frames: 12, includeAudio: true, includeTranscript: true, reactionMode: false, analyzeScenes: true, analyzeOnScreenText: true },
  reaction: { frames: null, includeAudio: false, includeTranscript: false, reactionMode: true, analyzeScenes: true, analyzeOnScreenText: true },
  fact_check_visual: { frames: 16, includeAudio: false, includeTranscript: false, reactionMode: false, analyzeScenes: true, analyzeOnScreenText: true },
  transcript: { frames: 2, includeAudio: true, includeTranscript: true, reactionMode: false, analyzeScenes: false, analyzeOnScreenText: false },
  full: { frames: 16, includeAudio: true, includeTranscript: true, reactionMode: true, analyzeScenes: true, analyzeOnScreenText: true },
};

/** Frame budget and register guidance per `video_react` style. */
export const REACT_STYLE_PLANS: Record<VideoReactStyle, { frames: number; intent: string; guidance: string }> = {
  casual: {
    frames: 6,
    intent: "React to this",
    guidance: "Casual: one or two short sentences in plain language, like texting a friend. Name the one moment that stands out and how it lands. No headings, no bullet points, no metadata dump.",
  },
  funny: {
    frames: 8,
    intent: "Is this funny? React to this",
    guidance: "Funny: lean into the absurd or surprising moment you can actually see, with timing and a light touch. Only joke about what the frames show; if nothing is funny, say that instead of forcing it.",
  },
  serious: {
    frames: 10,
    intent: "Explain what happens in this video",
    guidance: "Serious: measured and factual. Describe what happens, flag anything concerning or unsafe, and be explicit about uncertainty and about what sampled frames cannot establish.",
  },
  detailed: {
    frames: 14,
    intent: "Give a detailed breakdown of this video",
    guidance: "Detailed: walk the timeline frame by frame with timestamps, note on-screen text, then summarise the overall arc. Keep claims tied to specific frames and separate observation from inference.",
  },
};

/** Suggest the next honest step for a given access status. */
function nextStepsFor(
  status: VideoAccessStatus,
  context: { verifiedBytes: boolean; hasStream: boolean; isImagePost: boolean },
): string[] {
  if (context.isImagePost) return ["This post has no video stream. Use browser_screenshot or the returned thumbnail reference only if the user explicitly wants the still images — never as video evidence."];
  switch (status) {
    case "public":
      return context.verifiedBytes
        ? ["video_fetch — stream and store the verified video bytes", "video_extract_frames — decode timestamped frames", "video_analyze / video_react — grounded evidence for the connected model"]
        : ["video_fetch — verifies the container from real bytes before storing anything", "video_extract_frames — decode timestamped frames"];
    case "expired":
      return ["Re-resolve the original public link: signed media URLs expire in minutes.", "If a stored artifact expired, call video_fetch again on the source URL."];
    case "challenge_required":
    case "rate_limited":
      return ["Nothing to retry immediately: DEMO never solves a CAPTCHA or bypasses a bot check.", "Wait and retry later, or ask the user for a direct public media URL."];
    case "login_required":
    case "private":
      return ["Ask the user for a publicly accessible link or the video file itself.", "DEMO never logs in, sends cookies or bypasses privacy settings."];
    case "region_restricted":
      return ["Tell the user the video is region-restricted; no content can be described."];
    case "deleted":
    case "not_found":
      return ["Tell the user the video no longer exists at that URL.", "Ask for a corrected or alternative link."];
    case "blocked_url":
      return ["The target is private/internal/unsafe. Ask for a public https URL."];
    case "unsupported":
      return ["video_extract_frames may still decode frames from the page in Cloudflare Browser Rendering."];
    default:
      return context.hasStream
        ? ["video_fetch — attempt verified retrieval of the actual bytes", "video_extract_frames — attempt frame decoding in Browser Rendering"]
        : ["video_inspect_pipeline — diagnose exactly which stage fails for this URL"];
  }
}

interface BrowserVideoEnv extends VideoEnv {
  BROWSER?: unknown;
  BROWSER_PROVIDER?: string;
  BROWSER_MAX_SESSIONS?: string | number;
  CHROME_PATH?: string;
  BROWSER_KEEPALIVE_MS?: string | number;
  BROWSER_ALLOWED_DOMAINS?: string;
  BROWSER_BLOCKED_HOSTNAMES?: string;
  BROWSER_ALLOW_INSECURE_HTTP?: string;
  BROWSER_BLOCK_IDN?: string;
}

export interface FrameRequest {
  timestamps?: number[];
  frameInterval?: number;
  maxFrameCount?: number;
  inline?: boolean;
  /** `"interval"` (default, backwards compatible) or `"even"` — first, middle
   * and final meaningful frames with even coverage, used by `inspect_video`. */
  strategy?: "interval" | "even";
  /** Optional output size bound. Applied by scaling the browser viewport, so
   * Chromium renders (and DEMO screenshots) a smaller frame — no Worker-side
   * image codec is involved. */
  resize?: FrameResize | null;
}

/** Requested maximum frame size in pixels (aspect ratio is preserved). */
export interface FrameResize {
  maxWidth?: number | null;
  maxHeight?: number | null;
}

/** Compute a viewport that fits `intrinsic` inside `resize`, preserving aspect. */
export function resizeViewport(
  intrinsic: { width: number | null; height: number | null },
  resize: FrameResize | null | undefined,
): { width: number; height: number } | null {
  if (!resize) return null;
  const maxWidth = resize.maxWidth ?? null;
  const maxHeight = resize.maxHeight ?? null;
  if (maxWidth === null && maxHeight === null) return null;
  const boundWidth = maxWidth !== null ? clamp(Math.trunc(maxWidth), LIMITS.videoFrameResizeMinPx, LIMITS.videoFrameResizeMaxPx) : LIMITS.videoFrameResizeMaxPx;
  const boundHeight = maxHeight !== null ? clamp(Math.trunc(maxHeight), LIMITS.videoFrameResizeMinPx, LIMITS.videoFrameResizeMaxPx) : LIMITS.videoFrameResizeMaxPx;
  const width = intrinsic.width && intrinsic.width > 0 ? intrinsic.width : 16;
  const height = intrinsic.height && intrinsic.height > 0 ? intrinsic.height : 9;
  const scale = Math.min(boundWidth / width, boundHeight / height, 1);
  const targetWidth = clamp(Math.round(width * scale), LIMITS.videoFrameResizeMinPx, boundWidth);
  const targetHeight = clamp(Math.round(height * scale), LIMITS.videoFrameResizeMinPx, boundHeight);
  // Never upscale: a resize request only ever makes frames smaller.
  if (scale >= 1 && width <= boundWidth && height <= boundHeight) {
    return { width: clamp(Math.round(width), LIMITS.videoFrameResizeMinPx, boundWidth), height: clamp(Math.round(height), LIMITS.videoFrameResizeMinPx, boundHeight) };
  }
  return { width: targetWidth, height: targetHeight };
}

export interface FrameCaptureResult {
  success: boolean;
  error?: string;
  message?: string;
  sourceUrl: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frames: VideoFrameOutput[];
  limitations: string[];
}

export interface VideoInspectResult {
  success: boolean;
  sourceUrl: string;
  resolvedUrl: string | null;
  mediaUrl: string | null;
  platform: VideoResolution["platform"];
  metadata: VideoMetadata;
  processingStatus: string;
  analysisReady: boolean;
  frames: VideoFrameOutput[];
  transcript: VideoTranscript | null;
  error: string | null;
  message: string | null;
  challenge: VideoResolution["challenge"];
  limitations: string[];
}

/**
 * Read a bounded numeric config value. Unset/blank values fall back to the
 * default instead of being parsed (Number("") is 0, which would otherwise
 * clamp every limit to its minimum whenever the variable is absent).
 */
function configuredNumber(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const raw = value === undefined || (typeof value === "string" && value.trim() === "") ? undefined : value;
  if (raw === undefined) return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.trunc(parsed), max)) : fallback;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function contentTypeForFrame(value: string | null): "image/jpeg" | "image/png" | "image/webp" {
  if (value === "image/png") return "image/png";
  if (value === "image/webp") return "image/webp";
  return "image/jpeg";
}

function frameTimestamps(duration: number | null, request: FrameRequest, maxDuration: number): number[] {
  const maxFrames = clamp(request.maxFrameCount ?? LIMITS.videoFramesMaxCount, 1, LIMITS.videoFramesMaxCount);
  const usableDuration = Math.max(0, Math.min(duration ?? maxDuration, maxDuration));
  if (request.timestamps?.length) {
    return request.timestamps
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= usableDuration)
      .slice(0, maxFrames)
      .map((value) => Number(value.toFixed(3)));
  }
  if (request.strategy === "even") {
    // Even coverage needs a real decoded duration; without one, fall back to a
    // single first frame rather than guessing timestamps over the policy cap.
    if (duration === null || !Number.isFinite(usableDuration) || usableDuration <= 0) return [0];
    return planFrameTimestamps(usableDuration, maxFrames);
  }
  const interval = Math.max(0.25, Math.min(request.frameInterval ?? LIMITS.videoFramesDefaultIntervalSeconds, maxDuration));
  if (!Number.isFinite(usableDuration) || usableDuration <= 0) return [0];
  const values: number[] = [];
  for (let time = 0; time < usableDuration && values.length < maxFrames; time += interval) values.push(Number(time.toFixed(3)));
  if (!values.length) values.push(0);
  const last = Math.max(0, Number((Math.min(usableDuration, maxDuration) - 0.05).toFixed(3)));
  if (values.length < maxFrames && last > values[values.length - 1] + 0.1) values.push(last);
  return values.slice(0, maxFrames);
}

function normaliseTranscript(raw: any, language: string | null, duration: number | null, provider: string): VideoTranscript {
  const text = (typeof raw?.text === "string" ? raw.text : typeof raw?.transcription === "string" ? raw.transcription : "").trim().slice(0, 200_000);
  const rawSegments = Array.isArray(raw?.segments) ? raw.segments : Array.isArray(raw?.chunks) ? raw.chunks : [];
  const segments: TimestampedTranscriptSegment[] = rawSegments
    .map((segment: any) => {
      const start = Number(segment?.start ?? segment?.startSeconds ?? segment?.timestamp?.[0] ?? 0);
      const end = Number(segment?.end ?? segment?.endSeconds ?? segment?.timestamp?.[1] ?? start);
      const value = String(segment?.text ?? segment?.content ?? "").trim();
      return { startSeconds: Number.isFinite(start) ? Math.max(0, start) : 0, endSeconds: Number.isFinite(end) ? Math.max(start, end) : Math.max(0, start), text: value };
    })
    .filter((segment: TimestampedTranscriptSegment) => segment.text)
    .slice(0, 2_000);
  if (!text && segments.length === 0) return { status: "no_speech_detected", language, text: null, segments: [], provider };
  if (segments.length === 0 && text) segments.push({ startSeconds: 0, endSeconds: duration ?? 0, text });
  return { status: "transcribed", language, text: text || segments.map((segment) => segment.text).join(" "), segments, provider };
}

export class VideoProcessor {
  readonly env: BrowserVideoEnv;
  readonly requestUrl: string | null;
  readonly screenshots: ScreenshotManager;
  readonly artifacts: VideoArtifactStore;
  readonly media: MediaInspector;

  /** Optional decision-engine hook, injected by the tool layer (see `IntentDecisionHook`). */
  readonly intentHook: IntentDecisionHook | null;

  constructor(env: BrowserVideoEnv, requestUrl?: string | null, options: { intentHook?: IntentDecisionHook } = {}) {
    this.intentHook = options.intentHook ?? null;
    this.env = env;
    this.requestUrl = requestUrl ?? null;
    const screenshotBase = resolveScreenshotBase(env as never, requestUrl ?? null);
    this.screenshots = new ScreenshotManager(env.SCREENSHOTS as never, screenshotBase);
    const artifactBucket = (env.VIDEO_ARTIFACTS ?? env.SCREENSHOTS) as never;
    const artifactBase = artifactBaseUrl(requestUrl);
    this.artifacts = new VideoArtifactStore(artifactBucket, artifactBase, configuredNumber(env.VIDEO_ARTIFACT_TTL_SECONDS, LIMITS.videoArtifactTtlSeconds, 60, 86_400));
    this.media = new MediaInspector(this.screenshots);
  }

  maxDuration(): number {
    return configuredNumber(this.env.VIDEO_MAX_DURATION_SECONDS, LIMITS.videoMaxDurationSeconds, 1, 3_600);
  }

  maxDownloadBytes(requestedMb?: number): number {
    const configuredMb = configuredNumber(this.env.VIDEO_MAX_DOWNLOAD_MB, LIMITS.videoMaxDownloadMb, 1, LIMITS.videoMaxDownloadMb);
    const mb = Math.max(1, Math.min(Math.trunc(requestedMb ?? configuredMb), configuredMb));
    return mb * 1024 * 1024;
  }

  private charge(operation: string, input: string): void {
    const limit = configuredNumber(this.env.VIDEO_RATE_LIMIT_PER_MINUTE, 12, 1, 120);
    const now = Date.now();
    const key = `${operation}:${input.slice(0, 500)}`;
    const current = operationWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      operationWindows.set(key, { startedAt: now, count: 1 });
      if (operationWindows.size > 1_000) operationWindows.delete(operationWindows.keys().next().value as string);
      return;
    }
    if (current.count >= limit) throw new BrowserError("rate_limited", `Video operation rate limit reached for this public source (${limit} per minute).`, { retryable: true, hint: "Retry after a minute or use a cached video_reference." });
    current.count++;
  }

  async resolve(url: string): Promise<VideoResolution> {
    return resolvePublicVideo(url, this.env);
  }

  async inspect(url: string, options: { maxDuration?: number; frameInterval?: number; includeTranscript?: boolean } = {}): Promise<VideoInspectResult> {
    this.charge("inspect", url);
    const resolution = await this.resolve(url);
    const base: VideoInspectResult = {
      success: resolution.success,
      sourceUrl: resolution.sourceUrl,
      resolvedUrl: resolution.resolvedUrl,
      mediaUrl: resolution.mediaUrl,
      platform: resolution.platform,
      metadata: resolution.metadata,
      processingStatus: resolution.status,
      analysisReady: false,
      frames: [],
      transcript: null,
      error: resolution.error,
      message: resolution.message,
      challenge: resolution.challenge,
      limitations: resolution.limitations,
    };
    const maxDuration = Math.min(options.maxDuration ?? this.maxDuration(), this.maxDuration());
    const frameRequest: FrameRequest = {
      ...(resolution.metadata.durationSeconds !== null ? { timestamps: frameTimestamps(resolution.metadata.durationSeconds, { frameInterval: options.frameInterval, maxFrameCount: LIMITS.videoFramesMaxCount }, maxDuration) } : { frameInterval: options.frameInterval }),
      maxFrameCount: LIMITS.videoFramesMaxCount,
      inline: true,
    };

    if (!resolution.success || !resolution.mediaUrl) {
      // Dynamic platform pages frequently hide the media URL from a plain
      // Worker fetch while still exposing a normal HTML5 video to Browser Run.
      // This is a rendering fallback, not a bypass: challenges and DRM remain
      // visible and are returned as failures.
      if (resolution.error !== "blocked_url") {
        const rendered = await this.extractFramesFromSource(url, frameRequest, looksLikeMediaUrl(url));
        if (rendered.success) {
          base.success = true;
          base.processingStatus = "frames_ready";
          base.analysisReady = true;
          base.frames = rendered.frames;
          base.metadata = { ...base.metadata, durationSeconds: base.metadata.durationSeconds ?? rendered.durationSeconds, width: base.metadata.width ?? rendered.width, height: base.metadata.height ?? rendered.height };
          base.error = null;
          base.message = null;
          base.limitations.push("The Worker response did not expose a literal media URL; frames were captured from a publicly rendered HTML5 video element.", ...rendered.limitations);
          if (options.includeTranscript) base.transcript = await this.transcribe({ url }, { language: undefined, autoExtract: true, durationSeconds: rendered.durationSeconds });
          return base;
        }
        base.limitations.push(...rendered.limitations, rendered.message ?? "Browser Run could not expose a decoded frame from the public page.");
      }
      return base;
    }

    const frames = await this.extractFramesFromSource(resolution.mediaUrl, frameRequest);
    base.frames = frames.frames;
    base.metadata = {
      ...base.metadata,
      durationSeconds: base.metadata.durationSeconds ?? frames.durationSeconds,
      width: base.metadata.width ?? frames.width,
      height: base.metadata.height ?? frames.height,
    };
    base.analysisReady = frames.success;
    base.processingStatus = frames.success ? "frames_ready" : "partial";
    base.limitations.push(...frames.limitations);
    if (!frames.success) {
      const rendered = resolution.resolvedUrl && resolution.resolvedUrl !== resolution.mediaUrl
        ? await this.extractFramesFromSource(resolution.resolvedUrl, frameRequest, false)
        : await this.extractFramesFromSource(url, frameRequest, looksLikeMediaUrl(url));
      if (rendered.success) {
        base.frames = rendered.frames;
        base.metadata = { ...base.metadata, durationSeconds: base.metadata.durationSeconds ?? rendered.durationSeconds, width: base.metadata.width ?? rendered.width, height: base.metadata.height ?? rendered.height };
        base.analysisReady = true;
        base.processingStatus = "frames_ready";
        base.error = null;
        base.message = null;
        base.limitations.push("The literal media URL did not decode in Browser Run; a normal public page video element did.", ...rendered.limitations);
      } else {
        base.error = frames.error ?? "FRAMES_UNAVAILABLE";
        base.message = frames.message ?? base.message;
        base.limitations.push(...rendered.limitations);
        return base;
      }
    }
    if (options.includeTranscript) {
      const transcript = await this.transcribe({ url: resolution.mediaUrl }, { language: undefined, autoExtract: true, durationSeconds: resolution.metadata.durationSeconds });
      base.transcript = transcript;
      if (transcript.status === "transcribed") base.processingStatus = "transcribed";
      else if (transcript.status === "unavailable") base.limitations.push(transcript.message ?? "Speech-to-text was not available.");
    }
    return base;
  }

  /**
   * One-call public video ingestion.
   *
   * Pipeline: validate + resolve (safe public redirects) -> bounded download to
   * expiring R2 -> Browser Run frame decoding -> optional audio/transcript ->
   * optional frame-grounded analysis. Every stage that fails is reported in
   * `limitations`/`error` with its stable code; nothing is fabricated. The
   * returned `frames` carry `inlineData` (base64) when they fit the MCP inline
   * cap, so the tool layer can ship them to the client as real `image` content
   * blocks, plus short-lived R2 references.
   */
  async ingest(url: string, options: VideoIngestOptions): Promise<VideoIngestResult> {
    this.charge("ingest", url);
    const resolution = await this.resolve(url);
    return this.ingestResolved(url, resolution, options);
  }

  /**
   * The `ingest()` body operating on an already completed resolution, so the
   * high-level `inspectVideo()` can resolve once (page fetches are bounded but
   * expensive) and plan frames from the known duration/platform metadata.
   */
  private async ingestResolved(url: string, initialResolution: VideoResolution, options: VideoIngestOptions): Promise<VideoIngestResult> {
    const outputMode = options.outputMode;
    const needsArtifact = outputMode !== "frames";
    const needsFrames = outputMode !== "video_artifact";

    let resolution = initialResolution;
    const maxDuration = Math.min(options.maxDurationSeconds ?? this.maxDuration(), this.maxDuration());
    const explicitTimestamps = (options.timestamps ?? [])
      .filter((value) => Number.isFinite(value) && value >= 0)
      .slice(0, LIMITS.videoFramesMaxCount)
      .map((value) => Number(value.toFixed(3)));
    const frameRequest: FrameRequest = {
      ...(explicitTimestamps.length
        ? { timestamps: explicitTimestamps }
        : resolution.metadata.durationSeconds !== null
          ? {
              timestamps: frameTimestamps(
                resolution.metadata.durationSeconds,
                { frameInterval: options.frameIntervalSeconds, maxFrameCount: options.frameCount ?? LIMITS.videoFramesMaxCount, strategy: options.frameStrategy },
                maxDuration,
              ),
            }
          : { frameInterval: options.frameIntervalSeconds, maxFrameCount: options.frameCount ?? LIMITS.videoFramesMaxCount, strategy: options.frameStrategy }),
      inline: true,
    };

    const limitations: string[] = [...resolution.limitations];
    let artifact: VideoArtifact | null = null;
    let frames: VideoFrameOutput[] = [];
    let frameError: string | null = null;
    let frameMessage: string | null = null;

    if (needsArtifact && resolution.success && resolution.mediaUrl) {
      const downloaded = await this.downloadResolved(resolution);
      artifact = downloaded.artifact;
      if (artifact) {
        resolution = {
          ...resolution,
          metadata: {
            ...resolution.metadata,
            contentType: resolution.metadata.contentType ?? artifact.contentType,
            contentLength: resolution.metadata.contentLength ?? artifact.bytes,
            durationSeconds: resolution.metadata.durationSeconds ?? artifact.durationSeconds,
            width: resolution.metadata.width ?? artifact.width,
            height: resolution.metadata.height ?? artifact.height,
          },
        };
      } else {
        limitations.push(downloaded.message ?? "The public media URL could not be downloaded to temporary R2 storage.");
      }
    }

    if (needsFrames) {
      let captured: FrameCaptureResult;
      if (resolution.success && resolution.mediaUrl) {
        captured = await this.extractFramesFromSource(resolution.mediaUrl, frameRequest);
        if (!captured.success) {
          // The literal media URL may not decode (e.g. a CDN that only serves
          // to browsers) while the public page's <video> element does.
          const fallbackUrl = resolution.resolvedUrl && resolution.resolvedUrl !== resolution.mediaUrl ? resolution.resolvedUrl : url;
          const fallback = await this.extractFramesFromSource(fallbackUrl, frameRequest, looksLikeMediaUrl(fallbackUrl));
          if (fallback.success || fallback.frames.length > 0) captured = fallback;
        }
      } else if (resolution.error !== "blocked_url") {
        // Dynamic platform pages frequently hide the media URL from a plain
        // Worker fetch while exposing a normal HTML5 video to Browser Run.
        captured = await this.extractFramesFromSource(url, frameRequest, looksLikeMediaUrl(url));
      } else {
        captured = {
          success: false,
          error: resolution.error,
          message: resolution.message ?? undefined,
          sourceUrl: url,
          durationSeconds: null,
          width: null,
          height: null,
          frames: [],
          limitations: ["The URL was rejected by the SSRF guard, so no network or browser request was made."],
        };
      }
      frames = captured.frames;
      frameError = captured.error ?? null;
      frameMessage = captured.message ?? null;
      limitations.push(...captured.limitations);
      if (captured.durationSeconds !== null || captured.width !== null || captured.height !== null) {
        resolution = {
          ...resolution,
          metadata: {
            ...resolution.metadata,
            durationSeconds: resolution.metadata.durationSeconds ?? captured.durationSeconds,
            width: resolution.metadata.width ?? captured.width,
            height: resolution.metadata.height ?? captured.height,
          },
        };
      }
    }

    let audio: VideoIngestAudio | null = null;
    if (options.includeAudio) {
      const input: VideoInput = artifact ? { videoReference: artifact.reference } : { url };
      const extracted = await this.extractAudio(input);
      if (extracted.artifact) {
        audio = {
          status: "audio_ready",
          reference: extracted.artifact.reference,
          url: extracted.artifact.url,
          contentType: extracted.artifact.contentType,
          bytes: extracted.artifact.bytes,
          expiresAt: extracted.artifact.expiresAt,
          message: null,
        };
      } else if (extracted.status === "no_audio_track") {
        audio = { status: "no_audio_track", reference: null, url: null, contentType: null, bytes: null, expiresAt: null, message: extracted.message ?? null };
      } else {
        const message = extracted.message ?? extracted.error ?? "The audio track could not be extracted.";
        audio = { status: "unavailable", reference: null, url: null, contentType: null, bytes: null, expiresAt: null, message };
        limitations.push(message);
      }
    }

    let transcript: VideoTranscript | null = null;
    if (options.includeTranscript) {
      const input: VideoInput = artifact ? { videoReference: artifact.reference } : { url };
      transcript = await this.transcribe(input, { autoExtract: true, durationSeconds: resolution.metadata.durationSeconds });
      if (transcript.status === "unavailable") limitations.push(transcript.message ?? "Speech-to-text was not available.");
    }

    let analysis: Record<string, unknown> | null = null;
    if (outputMode === "analysis") {
      const frameReferences = frames.filter((frame) => frame.imageReference).map((frame) => frame.imageReference as string);
      if (frameReferences.length) {
        analysis = await this.analyze({ url }, { frameReferences, includeTranscript: false });
      } else {
        analysis = {
          success: false,
          analysis_ready: false,
          frames_inspected: [],
          scene_changes: [],
          visible_text_ocr: [],
          objects_people: [],
          actions_events: [],
          audio_transcript_summary: { status: "not_requested", text: null, segments: [] },
          limitations: ["No decoded frame with a retrievable reference was available for frame-grounded analysis."],
        };
      }
    }

    const framesOk = frames.some((frame) => frame.inspected);
    let success: boolean;
    let error: string | null;
    let message: string | null;
    if (resolution.error === "blocked_url") {
      success = false;
      error = "blocked_url";
      message = resolution.message ?? "The URL was rejected by the SSRF guard.";
    } else if (framesOk || artifact) {
      success = true;
      error = null;
      message = null;
    } else {
      success = false;
      error = resolution.error ?? frameError ?? "FRAMES_UNAVAILABLE";
      message = resolution.message ?? frameMessage ?? "Neither decodable frames nor a downloadable public media file could be obtained.";
    }

    return {
      success,
      error,
      message,
      sourceUrl: url,
      resolvedUrl: resolution.resolvedUrl,
      mediaUrl: resolution.mediaUrl,
      platform: resolution.platform,
      mediaType: "video",
      outputMode,
      durationSeconds: resolution.metadata.durationSeconds,
      width: resolution.metadata.width,
      height: resolution.metadata.height,
      contentType: resolution.metadata.contentType ?? artifact?.contentType ?? null,
      frames,
      videoArtifact: artifact,
      audio,
      transcript,
      analysis,
      analysisReady: framesOk,
      challenge: resolution.challenge,
      limitations,
    };
  }

  /**
   * High-level automatic video understanding backing the `inspect_video` tool.
   *
   * This is the single entry point a connected AI calls when a user sends a
   * public video link — with or without a question like "react to this", "is
   * this real?", "what happens at the end?" or nothing at all. It resolves the
   * platform and actual media, plans an intent- and duration-aware frame
   * budget (first / middle / final meaningful frames, dense coverage for short
   * clips, focus-biased sampling), decodes real frames in Browser Run,
   * optionally attempts audio + transcription, and runs frame-grounded
   * scene / on-screen-text analysis when a server-side vision model exists.
   *
   * The result always states explicitly whether real visual evidence was
   * delivered (`visualEvidenceDelivered`) so the AI can never claim to have
   * watched a video it did not actually see.
   */
  async inspectVideo(url: string, options: InspectVideoOptions = {}): Promise<InspectVideoResult> {
    this.charge("inspect_video", url);
    const resolution = await this.resolve(url);
    return this.inspectVideoResolved(url, resolution, options);
  }

  /**
   * The `inspectVideo` body operating on an already completed resolution, so
   * `video_analyze` and `video_react` can resolve once (with byte verification
   * and stream ranking) and reuse the same frame/audio/transcript pipeline.
   */
  inspectVideoResolved(url: string, resolution: VideoResolution, options: InspectVideoOptions = {}): Promise<InspectVideoResult> {
    return this.runInspectVideo(url, resolution, options);
  }

  private async runInspectVideo(url: string, resolution: VideoResolution, options: InspectVideoOptions = {}): Promise<InspectVideoResult> {
    const intentInput = {
      userIntent: options.userIntent ?? null,
      question: options.question ?? null,
      reactionMode: options.reactionMode ?? null,
    };
    /**
     * One bounded consultation with the decision engine, when a deployment injects one.
     * The deterministic rules run first and win whenever they matched; the engine is
     * asked only when they did not, and every failure path — a throw, a timeout, a
     * malformed or out-of-set answer — leaves this intent untouched, because video
     * inspection must never depend on a third-party service being up. `applyIntentHook`
     * also refuses a focus outside `FOCUS_VALUES` and recomputes the curated vision hint,
     * so a provider response can never steer the prompt directly.
     */
    const { intent, decision } = await applyIntentHook(this.intentHook, intentInput, detectVideoIntent(intentInput));
    const includeMetadata = options.includeMetadata !== false;
    const includeAudio = options.includeAudio === true;
    const analyzeScenes = options.analyzeScenes !== false;
    const analyzeOnScreenText = options.analyzeOnScreenText !== false;

    const maxDuration = this.maxDuration();

    const buildSource = (decoded: { durationSeconds?: number | null; width?: number | null; height?: number | null; contentType?: string | null } = {}): InspectVideoResult["source"] => ({
      platform: resolution.platform,
      url,
      resolvedUrl: resolution.resolvedUrl,
      mediaUrl: resolution.mediaUrl,
      durationSeconds: decoded.durationSeconds ?? resolution.metadata.durationSeconds,
      width: decoded.width ?? resolution.metadata.width,
      height: decoded.height ?? resolution.metadata.height,
      contentType: includeMetadata ? (decoded.contentType ?? resolution.metadata.contentType) : null,
      title: includeMetadata ? resolution.metadata.title : null,
      description: includeMetadata ? resolution.metadata.description : null,
    });

    const intentPayload = {
      userIntent: intent.userIntent,
      question: intent.question,
      reactionMode: intent.reactionMode,
      focus: intent.focus,
      ...(decision ? { decision } : {}),
    };

    const failure = (error: string, message: string, extraLimitations: string[]): InspectVideoResult => ({
      inspectionStatus: "failed",
      source: buildSource(),
      intent: intentPayload,
      frames: [],
      detectedScenes: null,
      extractedText: null,
      audioStatus: null,
      transcript: null,
      framesDelivered: 0,
      imageBlocksDelivered: 0,
      visualEvidenceDelivered: false,
      error,
      message,
      challenge: resolution.challenge,
      limitations: [...new Set([...resolution.limitations, ...extraLimitations])],
      honestyNote:
        "No visual frames were delivered. The AI MUST NOT claim to have seen, watched, or inspected this video, and must not describe its content; report the error and limitations to the user instead.",
      responseGuidance:
        "Visual inspection did not complete. Tell the user honestly what failed and why (see error/limitations). Do not invent or assume anything about the video's content.",
    });

    // Policy gates before any browser time is spent.
    const maxBytes = this.maxDownloadBytes();
    if (resolution.metadata.contentLength !== null && resolution.metadata.contentLength > maxBytes) {
      return failure(
        "DOWNLOAD_TOO_LARGE",
        `The public video declares ${formatBytes(resolution.metadata.contentLength)}, above the ${formatBytes(maxBytes)} inspection limit.`,
        ["The declared size exceeded the deployment size policy; no frames were extracted."],
      );
    }
    if (resolution.metadata.durationSeconds !== null && resolution.metadata.durationSeconds > maxDuration) {
      return failure(
        "VIDEO_NOT_PUBLIC",
        `The video duration (${resolution.metadata.durationSeconds.toFixed(1)}s) exceeds the ${maxDuration}s processing limit.`,
        ["The duration policy is enforced before frame extraction."],
      );
    }
    if (resolution.error === "blocked_url") {
      return failure(resolution.error, resolution.message ?? "The URL was rejected by the SSRF guard.", [
        "The URL was rejected before any network or browser request was made.",
      ]);
    }

    // Intent-aware, duration-aware frame plan.
    const plannedCount = clamp(options.frameCount ?? planFrameCount(resolution.metadata.durationSeconds), 1, LIMITS.videoFramesMaxCount);
    const requestedTimestamps = (options.timestamps ?? []).filter((value) => Number.isFinite(value) && value >= 0);
    const explicitTimestamps = requestedTimestamps.filter((value) => value <= maxDuration).slice(0, LIMITS.videoFramesMaxCount).map((value) => Number(value.toFixed(3)));
    const droppedTimestamps = requestedTimestamps.length - explicitTimestamps.length;
    const plannedTimestamps = explicitTimestamps.length
      ? explicitTimestamps
      : resolution.metadata.durationSeconds !== null
        ? planFrameTimestamps(Math.min(resolution.metadata.durationSeconds, maxDuration), plannedCount, intent.focus as IntentFocus)
        : null;

    const ingested = await this.ingestResolved(url, resolution, {
      outputMode: "frames",
      frameCount: plannedCount,
      frameStrategy: "even",
      ...(plannedTimestamps ? { timestamps: plannedTimestamps } : {}),
      includeAudio,
      includeTranscript: false,
    });

    const limitations: string[] = [...ingested.limitations];
    if (droppedTimestamps > 0) {
      // Never silently sample past the duration policy or the frame cap.
      limitations.push(`${droppedTimestamps} requested timestamp(s) were dropped because they exceeded the ${maxDuration}s duration policy or the ${LIMITS.videoFramesMaxCount}-frame cap.`);
    }

    // Audio status + transcript: only when requested, always honest.
    let audioStatus: InspectVideoResult["audioStatus"] = null;
    let transcript: VideoTranscript | null = null;
    if (includeAudio) {
      const audio = ingested.audio;
      if (audio?.status === "audio_ready") {
        audioStatus = "available";
        if (audio.reference) {
          transcript = await this.transcribe({ videoReference: audio.reference }, {});
          if (transcript.status === "unavailable") limitations.push(transcript.message ?? "Speech-to-text was not available.");
        }
      } else if (audio?.status === "no_audio_track") {
        audioStatus = "unavailable";
        limitations.push("The decoded video stream has no audio track; no dialogue or sound is claimed. Visual analysis is unaffected.");
      } else {
        audioStatus = "failed";
        limitations.push("Audio extraction failed or is unsupported in this environment; no dialogue or sound is claimed. Visual analysis is unaffected.");
      }
    }

    // Frame-grounded scene / on-screen-text analysis (optional vision model).
    let detectedScenes: InspectVideoScene[] | null = null;
    let extractedText: string[] | null = null;
    const sceneHints = new Map<number, string>();
    if (analyzeScenes || analyzeOnScreenText) {
      const frameReferences = ingested.frames.filter((frame) => frame.inspected && frame.imageReference).map((frame) => frame.imageReference as string);
      if (!frameReferences.length && ingested.frames.some((frame) => frame.inspected)) {
        limitations.push("Scene/text analysis needs frames with retrievable storage references; frame storage (R2) is unavailable in this deployment.");
      } else if (frameReferences.length) {
        const analysis = await this.analyze({ url }, { frameReferences, includeTranscript: false, promptHint: intent.analysisHint });
        const analysisReady = Boolean((analysis as { analysis_ready?: boolean }).analysis_ready);
        if (analyzeScenes) {
          const changes = ((analysis.scene_changes ?? []) as Array<{ timestamp?: number; scene_change?: unknown }>).filter(
            (entry) => entry?.scene_change !== undefined && entry?.scene_change !== null && entry?.scene_change !== "",
          );
          if (changes.length) {
            detectedScenes = changes.map((entry, index) => ({
              start: Number(entry.timestamp ?? 0),
              end: index + 1 < changes.length ? Number(changes[index + 1].timestamp ?? 0) : (ingested.durationSeconds ?? null),
              significance: boundedSignificance(entry.scene_change),
            }));
          } else {
            limitations.push(
              analysisReady
                ? "The vision model reported no distinct scene changes in the analyzed frames."
                : "Scene detection was requested but no server-side vision model returned scene labels; the frame plan still covers the beginning, middle and end.",
            );
          }
        }
        if (analyzeOnScreenText) {
          const texts = ((analysis.visible_text_ocr ?? []) as Array<{ text?: unknown }>).flatMap((entry) =>
            Array.isArray(entry?.text) ? entry.text.map(String) : entry?.text ? [String(entry.text)] : [],
          );
          const unique = [...new Set(texts.map((value) => value.trim()).filter(Boolean))].slice(0, 50).map((value) => value.slice(0, 300));
          if (unique.length) extractedText = unique;
          else
            limitations.push(
              analysisReady
                ? "No legible on-screen text was found in the analyzed frames."
                : "On-screen text extraction was requested but no server-side vision/OCR model was available; read any text directly from the returned frame images instead.",
            );
        }
        for (const entry of (analysis.actions_events ?? []) as Array<{ timestamp?: number; items?: unknown }>) {
          const items = Array.isArray(entry?.items) ? entry.items.map(String).filter(Boolean) : [];
          if (items.length) sceneHints.set(Number(entry.timestamp ?? -1), items.slice(0, 2).join("; ").slice(0, 200));
        }
        for (const limitation of (analysis.limitations ?? []) as string[]) {
          if (limitation.startsWith("Vision analysis failed") && !limitations.includes(limitation)) limitations.push(limitation);
        }
      }
    }

    // Map decoded frames to deliverable evidence, respecting the inline budget.
    const frames: InspectVideoFrame[] = [];
    let inlineTotal = 0;
    for (const frame of ingested.frames) {
      if (!frame.inspected) continue; // undecodable frames stay limitations, never evidence
      let imageBlockIndex: number | null = null;
      if (frame.inlineData) {
        const approximateBytes = Math.ceil(frame.inlineData.length * 0.75);
        if (inlineTotal + approximateBytes <= LIMITS.videoInlineMaxTotalBytes) {
          imageBlockIndex = frames.filter((entry) => entry.imageBlockIndex !== null).length;
          inlineTotal += approximateBytes;
        }
      }
      frames.push({
        timestamp: frame.timestamp,
        mimeType: frame.contentType,
        bytes: frame.bytes,
        imageBlockIndex,
        imageReference: frame.imageReference,
        ...(frame.inlineData && imageBlockIndex !== null ? { inlineData: frame.inlineData } : {}),
        sceneDescriptionHint: sceneHints.get(frame.timestamp) ?? null,
      });
    }

    const framesDelivered = frames.length;
    const imageBlocksDelivered = frames.filter((frame) => frame.imageBlockIndex !== null).length;
    const attemptedFrames = ingested.frames.length;
    const failedCaptures = attemptedFrames - framesDelivered;
    const plannedShortfall = plannedTimestamps ? Math.max(0, plannedTimestamps.length - attemptedFrames) : 0;

    let inspectionStatus: InspectVideoResult["inspectionStatus"];
    if (!framesDelivered) inspectionStatus = "failed";
    else if (imageBlocksDelivered === 0 || failedCaptures > 0 || plannedShortfall > 0 || (includeAudio && audioStatus === "failed") || ingested.error) inspectionStatus = "partial";
    else inspectionStatus = "complete";

    if (imageBlocksDelivered === 0 && framesDelivered > 0) {
      limitations.push(
        "Frames were decoded and stored, but none travelled as inline MCP image blocks (inline size budget exhausted or storage-only delivery); the client can still retrieve them from the frame imageReference URLs while they are valid.",
      );
    }

    const audioClause = audioStatus === "available" ? "" : ", and do not describe audio, dialogue, or sound effects (no verified audio track)";
    const honestyNote = framesDelivered
      ? `${framesDelivered} real decoded frame(s) were delivered (${imageBlocksDelivered} as MCP image content blocks). They are sampled frames, not continuous playback: do not claim to have watched the full video${audioClause}. Never invent events outside these frames, and state uncertainty where the frames do not establish something.`
      : "No visual frames were delivered. The AI MUST NOT claim to have seen, watched, or inspected this video, and must not describe its content; report the error and limitations to the user instead.";

    const responseGuidance = !framesDelivered
      ? "Visual inspection did not complete. Tell the user honestly what failed and why (see error/limitations). Do not invent or assume anything about the video's content."
      : intent.reactionMode
        ? "Reaction mode: the user wants your genuine take, not a metadata report. Examine the frame images first, then react naturally to what actually happens — match the user's tone, anchor the reaction in specific visible moments (with timestamps), and stay honest about what sampled frames cannot verify (audio, off-screen context, whether it is staged)."
        : "Answer the user's question from what is visible in the returned frames. Reference timestamps, distinguish what you see from what you infer, and mention uncertainty where the sampled frames do not establish something.";

    return {
      inspectionStatus,
      source: buildSource({
        durationSeconds: ingested.durationSeconds,
        width: ingested.width,
        height: ingested.height,
        contentType: ingested.contentType,
      }),
      intent: intentPayload,
      frames,
      detectedScenes,
      extractedText,
      audioStatus,
      transcript,
      framesDelivered,
      imageBlocksDelivered,
      visualEvidenceDelivered: framesDelivered > 0,
      error: framesDelivered ? null : (ingested.error ?? resolution.error ?? "FRAMES_UNAVAILABLE"),
      message: framesDelivered ? null : (ingested.message ?? resolution.message ?? "No decoded frames could be extracted from the public video."),
      challenge: resolution.challenge,
      limitations: [...new Set(limitations)],
      honestyNote,
      responseGuidance,
    };
  }

  /**
   * Stage-by-stage diagnostic for the public video pipeline.
   *
   * Runs the real stages in order and records each one's outcome, so it is
   * obvious where a failure happens: URL validation, redirect resolution,
   * media discovery, browser access, actual media retrieval (bounded sample),
   * frame extraction, R2 upload (round-trip + cleanup), artifact URL
   * generation, and MCP response serialization.
   *
   * The report never contains credentials, request bodies or page text: only
   * validated public URLs, counts, sizes, durations and redacted error text.
   * Media retrieval samples at most 64 KiB with a normal ranged public GET; it
   * does not download or store the full file.
   */
  async inspectPipeline(url: string, options: { includeDownload?: boolean; includeFrames?: boolean } = {}): Promise<VideoPipelineReport> {
    this.charge("pipeline", url);
    const includeDownload = options.includeDownload !== false;
    const includeFrames = options.includeFrames !== false;
    const stages: PipelineStageReport[] = [];
    const push = (stage: PipelineStageReport["stage"], status: PipelineStageReport["status"], detail: Record<string, unknown>, error: string | null, startedAt: number): void => {
      stages.push({ stage, status, detail: redactedDetail(detail), error: error ? redactText(error, 400) : null, durationMs: Math.max(0, Date.now() - startedAt) });
    };
    const finish = (overall: VideoPipelineReport["overall"], message: string | null): VideoPipelineReport => {
      const firstFailure = stages.find((stage) => stage.status === "failed")?.stage ?? null;
      return { url, overall, firstFailure, stages, message };
    };

    // 1. URL validation (same SSRF guard + DoH policy as the resolver).
    {
      const startedAt = Date.now();
      try {
        const guarded = await assertNavigableUrl(url, videoGuardOptions(this.env));
        push("url_validation", "ok", { url: guarded.url }, null, startedAt);
      } catch (error) {
        const normal = asBrowserError(error);
        push("url_validation", "failed", {}, `${normal.code}: ${normal.message}`, startedAt);
        return finish("failed", "The URL failed validation before any network request was made.");
      }
    }

    // 2+3. Redirect resolution and media discovery share one bounded public
    // fetch, so both stages report on the same resolution.
    let resolution: VideoResolution | null = null;
    {
      // One bounded public fetch backs both stages: it follows safe redirects
      // (redirect_resolution) and reads the page for literal media candidates
      // (media_discovery).
      const startedAt = Date.now();
      resolution = await this.resolve(url);
      push("redirect_resolution", resolution.success || resolution.resolvedUrl ? "ok" : "failed", {
        platform: resolution.platform,
        resolved_url: resolution.resolvedUrl,
        redirects: resolution.redirects.length,
        challenge: resolution.challenge,
      }, resolution.success || resolution.resolvedUrl ? null : `${resolution.error}: ${resolution.message ?? "the public page could not be fetched"}`, startedAt);
      push("media_discovery", resolution.mediaUrl ? "ok" : "failed", {
        media_url: resolution.mediaUrl,
        candidate_count: resolution.candidateCount,
        title: (resolution.metadata.title ?? "").slice(0, 200) || null,
        duration_seconds: resolution.metadata.durationSeconds,
        content_type: resolution.metadata.contentType,
      }, resolution.mediaUrl ? null : `${resolution.error}: ${resolution.message ?? "no literal public media URL was exposed"}`, startedAt);
    }

    // 4. Browser access: open the best known public URL in Browser Run.
    {
      const startedAt = Date.now();
      const capabilities = new SessionManager(this.env as never, this.requestUrl).capabilities();
      const target = resolution?.resolvedUrl ?? resolution?.mediaUrl ?? url;
      if (!capabilities.browserAvailable) {
        push("browser_access", "failed", { provider: capabilities.provider, available: false }, capabilities.reason ?? "browser unavailable", startedAt);
      } else {
        try {
          const sessions = new SessionManager(this.env as never, this.requestUrl);
          const info = await sessions.withRawPage(async (raw: any) => {
            const page = new PuppeteerPageHandle(raw);
            await page.goto(target, { waitUntil: "domcontentloaded", timeoutMs: LIMITS.videoResolveTimeoutMs });
            return { finalUrl: page.url(), title: await page.title() };
          });
          push("browser_access", "ok", { provider: capabilities.provider, final_url: info.finalUrl, title: (info.title ?? "").slice(0, 200) || null, video_elements: null }, null, startedAt);
        } catch (error) {
          const normal = asBrowserError(error);
          push("browser_access", "failed", { provider: capabilities.provider, final_url: target }, `${normal.code}: ${normal.message}`, startedAt);
        }
      }
    }

    // 5. Actual media retrieval: bounded ranged sample of the first 64 KiB.
    if (!resolution?.mediaUrl) {
      push("media_retrieval", includeDownload ? "skipped" : "skipped", { reason: includeDownload ? "no literal media URL was discovered" : "download sampling was not requested" }, null, Date.now());
    } else {
      const startedAt = Date.now();
      try {
        const result = await fetchPublic(
          resolution.mediaUrl,
          this.env,
          { method: "GET", headers: { range: "bytes=0-65535", accept: "video/*,application/octet-stream;q=0.8" } },
          { timeoutMs: LIMITS.videoResolveTimeoutMs, referer: resolution.resolvedUrl ?? url },
        );
        const bytes = await readBounded(result.response, 65_536, LIMITS.videoResolveTimeoutMs);
        const type = contentType(result.response);
        push("media_retrieval", "ok", {
          http_status: result.response.status,
          final_url: result.finalUrl,
          content_type: type,
          bytes_sampled: bytes.byteLength,
          sample_shape: sampleShape(bytes),
        }, null, startedAt);
      } catch (error) {
        const normal = asBrowserError(error);
        push("media_retrieval", "failed", { media_url: resolution.mediaUrl }, `${normal.code}: ${normal.message}`, startedAt);
      }
    }

    // 6. Frame extraction through Browser Run (inline off: the diagnostic does
    // not need base64 in the payload, frames are still stored in R2).
    {
      const startedAt = Date.now();
      if (!includeFrames) {
        push("frame_extraction", "skipped", { reason: "frame extraction was not requested" }, null, startedAt);
      } else if (!new SessionManager(this.env as never, this.requestUrl).capabilities().browserAvailable) {
        push("frame_extraction", "skipped", { reason: "browser unavailable; frames cannot be decoded without Browser Run" }, null, startedAt);
      } else {
        const frameSource = resolution?.success && resolution.mediaUrl ? resolution.mediaUrl : resolution?.resolvedUrl ?? url;
        try {
          const captured = await this.extractFramesFromSource(frameSource, { frameInterval: LIMITS.videoFramesDefaultIntervalSeconds, maxFrameCount: Math.min(4, LIMITS.videoFramesMaxCount), inline: false }, looksLikeMediaUrl(frameSource));
          push("frame_extraction", captured.success ? "ok" : "failed", {
            source: frameSource,
            frames_captured: captured.frames.filter((frame) => frame.inspected).length,
            frames_total: captured.frames.length,
            duration_seconds: captured.durationSeconds,
            width: captured.width,
            height: captured.height,
          }, captured.success ? null : `${captured.error ?? "FRAMES_UNAVAILABLE"}: ${captured.message ?? "no decoded frame could be captured"}`, startedAt);
        } catch (error) {
          const normal = asBrowserError(error);
          push("frame_extraction", "failed", { source: frameSource }, `${normal.code}: ${normal.message}`, startedAt);
        }
      }
    }

    // 7. R2 upload: real put + read-back + cleanup round trip.
    {
      const startedAt = Date.now();
      const bucket = this.env.SCREENSHOTS as { get?: (key: string) => Promise<any>; delete?: (key: string) => Promise<unknown> } | undefined;
      if (!this.screenshots.available) {
        push("r2_upload", "failed", {}, this.screenshots.unavailableReason() ?? "R2 storage is not configured", startedAt);
      } else if (!bucket?.get) {
        push("r2_upload", "failed", {}, "The R2 binding does not expose reads, so the upload could not be verified.", startedAt);
      } else {
        try {
          const marker = new TextEncoder().encode("demo-mcp video pipeline diagnostic");
          const stored = await this.screenshots.store(marker, "jpeg", { source: "video_inspect_pipeline" });
          const key = `screenshots/${stored.id}`;
          const object = await bucket.get(key);
          if (!object) throw new Error("the object could not be read back from R2");
          const readBytes = object.arrayBuffer ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array(await readStreamBytes(object.body as ReadableStream<Uint8Array>));
          const verified = readBytes.byteLength === marker.byteLength;
          await bucket.delete?.(key).catch(() => undefined);
          push("r2_upload", verified ? "ok" : "failed", { key_prefix: "screenshots/", stored_bytes: stored.bytes, read_back_bytes: readBytes.byteLength, cleaned: true }, verified ? null : "the read-back bytes did not match the upload", startedAt);
        } catch (error) {
          push("r2_upload", "failed", {}, error instanceof Error ? error.message : String(error), startedAt);
        }
      }
    }

    // 8. Artifact URL generation: verify storage availability and the URL
    // contract used by /video-assets/<reference>.
    {
      const startedAt = Date.now();
      const sampleHash = "a".repeat(64);
      const parsed = this.artifacts.parse(`video_${sampleHash}`);
      push("artifact_url_generation", this.artifacts.available ? "ok" : "failed", {
        base_url: this.artifacts.baseUrl,
        route: "/video-assets/video_<sha256-hex-64>",
        ttl_seconds: this.artifacts.ttlSeconds,
        sample_reference: parsed ? `video_${sampleHash.slice(0, 8)}…` : null,
        note: "diagnostic mode samples the media; run video_ingest to store a full artifact",
      }, this.artifacts.available ? null : this.artifacts.unavailableReason(), startedAt);
    }

    // 9. MCP response serialization: what the client would actually receive.
    {
      const startedAt = Date.now();
      const preview = finish(
        stages.some((stage) => stage.status === "failed" && stage.stage === "url_validation")
          ? "failed"
          : stages.some((stage) => stage.status === "failed")
            ? "partial"
            : "ok",
        null,
      );
      const serialized = JSON.stringify(preview, null, 2);
      push("mcp_serialization", "ok", {
        format: "MCP content array: [{ type: \"text\", text: <this JSON> }]",
        payload_bytes: serialized.length,
        image_blocks: 0,
        contains_secrets: false,
      }, null, startedAt);
    }

    const overall: VideoPipelineReport["overall"] = stages.some((stage) => stage.stage === "url_validation" && stage.status === "failed")
      ? "failed"
      : stages.some((stage) => stage.status === "failed")
        ? "partial"
        : "ok";
    const firstFailure = stages.find((stage) => stage.status === "failed")?.stage ?? null;
    const message = firstFailure
      ? `The pipeline reached ${firstFailure} and failed there; inspect that stage's error and the stages before it for the full context.`
      : "Every executed stage completed; skipped stages were not applicable to this URL or this environment.";
    return { url, overall, firstFailure, stages, message };
  }

  async download(url: string, requestedMb?: number): Promise<{ resolution: VideoResolution; artifact: VideoArtifact | null; error?: string; message?: string }> {
    this.charge("download", url);
    const resolution = await this.resolve(url);
    return this.downloadResolved(resolution, requestedMb);
  }

  /**
   * Download an already resolved media URL to expiring R2 storage. Shared by
   * `download()` (which resolves first) and `ingest()` (which reuses its own
   * resolution so the page is fetched once, not twice).
   */
  /**
   * Download an already resolved media URL to expiring R2 storage. Shared by
   * `download()` (which resolves first) and `ingest()` (which reuses its own
   * resolution so the page is fetched once, not twice).
   *
   * This is the same streaming pipeline as `video_fetch`: the body is piped
   * into R2 through `storeStream` (never buffered whole), the container is
   * proven from its byte signature, the duration policy is verified from page
   * metadata, the head sample or a bounded tail read, and any verification
   * failure deletes the partial object. The response contract is unchanged —
   * `{ resolution, artifact }` with a content-addressed `video_<sha256>`
   * artifact on success — so `video_download_public` and `video_ingest` keep
   * their documented shape while gaining the hardened retrieval path.
   */
  async downloadResolved(resolution: VideoResolution, requestedMb?: number): Promise<{ resolution: VideoResolution; artifact: VideoArtifact | null; error?: string; message?: string }> {
    if (!resolution.success || !resolution.mediaUrl) return { resolution, artifact: null };
    const maxBytes = this.maxDownloadBytes(requestedMb);
    const maxDuration = this.maxDuration();
    const fail = (error: string, message: string): { resolution: VideoResolution; artifact: VideoArtifact | null; error: string; message: string } => ({ resolution, artifact: null, error, message });

    // Declared-size gate before any bytes are pulled.
    if (resolution.metadata.contentLength !== null && resolution.metadata.contentLength > maxBytes) {
      return fail("DOWNLOAD_TOO_LARGE", `The stream declares ${formatBytes(resolution.metadata.contentLength)}, above the ${formatBytes(maxBytes)} policy limit.`);
    }

    let responseResult: Awaited<ReturnType<typeof fetchPublic>>;
    try {
      responseResult = await fetchPublic(resolution.mediaUrl, this.env, { method: "GET", headers: { accept: "video/*,application/octet-stream;q=0.8" } }, { timeoutMs: LIMITS.videoDownloadTimeoutMs, referer: resolution.resolvedUrl ?? resolution.sourceUrl });
    } catch (error) {
      const normal = asBrowserError(error);
      return fail(normal.code, normal.message);
    }
    const response = responseResult.response;
    const type = contentType(response) ?? resolution.metadata.contentType;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return fail("VIDEO_NOT_PUBLIC", `The public media URL returned HTTP ${response.status}.`);
    }
    if (isPlaylistContentType(type, responseResult.finalUrl)) {
      await response.body?.cancel().catch(() => undefined);
      return fail("UNSUPPORTED_MEDIA", "The public URL is an HLS playlist, not a bounded video file. Browser playback may still work when the platform exposes it normally.");
    }
    if (!isVideoContentType(type) && !looksLikeMediaUrl(responseResult.finalUrl)) {
      await response.body?.cancel().catch(() => undefined);
      return fail("UNSUPPORTED_MEDIA", `The public media response is not a supported video content type${type ? ` (${type})` : ""}.`);
    }
    // Second size gate: the response's own Content-Length may disagree with the
    // probe. Refuse before a single byte is streamed.
    const declaredLength = parseLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return fail("DOWNLOAD_TOO_LARGE", `The media response declares ${formatBytes(declaredLength)}, above the ${formatBytes(maxBytes)} policy limit, so the body was never streamed.`);
    }
    if (!this.artifacts.available) {
      await response.body?.cancel().catch(() => undefined);
      return fail("capability_unavailable", this.artifacts.unavailableReason());
    }

    const artifactType = isVideoContentType(type) ? (type as string) : "video/mp4";
    const storeMetadata = {
      durationSeconds: resolution.metadata.durationSeconds,
      width: resolution.metadata.width,
      height: resolution.metadata.height,
      source: resolution.sourceUrl,
    };

    // Stream when the runtime gives us a body; fall back to a bounded buffered
    // read only when there is no stream to pipe (e.g. an empty mock body).
    // Either way the bytes are signature- and duration-verified and the partial
    // object is deleted on failure — the buffered path verifies before storing
    // so there is never a partial object to clean up.
    if (!response.body) {
      let bytes: Uint8Array;
      try {
        bytes = await readBounded(response, maxBytes, LIMITS.videoDownloadTimeoutMs);
      } catch (error) {
        const normal = asBrowserError(error);
        return fail(normal.code, normal.message);
      }
      const signature = detectMediaSignature(bytes.subarray(0, LIMITS.videoHeadProbeBytes), type);
      if (!signature.isVideo) {
        return fail("NOT_A_VIDEO", notAVideoMessage(signature));
      }
      const duration = resolution.metadata.durationSeconds ?? durationFromSample(bytes.subarray(0, LIMITS.videoHeadProbeBytes), signature) ?? durationFromSample(bytes.subarray(Math.max(0, bytes.byteLength - LIMITS.videoTailProbeBytes)), signature);
      if (duration === null) {
        return fail("UNSUPPORTED_MEDIA", "The public video duration could not be verified from page metadata or the container headers of the retrieved bytes, so DEMO refused to persist it.");
      }
      if (duration > maxDuration) {
        return fail("VIDEO_NOT_PUBLIC", `The video duration (${duration.toFixed(1)}s) exceeds the ${maxDuration}s processing limit.`);
      }
      try {
        const artifact = await this.artifacts.store(bytes, "video", artifactType, {
          durationSeconds: duration,
          width: resolution.metadata.width,
          height: resolution.metadata.height,
          source: resolution.sourceUrl,
        });
        await this.artifacts.patchMetadata(artifact.reference, { durationSeconds: String(duration), verifiedContainer: signature.container ?? signature.detectedAs });
        const resolved: VideoResolution = {
          ...resolution,
          status: "downloaded",
          metadata: { ...resolution.metadata, contentType: type, contentLength: bytes.byteLength, durationSeconds: duration },
        };
        return { resolution: resolved, artifact: { ...artifact, durationSeconds: duration } };
      } catch (error) {
        const normal = asBrowserError(error);
        return fail(normal.code, normal.message);
      }
    }

    let outcome: StreamStoreOutcome;
    try {
      outcome = await this.artifacts.storeStream(response.body, "video", artifactType, storeMetadata, {
        maxBytes,
        headBytes: LIMITS.videoHeadProbeBytes,
        digestBufferBytes: LIMITS.videoDigestBufferBytes,
        timeoutMs: LIMITS.videoDownloadTimeoutMs,
      });
    } catch (error) {
      const normal = asBrowserError(error);
      return fail(normal.code, normal.message);
    }
    if (outcome.aborted || !outcome.artifact) {
      return fail(outcome.aborted?.code ?? "PROCESSING_TIMEOUT", outcome.aborted?.message ?? "The video body could not be stored.");
    }

    // Prove the bytes are really a video; delete the partial object otherwise.
    const signature = detectMediaSignature(outcome.head, type);
    if (!signature.isVideo) {
      await this.artifacts.delete(outcome.artifact.reference);
      return fail("NOT_A_VIDEO", notAVideoMessage(signature));
    }

    // Verify the duration policy from real container data: page metadata, else
    // the head sample, else a bounded tail range read of the stored object.
    let duration = resolution.metadata.durationSeconds;
    let durationSource: string | null = duration !== null ? "page_metadata" : null;
    if (duration === null) {
      const fromHead = durationFromSample(outcome.head, signature);
      if (fromHead !== null) {
        duration = fromHead;
        durationSource = "head_sample";
      }
    }
    if (duration === null) {
      const tail = await this.artifacts.getRange(outcome.artifact.reference, Math.max(0, outcome.bytes - LIMITS.videoTailProbeBytes), LIMITS.videoTailProbeBytes);
      const fromTail = tail ? durationFromSample(tail.bytes, signature) : null;
      if (fromTail !== null) {
        duration = fromTail;
        durationSource = "artifact_tail";
      }
    }
    if (duration === null) {
      await this.artifacts.delete(outcome.artifact.reference);
      return fail("UNSUPPORTED_MEDIA", `The container signature verified as ${signature.container ?? signature.detectedAs}, but no duration could be read from page metadata or the ISO-BMFF/EBML headers of the streamed bytes, so DEMO refused to persist it.`);
    }
    if (duration > maxDuration) {
      await this.artifacts.delete(outcome.artifact.reference);
      return fail("VIDEO_NOT_PUBLIC", `The video duration (${duration.toFixed(1)}s) exceeds the ${maxDuration}s processing limit.`);
    }

    // The legacy contract is content-addressed: promote the streamed token
    // object to its `video_<sha256>` key when the digest is known. The verified
    // duration/container ride along in the same copy. When the runtime could
    // not digest the stream (Node fallback past the buffer bound) the token
    // artifact is kept and patched in place instead of faking a hash.
    let artifact: VideoArtifact = outcome.artifact;
    const verifiedPatch: Record<string, string> = {
      durationSeconds: String(duration),
      ...(durationSource ? { durationSource } : {}),
      verifiedContainer: signature.container ?? signature.detectedAs,
    };
    if (outcome.sha256) {
      const promoted = await this.artifacts.promoteToContentAddress(
        outcome.artifact.reference,
        outcome.sha256,
        {
          bytes: outcome.bytes,
          contentType: artifactType,
          durationSeconds: duration,
          width: resolution.metadata.width,
          height: resolution.metadata.height,
          expiresAt: outcome.artifact.expiresAt,
        },
        verifiedPatch,
      );
      if (promoted) {
        artifact = promoted;
      } else {
        await this.artifacts.patchMetadata(artifact.reference, verifiedPatch);
        artifact = { ...artifact, durationSeconds: duration, sha256: outcome.sha256 };
      }
    } else {
      await this.artifacts.patchMetadata(artifact.reference, verifiedPatch);
      artifact = { ...artifact, durationSeconds: duration };
    }

    const resolved: VideoResolution = {
      ...resolution,
      status: "downloaded",
      metadata: { ...resolution.metadata, contentType: type, contentLength: outcome.bytes, durationSeconds: duration },
    };
    return { resolution: resolved, artifact };
  }

  async extractFrames(input: VideoInput, request: FrameRequest = {}): Promise<FrameCaptureResult> {
    this.charge("frames", input.videoReference ?? input.url ?? "");
    const source = await this.resolveInput(input);
    if (!source.success || !source.sourceUrl) {
      if (input.url && source.error !== "blocked_url") {
        const rendered = await this.extractFramesFromSource(input.url, request, looksLikeMediaUrl(input.url));
        if (rendered.success) return rendered;
        return { ...rendered, error: source.error ?? rendered.error ?? "FRAMES_UNAVAILABLE", message: source.message ?? rendered.message, limitations: [...source.limitations, ...rendered.limitations] };
      }
      return { success: false, error: source.error ?? "VIDEO_NOT_FOUND", message: source.message ?? "No public video source was found.", sourceUrl: input.url ?? input.videoReference ?? "", durationSeconds: source.metadata.durationSeconds, width: source.metadata.width, height: source.metadata.height, frames: [], limitations: source.limitations };
    }
    const maxDuration = this.maxDuration();
    if (request.timestamps?.some((timestamp) => !Number.isFinite(timestamp) || timestamp < 0 || timestamp > maxDuration || (source.metadata.durationSeconds !== null && timestamp > source.metadata.durationSeconds))) {
      return { success: false, error: "FRAMES_UNAVAILABLE", message: "A requested timestamp is outside the known video duration.", sourceUrl: source.sourceUrl, durationSeconds: source.metadata.durationSeconds, width: source.metadata.width, height: source.metadata.height, frames: [], limitations: ["video_get_frame and explicit frame timestamps must fall within the public video's decoded duration."] };
    }
    const times = request.timestamps?.length ? request.timestamps : frameTimestamps(source.metadata.durationSeconds, request, maxDuration);
    const result = await this.extractFramesFromSource(source.sourceUrl, { ...request, timestamps: times });
    return result;
  }

  async getFrame(input: VideoInput, timestamp: number): Promise<FrameCaptureResult> {
    return this.extractFrames(input, { timestamps: [Math.max(0, timestamp)], maxFrameCount: 1, inline: true });
  }

  async extractAudio(input: VideoInput, options: { maxSeconds?: number } = {}): Promise<{ success: boolean; artifact: VideoArtifact | null; status: string; error?: string; message?: string; durationSeconds: number | null }> {
    this.charge("audio", input.videoReference ?? input.url ?? "");
    const source = await this.resolveInput(input);
    const sourceIsPageFallback = !source.success && Boolean(input.url) && source.error !== "blocked_url";
    const sourceUrl = source.sourceUrl ?? (sourceIsPageFallback ? input.url ?? null : null);
    if (!sourceUrl) return { success: false, artifact: null, status: "unavailable", error: source.error ?? "VIDEO_NOT_FOUND", message: source.message ?? "No public video source was found.", durationSeconds: source.metadata.durationSeconds };
    try {
      const sourceUrlForBrowser = sourceUrl;
      const sessions = new SessionManager(this.env as never, this.requestUrl);
      const captured = await sessions.withRawPage(async (raw: any) => {
        const page = new PuppeteerPageHandle(raw);
        await page.goto(sourceUrlForBrowser, { waitUntil: "domcontentloaded", timeoutMs: LIMITS.videoResolveTimeoutMs });
        await page.waitForTimeout(1_000);
        let info = await this.media.inspect(page);
        if (!info.media.videos.length && !sourceIsPageFallback) {
          await page.evaluate(installPublicVideo, { src: sourceUrlForBrowser, timeoutMs: 8_000 });
          await page.waitForTimeout(1_000);
          info = await this.media.inspect(page);
        }
        if (!info.media.videos.length) return { status: "error" as const, mimeType: null, base64: null, bytes: 0, durationSeconds: null, message: "The public page did not expose an HTML5 video element to Browser Run." };
        return await page.evaluate(capturePublicAudio, {
          index: 0,
          maxSeconds: Math.min(options.maxSeconds ?? LIMITS.videoAudioMaxSeconds, this.maxDuration()),
          maxBytes: LIMITS.videoAudioMaxBytes,
        });
      });
      if (captured.status !== "ok" || !captured.base64) {
        return { success: captured.status === "no_audio_track", artifact: null, status: captured.status, error: captured.status === "no_audio_track" ? undefined : "TRANSCRIPTION_UNAVAILABLE", message: captured.message ?? "The browser could not extract an audio track.", durationSeconds: captured.durationSeconds };
      }
      const bytes = base64ToBytes(captured.base64);
      const artifact = await this.artifacts.store(bytes, "audio", captured.mimeType ?? "audio/webm", { durationSeconds: captured.durationSeconds, source: sourceUrl });
      return { success: true, artifact, status: "audio_ready", durationSeconds: captured.durationSeconds };
    } catch (error) {
      const normal = asBrowserError(error);
      return { success: false, artifact: null, status: "unavailable", error: normal.code, message: normal.message, durationSeconds: source.metadata.durationSeconds };
    }
  }

  async transcribe(input: VideoInput, options: { language?: string; autoExtract?: boolean; durationSeconds?: number | null } = {}): Promise<VideoTranscript> {
    this.charge("transcribe", input.videoReference ?? input.url ?? "");
    const ai = this.aiBinding();
    if (!ai && !this.env.TRANSCRIPTION_ENDPOINT) {
      return { status: "unavailable", language: options.language ?? null, text: null, segments: [], provider: null, message: "TRANSCRIPTION_UNAVAILABLE: no Cloudflare AI or server-side speech-to-text provider is configured." };
    }
    let audioBytes: Uint8Array | null = null;
    let audioType = "audio/webm";
    let duration = options.durationSeconds ?? null;
    if (input.videoReference && this.artifacts.parse(input.videoReference)?.kind === "audio") {
      const stored = await this.artifacts.get(input.videoReference);
      if (stored) {
        audioBytes = stored.bytes;
        audioType = stored.contentType;
        duration = duration ?? (Number(stored.metadata.durationSeconds ?? "") || null);
      }
    } else if (input.videoReference || input.url) {
      const audio = await this.extractAudio(input);
      if (!audio.success || !audio.artifact) return { status: "unavailable", language: options.language ?? null, text: null, segments: [], provider: null, message: audio.message ?? "TRANSCRIPTION_UNAVAILABLE: no accessible audio track." };
      const stored = await this.artifacts.get(audio.artifact.reference);
      if (stored) {
        audioBytes = stored.bytes;
        audioType = stored.contentType;
        duration = duration ?? audio.durationSeconds;
      }
    }
    if (!audioBytes?.byteLength) return { status: "unavailable", language: options.language ?? null, text: null, segments: [], provider: null, message: "TRANSCRIPTION_UNAVAILABLE: no audio artifact was available." };

    if (ai) {
      try {
        const model = this.env.VIDEO_TRANSCRIPTION_MODEL ?? "@cf/openai/whisper";
        const audioCopy = new Uint8Array(audioBytes.byteLength);
        audioCopy.set(audioBytes);
        const raw = await ai.run(model, { audio: audioCopy.buffer, language: options.language });
        return normaliseTranscript(raw, options.language ?? raw?.language ?? null, duration, `cloudflare-ai:${model}`);
      } catch (error) {
        return { status: "unavailable", language: options.language ?? null, text: null, segments: [], provider: "cloudflare-ai", message: `TRANSCRIPTION_UNAVAILABLE: the configured speech-to-text provider rejected the audio (${safeVideoMessage(error, 300)}).` };
      }
    }

    // An explicitly configured endpoint is opt-in and remains server-side. We
    // still validate that it is HTTPS and never echo its API key.
    if (this.env.TRANSCRIPTION_ENDPOINT) {
      try {
        const endpoint = new URL(this.env.TRANSCRIPTION_ENDPOINT);
        if (endpoint.protocol !== "https:") throw new Error("TRANSCRIPTION_ENDPOINT must use https");
        const response = await fetch(endpoint.toString(), {
          method: "POST",
          headers: { "content-type": audioType, accept: "application/json", ...(this.env.TRANSCRIPTION_API_KEY ? { authorization: `Bearer ${this.env.TRANSCRIPTION_API_KEY}` } : {}) },
          body: (() => {
            const copy = new Uint8Array(audioBytes as Uint8Array);
            return copy.buffer;
          })(),
        });
        if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
        return normaliseTranscript(await response.json(), options.language ?? null, duration, "configured-transcription-endpoint");
      } catch (error) {
        return { status: "unavailable", language: options.language ?? null, text: null, segments: [], provider: "configured-transcription-endpoint", message: `TRANSCRIPTION_UNAVAILABLE: ${safeVideoMessage(error, 300)}` };
      }
    }

    return { status: "unavailable", language: options.language ?? null, text: null, segments: [], provider: null, message: "TRANSCRIPTION_UNAVAILABLE: no Cloudflare AI or server-side speech-to-text provider is configured." };
  }

  async analyze(input: VideoInput, options: { frameReferences?: string[]; includeTranscript?: boolean; promptHint?: string | null } = {}): Promise<Record<string, unknown>> {
    this.charge("analyze", input.videoReference ?? input.url ?? (options.frameReferences?.[0] ?? "frames"));
    let frameResult: FrameCaptureResult = { success: false, sourceUrl: input.url ?? input.videoReference ?? "", durationSeconds: null, width: null, height: null, frames: [], limitations: [] };
    if (options.frameReferences?.length) {
      frameResult = await this.loadFrameReferences(options.frameReferences);
    } else if (input.url || input.videoReference) {
      frameResult = await this.extractFrames(input, { frameInterval: LIMITS.videoFramesDefaultIntervalSeconds, maxFrameCount: LIMITS.videoMaxVisionFrames, inline: true });
    } else {
      frameResult.limitations.push("No video URL or retrievable frame reference was supplied.");
    }
    const transcript = options.includeTranscript === false || (!input.url && !input.videoReference) ? null : await this.transcribe(input, { autoExtract: true, durationSeconds: frameResult.durationSeconds });
    const visionResults: Array<Record<string, unknown>> = [];
    const ai = this.aiBinding();
    if (ai && frameResult.frames.length) {
      const model = this.env.VIDEO_VISION_MODEL ?? "@cf/llava-hf/llava-1.5-7b-hf";
      const basePrompt = "Inspect this video frame. Return compact JSON with visible_text, objects_people, actions_events, and scene_change. Do not infer anything outside the pixels.";
      // The hint is a curated focus string produced by DEMO's intent module —
      // never raw user text — so a hostile message cannot steer the model.
      const prompt = options.promptHint ? `${basePrompt} Request focus: ${redactText(options.promptHint, 300)}` : basePrompt;
      for (const frame of frameResult.frames.slice(0, LIMITS.videoMaxVisionFrames)) {
        if (!frame.inlineData) continue;
        try {
          const imageBytes = base64ToBytes(frame.inlineData);
          const imageCopy = new Uint8Array(imageBytes.byteLength);
          imageCopy.set(imageBytes);
          const raw = await ai.run(model, {
            image: imageCopy.buffer,
            prompt,
          });
          visionResults.push({ timestamp: frame.timestamp, result: sanitiseVision(raw) });
        } catch (error) {
          frameResult.limitations.push(`Vision analysis failed at ${frame.timestamp}s: ${safeVideoMessage(error, 180)}`);
        }
      }
    }
    const actualFrames = frameResult.frames.filter((frame) => frame.inspected);
    return {
      success: frameResult.success,
      analysis_ready: visionResults.length > 0,
      source_url: input.url ?? null,
      video_reference: input.videoReference ?? null,
      frames_inspected: actualFrames.map((frame) => ({ timestamp: frame.timestamp, image_reference: frame.imageReference })),
      scene_changes: visionResults.length ? visionResults.map((entry) => ({ timestamp: entry.timestamp, ...((entry.result as any)?.scene_change ? { scene_change: (entry.result as any).scene_change } : {}) })) : [],
      visible_text_ocr: visionResults.length ? visionResults.map((entry) => ({ timestamp: entry.timestamp, text: (entry.result as any)?.visible_text ?? [] })) : [],
      objects_people: visionResults.length ? visionResults.map((entry) => ({ timestamp: entry.timestamp, items: (entry.result as any)?.objects_people ?? [] })) : [],
      actions_events: visionResults.length ? visionResults.map((entry) => ({ timestamp: entry.timestamp, items: (entry.result as any)?.actions_events ?? [] })) : [],
      audio_transcript_summary: transcript
        ? { status: transcript.status, text: transcript.text, segments: transcript.segments }
        : { status: "not_requested", text: null, segments: [] },
      limitations: [
        ...frameResult.limitations,
        ...(transcript?.status === "unavailable" && transcript.message ? [transcript.message] : []),
        ...(visionResults.length ? [] : ["No vision/OCR provider returned frame-grounded labels. DEMO does not claim to have seen objects, text or actions without successfully inspected frames."]),
      ],
    };
  }

  /* ------------------------------------------------------------------------ */
  /* video_resolve — URL resolution with an honest access verdict              */
  /* ------------------------------------------------------------------------ */

  /**
   * Resolve a public video URL: follow the short link, identify the platform,
   * read the canonical video id / creator / caption / duration / dimensions and
   * collect every literal stream URL the page published, probing the best few
   * with normal public requests and verifying real bytes.
   *
   * The result always states *why* something is not available (`accessStatus`):
   * deleted, private, region-restricted, login wall, bot challenge, expired
   * signed URL, rate limit, not found, SSRF-blocked or unsupported container.
   * A thumbnail or metadata-only page is never reported as a resolved video.
   */
  async resolveDetailed(url: string, options: VideoResolveOptions = {}): Promise<VideoResolveResult> {
    this.charge("resolve", url);
    const verifyBytes = options.verifyBytes !== false;
    const includeSignedUrls = options.includeSignedUrls !== false;
    const resolution = await resolvePublicVideo(url, this.env, {
      quality: options.quality ?? "auto",
      probeLimit: LIMITS.videoMaxProbedStreams,
      verifyBytes,
    });
    return this.buildResolveResult(url, resolution, { verifyBytes, includeSignedUrls, platformHint: options.platform ?? "auto" });
  }

  private buildResolveResult(
    url: string,
    resolution: VideoResolution,
    options: { verifyBytes: boolean; includeSignedUrls: boolean; platformHint?: VideoPlatform | "auto" },
  ): VideoResolveResult {
    const detail = resolution.detail;
    const access = detail.access;
    const chosen = detail.streams.find((stream) => stream.url === resolution.mediaUrl) ?? detail.streams.find((stream) => stream.verifiedVideo) ?? null;
    const bestStreamUrl = resolution.mediaUrl;
    const limitations = [...resolution.limitations];
    if (options.platformHint && options.platformHint !== "auto" && options.platformHint !== resolution.platform) {
      limitations.push(`The platform hint "${options.platformHint}" did not match the detected platform "${resolution.platform}"; detection is based on the URL host.`);
    }
    if (!options.includeSignedUrls && detail.streams.some((stream) => stream.signed)) {
      limitations.push("Signed query strings were removed from the returned stream URLs, so those URLs are not directly fetchable; pass include_signed_urls=true when DEMO must retrieve them.");
    }
    if (access.status === "public" && detail.verification !== "bytes") {
      limitations.push("The stream was accepted from its declared content type; pass verify_bytes=true (the default for video_resolve) or call video_fetch to prove the container from real bytes.");
    }
    // Signed/expiring query strings are removed at this layer too, so a caller
    // that asked not to see them cannot receive them by any other path. The
    // stripped URL keeps `signed: true` and gains a note: it is no longer
    // directly fetchable, and DEMO says so instead of leaving a broken URL.
    const includeSignedUrls = options.includeSignedUrls !== false;
    const streams = includeSignedUrls
      ? detail.streams
      : detail.streams.map((stream) =>
          stream.signed
            ? { ...stream, url: `${unsignedUrlShape(stream.url)}?signed_query_removed=true`, reason: stream.reason ? `${stream.reason} The signed query string was removed on request, so this URL is not directly fetchable.` : "The signed query string was removed on request, so this URL is not directly fetchable." }
            : stream,
        );
    const reportedBestStreamUrl = bestStreamUrl && !includeSignedUrls ? `${unsignedUrlShape(bestStreamUrl)}?signed_query_removed=true` : bestStreamUrl;
    if (detail.isImagePost) limitations.push("This is an image/photo carousel post: no video stream exists, and DEMO will not describe motion or audio.");
    if (detail.streams.some((stream) => stream.signed && signedUrlExpired(stream.url))) {
      limitations.push("At least one published stream URL had already expired when DEMO resolved the page.");
    }

    return {
      success: resolution.success && access.status === "public",
      accessStatus: access.status,
      access,
      platform: resolution.platform,
      sourceUrl: url,
      resolvedUrl: resolution.resolvedUrl,
      canonicalUrl: detail.canonicalUrl ?? resolution.resolvedUrl,
      videoId: detail.videoId,
      creator: detail.creator,
      caption: detail.caption,
      captionSource: detail.captionSource,
      hashtags: detail.hashtags,
      createdAt: detail.createdAt,
      durationSeconds: resolution.metadata.durationSeconds,
      width: resolution.metadata.width,
      height: resolution.metadata.height,
      contentType: resolution.metadata.contentType,
      contentLengthBytes: resolution.metadata.contentLength,
      thumbnailUrl: resolution.metadata.thumbnailUrl,
      metadataSource: detail.metadataSource,
      verification: detail.verification,
      streams,
      streamCount: detail.streamCount,
      bestStreamUrl: reportedBestStreamUrl,
      stats: detail.stats,
      music: detail.music,
      accessFlags: detail.accessFlags,
      isImagePost: detail.isImagePost,
      platformStatusCode: detail.platformStatusCode,
      platformStatusMessage: detail.platformStatusMessage,
      httpStatus: detail.httpStatus,
      redirectCount: resolution.redirects.length,
      challenge: resolution.challenge,
      signature: chosen?.verifiedContainer ? detail.signature : detail.signature,
      error: resolution.success ? null : resolution.error,
      message: resolution.success ? null : resolution.message,
      limitations: [...new Set(limitations)],
      guidance: accessStatusGuidance(access.status),
      nextSteps: nextStepsFor(access.status, { verifiedBytes: detail.verification === "bytes", hasStream: Boolean(bestStreamUrl), isImagePost: detail.isImagePost }),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* video_fetch — verified, streamed retrieval of the actual video bytes      */
  /* ------------------------------------------------------------------------ */

  /**
   * Retrieve the actual video file.
   *
   * The body is *streamed* into expiring R2 storage (never buffered whole,
   * never written to a local disk), and the first 128 KiB are inspected to
   * prove the response really is a video container. An HTML interstitial, a
   * JSON error body, an OpenGraph thumbnail or an HLS manifest is rejected with
   * `NOT_A_VIDEO`/`UNSUPPORTED_MEDIA` and the partial object is deleted: DEMO
   * never reports a download that did not produce verified video bytes.
   */
  async fetchVideo(input: VideoInput, options: VideoFetchOptions = {}): Promise<VideoFetchResult> {
    const quality = options.quality ?? "auto";
    const maxBytes = this.maxDownloadBytes(options.maxSizeMb);
    const maxDuration = Math.min(options.maxDurationSeconds ?? this.maxDuration(), this.maxDuration());

    // An existing reference: report its true state (ok / expired / missing).
    if (!input.url && input.videoReference) {
      return this.fetchExistingReference(input.videoReference, quality, maxDuration);
    }
    if (!input.url) {
      return this.fetchFailure({ url: "", quality, accessStatus: "unknown", error: "invalid_input", message: "Provide either url or video_reference.", limitations: ["No source was supplied."] });
    }

    this.charge("fetch", input.url);
    const resolution = options.resolution ?? (await resolvePublicVideo(input.url, this.env, { quality, probeLimit: LIMITS.videoMaxProbedStreams, verifyBytes: true }));
    const detail = resolution.detail;

    if (!resolution.success || !resolution.mediaUrl) {
      const expiredStream = detail.streams.some((stream) => stream.signed && signedUrlExpired(stream.url));
      const access = expiredStream
        ? { status: "expired" as const, label: "The platform published a signed media URL whose expiry had already passed.", mayDescribeContent: false }
        : detail.access;
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: access.status,
        access,
        resolution,
        error: expiredStream ? "ARTIFACT_EXPIRED" : (resolution.error ?? errorCodeForAccess(access.status)),
        message: resolution.message ?? access.label,
        limitations: [
          ...resolution.limitations,
          "No verified video stream was reachable, so nothing was downloaded and no artifact exists.",
          ...(detail.streams.length && !expiredStream
            ? ["Frame extraction through Cloudflare Browser Rendering may still work on the page itself: try video_extract_frames."]
            : []),
        ],
      });
    }

    // Declared-size policy gate before any bytes are pulled.
    if (resolution.metadata.contentLength !== null && resolution.metadata.contentLength > maxBytes) {
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: detail.access.status,
        access: detail.access,
        resolution,
        error: "DOWNLOAD_TOO_LARGE",
        message: `The stream declares ${formatBytes(resolution.metadata.contentLength)}, above the ${formatBytes(maxBytes)} policy limit.`,
        limitations: ["The declared size exceeded the deployment limit, so the body was never streamed."],
      });
    }
    if (resolution.metadata.durationSeconds !== null && resolution.metadata.durationSeconds > maxDuration) {
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: detail.access.status,
        access: detail.access,
        resolution,
        error: "DOWNLOAD_TOO_LARGE",
        message: `The video duration (${resolution.metadata.durationSeconds.toFixed(1)}s) exceeds the ${maxDuration}s processing limit.`,
        limitations: ["The duration policy is enforced before the body is streamed."],
      });
    }

    let responseResult: Awaited<ReturnType<typeof fetchPublic>>;
    try {
      responseResult = await fetchPublic(resolution.mediaUrl, this.env, { method: "GET", headers: { accept: "video/*,application/octet-stream;q=0.8" } }, { timeoutMs: LIMITS.videoDownloadTimeoutMs, referer: resolution.resolvedUrl ?? input.url });
    } catch (error) {
      const normal = asBrowserError(error);
      return this.fetchFailure({ url: input.url, quality, accessStatus: detail.access.status, access: detail.access, resolution, error: normal.code, message: normal.message, limitations: ["The public media request failed, so nothing was downloaded."] });
    }

    const response = responseResult.response;
    const type = contentType(response) ?? resolution.metadata.contentType;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const expired = signedUrlExpired(responseResult.finalUrl) || response.status === 403 || response.status === 410;
      const access = expired
        ? { status: "expired" as const, label: `The media URL returned HTTP ${response.status}; signed platform URLs expire within minutes.`, mayDescribeContent: false }
        : detail.access;
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: access.status,
        access,
        resolution,
        error: expired ? "ARTIFACT_EXPIRED" : response.status === 404 ? "VIDEO_NOT_FOUND" : "VIDEO_NOT_PUBLIC",
        message: `The public media URL returned HTTP ${response.status}.`,
        limitations: ["The media request did not succeed, so no bytes were stored."],
      });
    }
    // Second size gate: the response's own Content-Length may disagree with the
    // probe (a signed URL can redirect to a different rendition). Refuse before
    // a single byte is streamed rather than aborting mid-download.
    const declaredLength = parseLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: detail.access.status,
        access: detail.access,
        resolution,
        error: "DOWNLOAD_TOO_LARGE",
        message: `The media response declares ${formatBytes(declaredLength)}, above the ${formatBytes(maxBytes)} policy limit, so the body was never streamed.`,
        limitations: ["The declared size exceeded the deployment limit; no bytes were stored and no artifact exists."],
      });
    }
    if (isPlaylistContentType(type, responseResult.finalUrl)) {
      await response.body?.cancel().catch(() => undefined);
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: "unsupported",
        access: { status: "unsupported", label: "The public URL is an HLS/DASH manifest, not a bounded video file.", mayDescribeContent: false },
        resolution,
        error: "UNSUPPORTED_MEDIA",
        message: "The public URL is a streaming manifest, not a bounded downloadable video file. DEMO does not assemble segment playlists.",
        limitations: ["Browser Rendering may still decode frames from the page: try video_extract_frames."],
      });
    }
    if (!this.artifacts.available) {
      await response.body?.cancel().catch(() => undefined);
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: detail.access.status,
        access: detail.access,
        resolution,
        error: "capability_unavailable",
        message: this.artifacts.unavailableReason(),
        limitations: ["Temporary R2 storage is required to hold retrieved video bytes; Workers have no local disk."],
      });
    }

    const artifactType = isVideoContentType(type) ? (type as string) : "video/mp4";
    const storeMetadata = { durationSeconds: resolution.metadata.durationSeconds, width: resolution.metadata.width, height: resolution.metadata.height, source: input.url };

    // Stream when the runtime gives us a body; fall back to a bounded buffered
    // read only when there is no stream to pipe (e.g. an empty mock body).
    let outcome: StreamStoreOutcome;
    let delivery: VideoFetchResult["delivery"] = "streamed";
    if (response.body) {
      try {
        outcome = await this.artifacts.storeStream(response.body, "video", artifactType, storeMetadata, {
          maxBytes,
          headBytes: LIMITS.videoHeadProbeBytes,
          digestBufferBytes: LIMITS.videoDigestBufferBytes,
          timeoutMs: LIMITS.videoDownloadTimeoutMs,
        });
      } catch (error) {
        const normal = asBrowserError(error);
        return this.fetchFailure({ url: input.url, quality, accessStatus: detail.access.status, access: detail.access, resolution, error: normal.code, message: normal.message, limitations: ["The streamed upload into R2 failed."] });
      }
    } else {
      delivery = "buffered";
      let bytes: Uint8Array;
      try {
        bytes = await readBounded(response, maxBytes, LIMITS.videoDownloadTimeoutMs);
      } catch (error) {
        const normal = asBrowserError(error);
        return this.fetchFailure({
          url: input.url,
          quality,
          accessStatus: detail.access.status,
          access: detail.access,
          resolution,
          error: normal.code,
          message: normal.message,
          limitations: ["The bounded read of the media body failed, so nothing was stored and no download is claimed."],
        });
      }
      const hash = await sha256Hex(bytes);
      const artifact = await this.artifacts.store(bytes, "video", artifactType, storeMetadata).catch(() => null);
      outcome = { artifact, head: bytes.subarray(0, LIMITS.videoHeadProbeBytes), bytes: bytes.byteLength, sha256: artifact ? hash : null, contentAddressed: Boolean(artifact), aborted: artifact ? null : { code: "PROCESSING_TIMEOUT", message: "The artifact could not be stored." }, timedOut: false };
    }

    if (outcome.aborted || !outcome.artifact) {
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: detail.access.status,
        access: detail.access,
        resolution,
        error: outcome.aborted?.code ?? "PROCESSING_TIMEOUT",
        message: outcome.aborted?.message ?? "The video body could not be stored.",
        limitations: ["The partial object was deleted; DEMO does not report a download that did not complete."],
      });
    }

    // ── Prove the bytes are really a video ─────────────────────────────────
    const signature = detectMediaSignature(outcome.head, type);
    if (!signature.isVideo) {
      await this.artifacts.delete(outcome.artifact.reference);
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: classifyAccess({ platform: resolution.platform, signature, playableStreamFound: false, metadataOnly: true }).status,
        resolution,
        error: "NOT_A_VIDEO",
        message: notAVideoMessage(signature),
        signature,
        limitations: [
          `The response body was ${signature.detectedAs}; the stored object was deleted and nothing is claimed as downloaded.`,
          "A thumbnail, HTML page or JSON body is never substituted for video content.",
        ],
      });
    }

    // ── Verify the duration policy from real container data ────────────────
    let duration = resolution.metadata.durationSeconds;
    let durationSource: VideoFetchResult["durationSource"] = duration !== null ? "page_metadata" : null;
    if (duration === null) {
      const fromHead = durationFromSample(outcome.head, signature);
      if (fromHead !== null) {
        duration = fromHead;
        durationSource = "head_sample";
      }
    }
    if (duration === null) {
      const tail = await this.artifacts.getRange(outcome.artifact.reference, Math.max(0, outcome.bytes - LIMITS.videoTailProbeBytes), LIMITS.videoTailProbeBytes);
      const fromTail = tail ? durationFromSample(tail.bytes, signature) : null;
      if (fromTail !== null) {
        duration = fromTail;
        durationSource = "artifact_tail";
      }
    }
    if (duration === null) {
      await this.artifacts.delete(outcome.artifact.reference);
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: "unsupported",
        access: { status: "unsupported", label: "The video duration could not be verified.", mayDescribeContent: false },
        resolution,
        error: "UNSUPPORTED_MEDIA",
        message: `The container signature verified as ${signature.container ?? signature.detectedAs}, but no duration could be read from page metadata or the ISO-BMFF/EBML headers of the streamed bytes, so DEMO refused to persist it.`,
        signature,
        limitations: ["The stored object was deleted: refusing unverifiable durations keeps the duration policy enforceable."],
      });
    }
    if (duration > maxDuration) {
      await this.artifacts.delete(outcome.artifact.reference);
      return this.fetchFailure({
        url: input.url,
        quality,
        accessStatus: "unsupported",
        access: { status: "unsupported", label: `The video is ${duration.toFixed(1)}s long, above the ${maxDuration}s limit.`, mayDescribeContent: false },
        resolution,
        error: "DOWNLOAD_TOO_LARGE",
        message: `The verified video duration (${duration.toFixed(1)}s) exceeds the ${maxDuration}s processing limit.`,
        signature,
        limitations: ["The stored object was deleted after the duration was verified from the container."],
      });
    }

    await this.artifacts.patchMetadata(outcome.artifact.reference, { durationSeconds: String(duration), ...(durationSource ? { durationSource } : {}), verifiedContainer: signature.container ?? signature.detectedAs });
    const limitations = [
      ...resolution.limitations,
      ...(outcome.sha256 ? [] : ["The runtime could not digest the stream incrementally, so sha256 is null; the artifact reference is a random token rather than a content hash."]),
      "The artifact is temporary: it expires with the R2 TTL and the route refuses expired references.",
      ...(signature.container === signature.detectedAs ? [] : []),
    ];

    return {
      success: true,
      accessStatus: "public",
      sourceUrl: input.url,
      resolvedUrl: resolution.resolvedUrl,
      canonicalUrl: detail.canonicalUrl ?? resolution.resolvedUrl,
      mediaUrl: responseResult.finalUrl,
      platform: resolution.platform,
      artifact: { ...outcome.artifact, durationSeconds: duration, sha256: outcome.sha256 ?? outcome.artifact.sha256 },
      sha256: outcome.sha256,
      contentAddressed: outcome.contentAddressed,
      delivery,
      contentType: artifactType,
      detectedContainer: signature.container ?? signature.detectedAs,
      signature,
      verification: "bytes",
      bytes: outcome.bytes,
      durationSeconds: duration,
      durationSource,
      durationVerified: true,
      width: resolution.metadata.width,
      height: resolution.metadata.height,
      quality,
      error: null,
      message: null,
      challenge: resolution.challenge,
      limitations: [...new Set(limitations)],
    };
  }

  /** Report the true state of an artifact reference without re-downloading. */
  private async fetchExistingReference(reference: string, quality: QualityPreference, maxDuration: number): Promise<VideoFetchResult> {
    const status = await this.artifacts.referenceStatus(reference);
    const base = { url: reference, quality, resolvedUrl: null, canonicalUrl: null, mediaUrl: null, platform: "generic" as VideoPlatform, contentType: null, detectedContainer: null, signature: null, verification: "none" as VideoVerification, bytes: null, durationSeconds: null, durationSource: null, durationVerified: false, width: null, height: null, challenge: { detected: false, kind: null, reason: null } };
    if (status === "expired") {
      return this.fetchFailure({ ...base, accessStatus: "expired", error: "ARTIFACT_EXPIRED", message: "That video artifact reference has expired. Temporary artifacts live only for the configured TTL.", limitations: ["Call video_fetch or video_resolve again on the original public URL to mint a fresh artifact."] });
    }
    if (status === "invalid") {
      return this.fetchFailure({ ...base, accessStatus: "unknown", error: "invalid_input", message: "video_reference must look like video_<64 hex characters> or audio_<64 hex characters>.", limitations: [] });
    }
    if (status === "storage_unavailable") {
      return this.fetchFailure({ ...base, accessStatus: "unknown", error: "capability_unavailable", message: this.artifacts.unavailableReason(), limitations: [] });
    }
    if (status === "missing") {
      return this.fetchFailure({ ...base, accessStatus: "not_found", error: "VIDEO_NOT_FOUND", message: "No artifact exists for that reference (it was never stored or has already been cleaned up).", limitations: [] });
    }
    const object = await this.artifacts.objectForRoute(reference);
    if (!object) {
      return this.fetchFailure({ ...base, accessStatus: "not_found", error: "VIDEO_NOT_FOUND", message: "The artifact could not be read back from storage.", limitations: [] });
    }
    const metadata = object.customMetadata ?? {};
    const duration = finiteOrNull(metadata.durationSeconds);
    if (duration !== null && duration > maxDuration) {
      return this.fetchFailure({ ...base, accessStatus: "unsupported", error: "DOWNLOAD_TOO_LARGE", message: `The stored artifact is ${duration.toFixed(1)}s long, above the ${maxDuration}s limit.`, limitations: [] });
    }
    return {
      success: true,
      accessStatus: "public",
      sourceUrl: metadata.source ?? "",
      resolvedUrl: null,
      canonicalUrl: null,
      mediaUrl: `${this.artifacts.baseUrl}/video-assets/${reference}`,
      platform: "generic",
      artifact: {
        reference,
        kind: this.artifacts.parse(reference)?.kind ?? "video",
        url: `${this.artifacts.baseUrl}/video-assets/${reference}`,
        contentType: object.httpMetadata?.contentType ?? "video/mp4",
        bytes: object.size ?? finiteOrNull(String(object.size ?? "")) ?? 0,
        sha256: metadata.sha256 ?? reference.replace(/^(?:video|audio)_/, ""),
        expiresAt: metadata.expiresAt ?? new Date(Date.now() + this.artifacts.ttlSeconds * 1000).toISOString(),
        durationSeconds: duration,
        width: finiteOrNull(metadata.width),
        height: finiteOrNull(metadata.height),
      },
      sha256: metadata.sha256 ?? null,
      contentAddressed: Boolean(metadata.sha256),
      delivery: "streamed",
      contentType: object.httpMetadata?.contentType ?? "video/mp4",
      detectedContainer: metadata.verifiedContainer ?? null,
      signature: null,
      verification: metadata.verifiedContainer ? "bytes" : "content_type",
      bytes: object.size ?? null,
      durationSeconds: duration,
      durationSource: (metadata.durationSource as VideoFetchResult["durationSource"]) ?? (duration !== null ? "page_metadata" : null),
      durationVerified: duration !== null,
      width: finiteOrNull(metadata.width),
      height: finiteOrNull(metadata.height),
      quality,
      error: null,
      message: null,
      challenge: { detected: false, kind: null, reason: null },
      limitations: ["This is a previously stored temporary artifact; its bytes were verified when it was first fetched."],
    };
  }

  private fetchFailure(input: {
    url: string;
    quality: QualityPreference;
    accessStatus: VideoAccessStatus;
    access?: AccessStatusInfo;
    resolution?: VideoResolution;
    error: string;
    message: string;
    signature?: MediaSignature | null;
    limitations: string[];
  }): VideoFetchResult {
    const resolution = input.resolution ?? null;
    const detail = resolution?.detail ?? null;
    const access = input.access ?? detail?.access ?? { status: input.accessStatus, label: input.message, mayDescribeContent: false };
    return {
      success: false,
      accessStatus: input.accessStatus,
      sourceUrl: input.url,
      resolvedUrl: resolution?.resolvedUrl ?? null,
      canonicalUrl: detail?.canonicalUrl ?? resolution?.resolvedUrl ?? null,
      mediaUrl: resolution?.mediaUrl ?? null,
      platform: resolution?.platform ?? "generic",
      artifact: null,
      sha256: null,
      contentAddressed: false,
      delivery: "streamed",
      contentType: resolution?.metadata.contentType ?? null,
      detectedContainer: input.signature?.container ?? input.signature?.detectedAs ?? null,
      signature: input.signature ?? null,
      verification: "none",
      bytes: null,
      durationSeconds: resolution?.metadata.durationSeconds ?? null,
      durationSource: null,
      durationVerified: false,
      width: resolution?.metadata.width ?? null,
      height: resolution?.metadata.height ?? null,
      quality: input.quality,
      error: input.error,
      message: input.message,
      challenge: resolution?.challenge ?? { detected: false, kind: null, reason: null },
      limitations: input.limitations,
    };
  }

  /** What DEMO can do with the video it holds, for capability reporting. */
  videoCapabilities(): VideoCapabilityReport {
    const sessions = new SessionManager(this.env as never, this.requestUrl);
    const capabilities = sessions.capabilities();
    return describeVideoCapabilities(this.env as never, {
      browserAvailable: capabilities.browserAvailable,
      provider: capabilities.provider,
      videoFrames: capabilities.videoFrames,
      reason: capabilities.reason ?? null,
      screenshots: capabilities.screenshots,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* video_analyze — one unified, mode-aware analysis call                     */
  /* ------------------------------------------------------------------------ */

  /**
   * The unified high-level tool: resolve → retrieve → frames → audio/transcript
   * → a structured evidence result the connected AI can actually reason over.
   *
   * `analysis_mode` decides the frame budget and whether audio/transcript work
   * is requested. The result always separates a real speech-to-text transcript
   * from the platform post caption, and always states which evidence exists;
   * when no frames and no transcript were obtained the response says so instead
   * of describing content.
   */
  async analyzeUnified(url: string, options: VideoAnalyzeOptions = {}): Promise<VideoAnalyzeResult> {
    const mode = options.analysisMode ?? "summary";
    const plan = ANALYSIS_MODE_PLANS[mode] ?? ANALYSIS_MODE_PLANS.summary;
    const includeAudio = options.includeAudio ?? plan.includeAudio;
    const includeTranscript = options.includeTranscript ?? (includeAudio || plan.includeTranscript);
    const question = options.question?.trim() ? options.question.trim().slice(0, 2_000) : null;
    const userIntent = options.userIntent?.trim() ? options.userIntent.trim().slice(0, 2_000) : null;

    this.charge("analyze", url);
    const resolution = await resolvePublicVideo(url, this.env, { quality: "auto", probeLimit: LIMITS.videoMaxProbedStreams, verifyBytes: true });
    const inspected = await this.runInspectVideo(url, resolution, {
      userIntent,
      question,
      reactionMode: plan.reactionMode,
      frameCount: options.maxFrames ?? plan.frames,
      includeMetadata: true,
      includeAudio,
      analyzeScenes: plan.analyzeScenes,
      analyzeOnScreenText: plan.analyzeOnScreenText,
    });

    let transcript = inspected.transcript;
    if (includeTranscript && !transcript) {
      if (includeAudio && inspected.audioStatus !== "available") {
        // Audio capture already failed, so there is nothing to transcribe. Say
        // exactly that: an unavailable transcript is reported, never invented.
        transcript = {
          status: "unavailable",
          language: null,
          text: null,
          segments: [],
          provider: null,
          message: `TRANSCRIPTION_UNAVAILABLE: no audio track could be captured (${inspected.audioStatus}), so no speech-to-text was produced. DEMO never writes dialogue it did not hear.`,
        };
      } else {
        // `runInspectVideo` only transcribes when audio extraction succeeded;
        // when the caller asked for a transcript explicitly, try the audio path
        // once so an unavailable provider is reported rather than skipped.
        transcript = await this.transcribe({ url }, { autoExtract: true, durationSeconds: inspected.source.durationSeconds });
      }
    }

    const detail = resolution.detail;
    const framesDelivered = inspected.framesDelivered;
    const transcriptAvailable = transcript?.status === "transcribed";
    const audioStatus: VideoAnalyzeResult["audioStatus"] = includeAudio ? (inspected.audioStatus ?? "failed") : "not_requested";
    const evidence: VideoEvidenceSummary = {
      videoBytesRetrieved: framesDelivered > 0 || detail.verification === "bytes",
      framesDecoded: framesDelivered,
      framesDeliveredInline: inspected.imageBlocksDelivered,
      transcriptAvailable,
      transcriptKind: transcriptAvailable ? "speech_to_text" : "none",
      audioAvailable: audioStatus === "available",
      metadataOnly: framesDelivered === 0 && !transcriptAvailable,
      thumbnailUsedAsFrame: false,
      visualEvidence: framesDelivered > 0,
    };

    const limitations = [...new Set([...resolution.limitations, ...inspected.limitations])];
    if (transcript && transcript.status === "unavailable" && !limitations.some((entry) => entry.includes("Speech-to-text"))) {
      limitations.push(transcript.message ?? "Speech-to-text was not available.");
    }
    if (!transcriptAvailable && detail.caption) {
      limitations.push("A platform post caption is available but it is NOT a transcript: it was written by the creator, and DEMO never presents it as spoken audio.");
    }

    const intent = detectVideoIntent({ userIntent, question, reactionMode: plan.reactionMode });
    const can: string[] = [];
    const cannot: string[] = [];
    if (framesDelivered > 0) {
      can.push(`Describe what is visible in ${framesDelivered} real decoded frame(s) at ${inspected.frames.map((frame) => `${frame.timestamp}s`).join(", ")}.`);
      cannot.push("Describe continuous motion or events between the sampled frames — they are samples, not playback.");
    } else {
      cannot.push("Describe any visual content: no frames were decoded, so nothing was seen.");
    }
    if (transcriptAvailable) can.push(`Quote the transcribed speech (${transcript?.segments.length ?? 0} timestamped segment(s)).`);
    else cannot.push("Quote or infer dialogue: no transcript was produced.");
    if (audioStatus !== "available") cannot.push("Describe sound effects, music or tone of voice: no verified audio track.");
    if (detail.caption) can.push(`Mention the creator's post caption as caption text (source: ${detail.captionSource}).`);
    can.push("Report platform metadata that was actually published (duration, dimensions, creator handle, publish date, public stats).");
    cannot.push("Identify real people by name from pixels alone.");
    cannot.push("Verify claims that depend on context outside the sampled frames.");

    return {
      success: framesDelivered > 0 || transcriptAvailable,
      analysisMode: mode,
      accessStatus: framesDelivered > 0 || transcriptAvailable ? "public" : detail.access.status,
      access: framesDelivered > 0 ? { status: "public", label: "A normal public request reached decodable video media.", mayDescribeContent: true } : detail.access,
      sourceUrl: url,
      resolvedUrl: resolution.resolvedUrl,
      canonicalUrl: detail.canonicalUrl ?? resolution.resolvedUrl,
      videoId: detail.videoId,
      platform: resolution.platform,
      durationSeconds: inspected.source.durationSeconds,
      width: inspected.source.width,
      height: inspected.source.height,
      metadata: {
        ...resolution.metadata,
        durationSeconds: inspected.source.durationSeconds,
        width: inspected.source.width,
        height: inspected.source.height,
        contentType: inspected.source.contentType,
        creator: detail.creator,
        caption: detail.caption,
        captionSource: detail.captionSource,
        hashtags: detail.hashtags,
        createdAt: detail.createdAt,
        stats: detail.stats,
        music: detail.music,
      },
      frames: inspected.frames,
      framesDelivered,
      imageBlocksDelivered: inspected.imageBlocksDelivered,
      visualEvidenceDelivered: inspected.visualEvidenceDelivered,
      transcript: transcript ?? null,
      textSources: {
        transcript: {
          available: transcriptAvailable,
          text: transcriptAvailable ? (transcript?.text ?? null) : null,
          kind: transcriptAvailable ? "speech_to_text" : "none",
          provider: transcriptAvailable ? (transcript?.provider ?? null) : null,
        },
        platformCaption: { available: Boolean(detail.caption), text: detail.caption, source: detail.captionSource },
        generatedCaption: {
          available: false,
          text: null,
          note: "DEMO never generates caption text. Anything in `transcript` came from a speech-to-text provider; anything in `platformCaption` was written by the creator.",
        },
        onScreenText: {
          available: Boolean(inspected.extractedText?.length),
          text: inspected.extractedText,
          source: inspected.extractedText?.length ? "vision_model" : "none",
        },
      },
      audioStatus,
      detectedScenes: inspected.detectedScenes,
      evidence,
      analysisContext: {
        question,
        userIntent,
        focus: intent.focus,
        reactionMode: intent.reactionMode,
        whatCanBeAnswered: can,
        whatCannotBeAnswered: cannot,
        factCheck: {
          requested: mode === "fact_check_visual",
          visualClaimsAssessable: framesDelivered > 0,
          note:
            mode !== "fact_check_visual"
              ? "Visual fact-checking was not requested; use analysis_mode=fact_check_visual for denser sampling focused on staging/editing evidence."
              : framesDelivered > 0
                ? "Assess a claim only against what these frames show. State explicitly when the frames neither support nor refute it — sampled frames cannot prove a negative, and audio/context claims need a transcript."
                : "The claim cannot be assessed: no frames were decoded. Say so instead of reasoning from the caption or metadata.",
        },
        honestyNote: inspected.honestyNote,
        responseGuidance: inspected.responseGuidance,
      },
      error: inspected.error ?? (resolution.success ? null : resolution.error),
      message: inspected.message ?? (resolution.success ? null : resolution.message),
      challenge: resolution.challenge,
      limitations,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* video_react — grounded evidence package for the connected model           */
  /* ------------------------------------------------------------------------ */

  /**
   * Prepare a grounded evidence package so the connected AI can genuinely react.
   *
   * DEMO deliberately does **not** author the reaction: `reaction` is always
   * `null` and `reactionAuthor` is `"connected_model"`. There is no canned text
   * and no caption-derived guess — the package contains the real decoded frames
   * (as MCP image blocks), a transcript when one exists, and style-specific
   * guidance. Without frames the call fails honestly.
   */
  async react(url: string, options: VideoReactOptions = {}): Promise<VideoReactResult> {
    const style = options.style ?? "casual";
    const stylePlan = REACT_STYLE_PLANS[style] ?? REACT_STYLE_PLANS.casual;
    const question = options.question?.trim() ? options.question.trim().slice(0, 2_000) : null;
    const includeAudio = options.includeAudio ?? false;

    this.charge("react", url);
    const resolution = await resolvePublicVideo(url, this.env, { quality: "auto", probeLimit: LIMITS.videoMaxProbedStreams, verifyBytes: true });
    const inspected = await this.runInspectVideo(url, resolution, {
      userIntent: question ?? stylePlan.intent,
      question,
      reactionMode: true,
      frameCount: options.maxFrames ?? stylePlan.frames,
      includeMetadata: true,
      includeAudio,
      analyzeScenes: true,
      analyzeOnScreenText: true,
    });

    const detail = resolution.detail;
    const evidence: VideoEvidenceSummary = {
      videoBytesRetrieved: inspected.framesDelivered > 0 || detail.verification === "bytes",
      framesDecoded: inspected.framesDelivered,
      framesDeliveredInline: inspected.imageBlocksDelivered,
      transcriptAvailable: inspected.transcript?.status === "transcribed",
      transcriptKind: inspected.transcript?.status === "transcribed" ? "speech_to_text" : "none",
      audioAvailable: inspected.audioStatus === "available",
      metadataOnly: inspected.framesDelivered === 0 && inspected.transcript?.status !== "transcribed",
      thumbnailUsedAsFrame: false,
      visualEvidence: inspected.framesDelivered > 0,
    };

    const observations = [
      ...(inspected.detectedScenes ?? []).map((scene) => `${scene.start}s${scene.end !== null ? `–${scene.end}s` : ""}: ${scene.significance}`),
      ...(inspected.extractedText ?? []).map((text) => `on-screen text: "${text}"`),
      ...inspected.frames.filter((frame) => frame.sceneDescriptionHint).map((frame) => `${frame.timestamp}s: ${frame.sceneDescriptionHint}`),
    ].slice(0, 40);

    const visionProvider = this.aiBinding() ? (this.env.VIDEO_VISION_MODEL ?? "@cf/llava-hf/llava-1.5-7b-hf") : null;
    const limitations = [...new Set([...resolution.limitations, ...inspected.limitations])];
    if (!observations.length && inspected.framesDelivered > 0) {
      limitations.push("No server-side vision model produced frame labels; the frames themselves are the evidence — read them directly.");
    }

    return {
      success: inspected.framesDelivered > 0,
      style,
      accessStatus: inspected.framesDelivered > 0 ? "public" : detail.access.status,
      sourceUrl: url,
      canonicalUrl: detail.canonicalUrl ?? resolution.resolvedUrl,
      platform: resolution.platform,
      durationSeconds: inspected.source.durationSeconds,
      caption: detail.caption,
      captionIsNotTranscript: true,
      frames: inspected.frames,
      framesDelivered: inspected.framesDelivered,
      imageBlocksDelivered: inspected.imageBlocksDelivered,
      visualEvidenceDelivered: inspected.visualEvidenceDelivered,
      transcript: inspected.transcript,
      audioStatus: includeAudio ? (inspected.audioStatus ?? "failed") : "not_requested",
      evidence,
      visionSummary: observations.length
        ? { available: true, provider: visionProvider, observations, groundedInFrames: true }
        : null,
      reaction: null,
      reactionAuthor: "connected_model",
      reactionGuidance:
        inspected.framesDelivered > 0
          ? `Examine the ${inspected.framesDelivered} decoded frame image(s) now, then react in a ${style} register. Anchor every claim to a specific timestamp you can actually see, and say what the sampled frames cannot establish (audio, off-screen context, whether something is staged).`
          : "No frames were decoded, so there is nothing to react to. Tell the user honestly that DEMO could not retrieve the video, name the reason from error/limitations, and do not invent a reaction.",
      styleGuidance: stylePlan.guidance,
      honestyNote: inspected.honestyNote,
      error: inspected.framesDelivered > 0 ? null : (inspected.error ?? resolution.error ?? "FRAMES_UNAVAILABLE"),
      message: inspected.framesDelivered > 0 ? null : (inspected.message ?? resolution.message ?? "No decoded frames could be extracted from the public video."),
      challenge: resolution.challenge,
      limitations,
    };
  }

  private async loadFrameReferences(references: string[]): Promise<FrameCaptureResult> {
    const bucket = this.env.SCREENSHOTS as {
      get?: (key: string) => Promise<any>;
    } | undefined;
    if (!bucket?.get) {
      return { success: false, error: "FRAMES_UNAVAILABLE", message: "Frame references point to R2, but screenshot storage is not configured.", sourceUrl: "", durationSeconds: null, width: null, height: null, frames: [], limitations: ["Configure SCREENSHOTS R2 or pass a public video URL for fresh frame extraction."] };
    }
    const frames: VideoFrameOutput[] = [];
    for (const reference of references.slice(0, LIMITS.videoFramesMaxCount)) {
      const match = /(?:\/screenshots\/|\/frames\/)([A-Za-z0-9_-]{16,100})$/.exec(reference) ?? /^(?:screenshots\/)?([A-Za-z0-9_-]{16,100})$/.exec(reference);
      if (!match) continue;
      const object = await bucket.get(`screenshots/${match[1]}`).catch(() => null);
      if (!object) continue;
      try {
      const buffer = object.arrayBuffer ? await object.arrayBuffer() : await readStreamBytes(object.body);
      const bytes = new Uint8Array(buffer);
      const binary = bytes.byteLength <= LIMITS.inlineImageMaxBytes ? bytesToBase64(bytes) : undefined;
      // Restore the real capture timestamp stored with the frame (falling back
      // to the reference order) so analysis stays grounded in actual times.
      const storedSeconds = finiteOrNull(object.customMetadata?.timeSeconds);
      frames.push({ timestamp: storedSeconds ?? frames.length, contentType: contentTypeForFrame(object.httpMetadata?.contentType ?? null), imageReference: reference, bytes: bytes.byteLength, ...(binary ? { inlineData: binary } : {}), inspected: true });
      } catch {
        /* A missing/expired frame is reported by the count and limitations. */
      }
    }
    return {
      success: frames.length > 0,
      error: frames.length ? undefined : "FRAMES_UNAVAILABLE",
      message: frames.length ? undefined : "None of the supplied frame references could be retrieved from temporary R2 storage.",
      sourceUrl: "",
      durationSeconds: null,
      width: null,
      height: null,
      frames,
      limitations: frames.length ? [] : ["Frame references expire with the temporary R2 artifact lifecycle."],
    };
  }

  private aiBinding(): { run: (model: string, input: any) => Promise<any> } | null {
    const candidate = this.env.AI as { run?: (model: string, input: any) => Promise<any> } | undefined;
    return candidate && typeof candidate.run === "function" ? candidate as { run: (model: string, input: any) => Promise<any> } : null;
  }

  private async resolveInput(input: VideoInput): Promise<{ success: boolean; sourceUrl: string | null; error: string | null; message: string | null; metadata: VideoMetadata; limitations: string[] }> {
    if (input.videoReference) {
      const parsed = this.artifacts.parse(input.videoReference);
      if (!parsed || parsed.kind !== "video") return { success: false, sourceUrl: null, error: "VIDEO_NOT_FOUND", message: "video_reference must be an expiring video artifact reference such as video_<64 hex characters>.", metadata: emptyMetadata(), limitations: [] };
      // Distinguish an expired artifact from one that never existed: an expired
      // signed URL/reference must be reported as expired, never as "not found".
      const referenceState = await this.artifacts.referenceStatus(input.videoReference);
      if (referenceState === "expired") {
        return { success: false, sourceUrl: null, error: "ARTIFACT_EXPIRED", message: "The video artifact reference has expired.", metadata: emptyMetadata(), limitations: ["Temporary artifacts live only for the configured TTL; call video_fetch on the original public URL to mint a fresh one."] };
      }
      const object = await this.artifacts.objectForRoute(input.videoReference);
      if (!object) return { success: false, sourceUrl: null, error: referenceState === "missing" ? "VIDEO_NOT_FOUND" : "ARTIFACT_EXPIRED", message: referenceState === "missing" ? "No artifact exists for that reference." : "The video artifact could not be read back (it expired or was cleaned up).", metadata: emptyMetadata(), limitations: ["Video artifacts expire automatically; download or inspect the public URL again."] };
      const referenceUrl = `${this.artifacts.baseUrl}/video-assets/${input.videoReference}`;
      const metadata = object.customMetadata ?? {};
      return { success: true, sourceUrl: referenceUrl, error: null, message: null, metadata: { durationSeconds: finiteOrNull(metadata.durationSeconds), width: finiteOrNull(metadata.width), height: finiteOrNull(metadata.height), contentType: object.httpMetadata?.contentType ?? "video/mp4", contentLength: object.size ?? null, title: null, description: null, thumbnailUrl: null }, limitations: [] };
    }
    if (!input.url) return { success: false, sourceUrl: null, error: "VIDEO_NOT_FOUND", message: "Provide url or video_reference.", metadata: emptyMetadata(), limitations: [] };
    const resolution = await this.resolve(input.url);
    return { success: resolution.success, sourceUrl: resolution.mediaUrl, error: resolution.error, message: resolution.message, metadata: resolution.metadata, limitations: resolution.limitations };
  }

  /**
   * Decode actual frames from a public media URL or rendered page in
   * Cloudflare Browser Run. Public so `ingest()` and diagnostics can reuse
   * the exact same browser path as the individual tools.
   */
  async extractFramesFromSource(sourceUrl: string, request: FrameRequest, directMedia = true): Promise<FrameCaptureResult> {
    const maxDuration = this.maxDuration();
    let resizeFailure: string | null = null;
    try {
      const sessions = new SessionManager(this.env as never, this.requestUrl);
      const captured = await sessions.withRawPage(async (raw: any) => {
        const page = new PuppeteerPageHandle(raw);
        await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeoutMs: LIMITS.videoResolveTimeoutMs });
        await page.waitForTimeout(1_000);
        let info = await this.media.inspect(page);
        if (!info.media.videos.length && directMedia) {
          const installed = await page.evaluate(installPublicVideo, { src: sourceUrl, timeoutMs: 8_000 });
          await page.waitForTimeout(1_000);
          info = await this.media.inspect(page);
          if (!installed.ready && !info.media.videos.length) throw videoError("FRAMES_UNAVAILABLE", installed.error ?? "The browser could not decode a public HTML5 video element.");
        }
        if (!info.media.videos.length) throw videoError("FRAMES_UNAVAILABLE", "The public page did not expose an HTML5 video element to Browser Run.");
        const duration = info.media.videos[0]?.durationSeconds ?? null;
        // Optional resize: scale the viewport so Chromium renders the video at
        // the requested size and the screenshot is smaller. No Worker-side
        // image codec is involved, which keeps this Cloudflare-compatible.
        let resizeApplied: { requested: FrameResize; viewport: { width: number; height: number } } | null = null;
        if (request.resize) {
          const viewport = resizeViewport({ width: info.media.videos[0]?.intrinsicWidth ?? null, height: info.media.videos[0]?.intrinsicHeight ?? null }, request.resize);
          if (viewport) {
            try {
              await page.setViewport(viewport);
              await page.waitForTimeout(400);
              resizeApplied = { requested: request.resize, viewport };
            } catch (error) {
              resizeFailure = error instanceof Error ? error.message : String(error);
            }
          }
        }
        const times = (request.timestamps?.length ? request.timestamps : frameTimestamps(duration, request, maxDuration)).slice(0, LIMITS.videoFramesMaxCount);
        const report = await this.media.sampleFrames(page, {
          timestamps: times,
          count: times.length,
          index: 0,
          type: "jpeg",
          inline: request.inline !== false,
          maxFrames: LIMITS.videoFramesMaxCount,
        });
        return { info, report, resizeApplied };
      });
      const frames: VideoFrameOutput[] = captured.report.frames.map((frame) => {
        const dimensions = frame.inlineData ? imageDimensions(base64ToBytes(frame.inlineData)) : null;
        return {
          timestamp: frame.timeSeconds,
          contentType: contentTypeForFrame(frame.mimeType),
          imageReference: frame.url,
          bytes: frame.bytes,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          ...(frame.inlineData ? { inlineData: frame.inlineData } : {}),
          inspected: frame.ok,
        };
      });
      const limitations = [...captured.report.limitations];
      if (captured.resizeApplied) {
        limitations.push(`Frames were rendered at a ${captured.resizeApplied.viewport.width}×${captured.resizeApplied.viewport.height} viewport to honour the requested resize; the pixel size of each delivered image is reported per frame.`);
      } else if (request.resize && resizeFailure) {
        limitations.push(`The requested resize could not be applied (${redactText(resizeFailure, 160)}); frames were captured at the default viewport size.`);
      }
      return {
        success: captured.report.available,
        error: captured.report.available ? undefined : "FRAMES_UNAVAILABLE",
        message: captured.report.reason ?? undefined,
        sourceUrl,
        durationSeconds: captured.report.durationSeconds,
        width: captured.report.intrinsicSize?.width ?? captured.info.media.videos[0]?.intrinsicWidth ?? null,
        height: captured.report.intrinsicSize?.height ?? captured.info.media.videos[0]?.intrinsicHeight ?? null,
        frames,
        limitations,
      };
    } catch (error) {
      const normal = asBrowserError(error);
      return { success: false, error: normal.code === "capability_unavailable" ? "FRAMES_UNAVAILABLE" : normal.code, message: normal.message, sourceUrl, durationSeconds: null, width: null, height: null, frames: [], limitations: ["Actual frame extraction requires a Cloudflare Browser Run binding and a browser-decodable, non-DRM public video."] };
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Classify the first bytes of a media sample so the diagnostic names the
 * container it actually saw (mp4/mov, webm, HLS playlist, …). */
function sampleShape(bytes: Uint8Array): string {
  const head = (n: number) => bytes.subarray(0, n);
  if (bytes.byteLength >= 12 && head(3).every((b) => b === 0) && new TextDecoder().decode(head(8).subarray(4)) === "ftyp") return "iso-base-media-file-format (mp4/mov)";
  if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "matroska/webm";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xfb) return "mpeg audio";
  if (bytes.byteLength >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "ogg";
  if (bytes.byteLength >= 3 && bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x41) return "hls playlist (#!)";
  if (bytes.byteLength >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png (not a video container)";
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg (not a video container)";
  return "unknown";
}

/** Apply redaction to every detail value of a pipeline stage report. */
function redactedDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    output[key] = typeof value === "string" ? redactText(value, 300) : redactValue(value);
  }
  return output;
}

async function readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function finiteOrNull(value: string | number | undefined): number | null {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function safeVideoMessage(error: unknown, max = 500): string {
  return redactText((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), max);
}

/** Bound a vision-model scene label so one frame cannot flood the payload. */
function boundedSignificance(value: unknown): string {
  const text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } })();
  return redactText(text.replace(/[\r\n]+/g, " "), 240);
}

function emptyMetadata(): VideoMetadata {
  return { durationSeconds: null, width: null, height: null, contentType: null, contentLength: null, title: null, description: null, thumbnailUrl: null };
}

function sanitiseVision(value: any): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : { text: value.slice(0, 1_000) };
    } catch {
      return { text: value.slice(0, 1_000) };
    }
  }
  if (!value || typeof value !== "object") return { result: String(value).slice(0, 1_000) };
  return {
    visible_text: Array.isArray(value.visible_text) ? value.visible_text.slice(0, 50) : value.visible_text ?? [],
    objects_people: Array.isArray(value.objects_people) ? value.objects_people.slice(0, 50) : value.objects_people ?? [],
    actions_events: Array.isArray(value.actions_events) ? value.actions_events.slice(0, 50) : value.actions_events ?? [],
    scene_change: value.scene_change ?? null,
  };
}
