import { BrowserError, asBrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { redactText, redactValue } from "../core/redact.js";
import { resolveScreenshotBase } from "../session/factory.js";
import { SessionManager } from "../session/manager.js";
import { MediaInspector } from "../browser/media.js";
import { PuppeteerPageHandle } from "../browser/providers/puppeteer-adapter.js";
import { ScreenshotManager } from "../browser/screenshot.js";
import { capturePublicAudio, installPublicVideo } from "./page-functions.js";
import {
  contentType,
  fetchPublic,
  formatBytes,
  isPlaylistContentType,
  isVideoContentType,
  looksLikeMediaUrl,
  readBounded,
  resolvePublicVideo,
  videoError,
  videoGuardOptions,
} from "./http.js";
import { VideoArtifactStore, artifactBaseUrl } from "./store.js";
import { assertNavigableUrl } from "../core/url-guard.js";
import type {
  PipelineStageReport,
  TimestampedTranscriptSegment,
  VideoArtifact,
  VideoEnv,
  VideoFrameOutput,
  VideoIngestAudio,
  VideoIngestOptions,
  VideoIngestResult,
  VideoInput,
  VideoMetadata,
  VideoPipelineReport,
  VideoPlatform,
  VideoResolution,
  VideoTranscript,
} from "./types.js";

const operationWindows = new Map<string, { startedAt: number; count: number }>();

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
  const interval = Math.max(0.25, Math.min(request.frameInterval ?? LIMITS.videoFramesDefaultIntervalSeconds, maxDuration));
  if (!Number.isFinite(usableDuration) || usableDuration <= 0) return [0];
  const values: number[] = [];
  for (let time = 0; time < usableDuration && values.length < maxFrames; time += interval) values.push(Number(time.toFixed(3)));
  if (!values.length) values.push(0);
  const last = Math.max(0, Number((Math.min(usableDuration, maxDuration) - 0.05).toFixed(3)));
  if (values.length < maxFrames && last > values[values.length - 1] + 0.1) values.push(last);
  return values.slice(0, maxFrames);
}

function durationFromBytes(bytes: Uint8Array, contentType: string | null): number | null {
  // Parse the common ISO Base Media File Format mvhd box without a media
  // library. This is only a policy check; it is not a decoder.
  if (!(contentType === "video/mp4" || contentType === "video/quicktime" || contentType === "application/octet-stream" || contentType === null)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= view.byteLength) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
    let header = 8;
    if (size === 1 && offset + 16 <= view.byteLength) {
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 2 ** 32 + low;
      header = 16;
    } else if (size === 0) {
      size = view.byteLength - offset;
    }
    if (!Number.isFinite(size) || size < header || offset + size > view.byteLength) break;
    if (type === "moov") {
      let child = offset + header;
      const end = Math.min(offset + size, view.byteLength);
      while (child + 8 <= end) {
        const childSize = view.getUint32(child);
        const childType = String.fromCharCode(view.getUint8(child + 4), view.getUint8(child + 5), view.getUint8(child + 6), view.getUint8(child + 7));
        if (childType === "mvhd" && child + 24 <= end) {
          const version = view.getUint8(child + 8);
          if (version === 0 && child + 28 <= end) {
            const timescale = view.getUint32(child + 20);
            const duration = view.getUint32(child + 24);
            return timescale > 0 ? duration / timescale : null;
          }
          if (version === 1 && child + 40 <= end) {
            const timescale = view.getUint32(child + 28);
            const durationHigh = view.getUint32(child + 32);
            const durationLow = view.getUint32(child + 36);
            return timescale > 0 ? (durationHigh * 2 ** 32 + durationLow) / timescale : null;
          }
        }
        if (!childSize || childSize < 8) break;
        child += childSize;
      }
    }
    offset += size;
  }
  return null;
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

  constructor(env: BrowserVideoEnv, requestUrl?: string | null) {
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
    const outputMode = options.outputMode;
    const needsArtifact = outputMode !== "frames";
    const needsFrames = outputMode !== "video_artifact";

    let resolution = await this.resolve(url);
    const maxDuration = Math.min(options.maxDurationSeconds ?? this.maxDuration(), this.maxDuration());
    const frameRequest: FrameRequest = {
      ...(resolution.metadata.durationSeconds !== null
        ? {
            timestamps: frameTimestamps(
              resolution.metadata.durationSeconds,
              { frameInterval: options.frameIntervalSeconds, maxFrameCount: options.frameCount ?? LIMITS.videoFramesMaxCount },
              maxDuration,
            ),
          }
        : { frameInterval: options.frameIntervalSeconds, maxFrameCount: options.frameCount ?? LIMITS.videoFramesMaxCount }),
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
   * Stage-by-stage diagnostic for the public video pipeline (admin-only tool).
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
  async downloadResolved(resolution: VideoResolution, requestedMb?: number): Promise<{ resolution: VideoResolution; artifact: VideoArtifact | null; error?: string; message?: string }> {
    if (!resolution.success || !resolution.mediaUrl) return { resolution, artifact: null };
    const maxBytes = this.maxDownloadBytes(requestedMb);
    let responseResult;
    try {
      responseResult = await fetchPublic(resolution.mediaUrl, this.env, { method: "GET", headers: { accept: "video/*,application/octet-stream;q=0.8" } }, { timeoutMs: LIMITS.videoDownloadTimeoutMs, referer: resolution.resolvedUrl ?? resolution.sourceUrl });
      if (!responseResult.response.ok) throw videoError("VIDEO_NOT_PUBLIC", `The public media URL returned HTTP ${responseResult.response.status}.`);
      const type = contentType(responseResult.response) ?? resolution.metadata.contentType;
      if (isPlaylistContentType(type, responseResult.finalUrl)) throw videoError("UNSUPPORTED_MEDIA", "The public URL is an HLS playlist, not a bounded video file. Browser playback may still work when the platform exposes it normally.");
      if (!isVideoContentType(type) && !looksLikeMediaUrl(responseResult.finalUrl)) throw videoError("UNSUPPORTED_MEDIA", `The public media response is not a supported video content type${type ? ` (${type})` : ""}.`);
      const bytes = await readBounded(responseResult.response, maxBytes, LIMITS.videoDownloadTimeoutMs);
      const duration = durationFromBytes(bytes, type) ?? resolution.metadata.durationSeconds;
      if (duration === null) throw videoError("UNSUPPORTED_MEDIA", "The public video duration could not be verified from page metadata or the bounded MP4 header, so DEMO refused to persist it.");
      if (duration > this.maxDuration()) throw videoError("VIDEO_NOT_PUBLIC", `The video duration (${duration.toFixed(1)}s) exceeds the ${this.maxDuration()}s processing limit.`);
      if (!this.artifacts.available) throw new BrowserError("capability_unavailable", this.artifacts.unavailableReason(), { capability: "video_artifact_storage" });
      const artifactType = isVideoContentType(type) ? (type as string) : "video/mp4";
      const artifact = await this.artifacts.store(bytes, "video", artifactType, {
        durationSeconds: duration,
        width: resolution.metadata.width,
        height: resolution.metadata.height,
        source: resolution.sourceUrl,
      });
      resolution.metadata = { ...resolution.metadata, contentType: type, contentLength: bytes.byteLength, durationSeconds: duration };
      return { resolution: { ...resolution, status: "downloaded" }, artifact };
    } catch (error) {
      const normal = asBrowserError(error);
      return { resolution, artifact: null, error: normal.code, message: normal.message };
    }
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

  async analyze(input: VideoInput, options: { frameReferences?: string[]; includeTranscript?: boolean } = {}): Promise<Record<string, unknown>> {
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
      for (const frame of frameResult.frames.slice(0, LIMITS.videoMaxVisionFrames)) {
        if (!frame.inlineData) continue;
        try {
          const imageBytes = base64ToBytes(frame.inlineData);
          const imageCopy = new Uint8Array(imageBytes.byteLength);
          imageCopy.set(imageBytes);
          const raw = await ai.run(model, {
            image: imageCopy.buffer,
            prompt: "Inspect this video frame. Return compact JSON with visible_text, objects_people, actions_events, and scene_change. Do not infer anything outside the pixels.",
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
        frames.push({ timestamp: frames.length, contentType: contentTypeForFrame(object.httpMetadata?.contentType ?? null), imageReference: reference, bytes: bytes.byteLength, ...(binary ? { inlineData: binary } : {}), inspected: true });
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
      if (!parsed || parsed.kind !== "video") return { success: false, sourceUrl: null, error: "VIDEO_NOT_FOUND", message: "video_reference must be an expiring video artifact reference such as video_<sha256>.", metadata: emptyMetadata(), limitations: [] };
      const object = await this.artifacts.objectForRoute(input.videoReference);
      if (!object) return { success: false, sourceUrl: null, error: "VIDEO_NOT_FOUND", message: "The video artifact was not found or has expired.", metadata: emptyMetadata(), limitations: ["Video artifacts expire automatically; download or inspect the public URL again."] };
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
        const times = (request.timestamps?.length ? request.timestamps : frameTimestamps(duration, request, maxDuration)).slice(0, LIMITS.videoFramesMaxCount);
        const report = await this.media.sampleFrames(page, {
          timestamps: times,
          count: times.length,
          index: 0,
          type: "jpeg",
          inline: request.inline !== false,
        });
        return { info, report };
      });
      const frames: VideoFrameOutput[] = captured.report.frames.map((frame) => ({
        timestamp: frame.timeSeconds,
        contentType: contentTypeForFrame(frame.mimeType),
        imageReference: frame.url,
        bytes: frame.bytes,
        ...(frame.inlineData ? { inlineData: frame.inlineData } : {}),
        inspected: frame.ok,
      }));
      return {
        success: captured.report.available,
        error: captured.report.available ? undefined : "FRAMES_UNAVAILABLE",
        message: captured.report.reason ?? undefined,
        sourceUrl,
        durationSeconds: captured.report.durationSeconds,
        width: captured.report.intrinsicSize?.width ?? captured.info.media.videos[0]?.intrinsicWidth ?? null,
        height: captured.report.intrinsicSize?.height ?? captured.info.media.videos[0]?.intrinsicHeight ?? null,
        frames,
        limitations: captured.report.limitations,
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
