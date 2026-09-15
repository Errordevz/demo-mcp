import { BrowserError, asBrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { redactText } from "../core/redact.js";
import { resolveScreenshotBase } from "../session/factory.js";
import { SessionManager } from "../session/manager.js";
import { MediaInspector } from "../browser/media.js";
import { PuppeteerPageHandle } from "../browser/providers/puppeteer-adapter.js";
import { ScreenshotManager } from "../browser/screenshot.js";
import { capturePublicAudio, installPublicVideo } from "./page-functions.js";
import { contentType, fetchPublic, isPlaylistContentType, isVideoContentType, looksLikeMediaUrl, readBounded, resolvePublicVideo, videoError } from "./http.js";
import { VideoArtifactStore, artifactBaseUrl } from "./store.js";
import type {
  TimestampedTranscriptSegment,
  VideoArtifact,
  VideoEnv,
  VideoFrameOutput,
  VideoInput,
  VideoMetadata,
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

function configuredNumber(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value ?? "");
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

  async download(url: string, requestedMb?: number): Promise<{ resolution: VideoResolution; artifact: VideoArtifact | null; error?: string; message?: string }> {
    this.charge("download", url);
    const resolution = await this.resolve(url);
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

  private async extractFramesFromSource(sourceUrl: string, request: FrameRequest, directMedia = true): Promise<FrameCaptureResult> {
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
