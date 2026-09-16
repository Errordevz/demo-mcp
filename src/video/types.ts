/**
 * Types shared by the public video pipeline.
 *
 * The pipeline deliberately distinguishes a public URL from a downloaded
 * artifact. A URL is never treated as a local file path and an artifact is
 * always an expiring R2 reference, never an opaque Worker filesystem path.
 */

export type VideoPlatform = "tiktok" | "instagram" | "youtube" | "x" | "reddit" | "generic";

export type VideoProcessingStatus =
  | "resolved"
  | "downloaded"
  | "frames_ready"
  | "audio_ready"
  | "transcribed"
  | "partial"
  | "blocked"
  | "unavailable";

export interface VideoMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  contentType: string | null;
  contentLength: number | null;
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
}

export interface VideoResolution {
  success: boolean;
  sourceUrl: string;
  resolvedUrl: string | null;
  mediaUrl: string | null;
  platform: VideoPlatform;
  metadata: VideoMetadata;
  status: VideoProcessingStatus;
  error: string | null;
  message: string | null;
  redirects: string[];
  challenge: { detected: boolean; kind: string | null; reason: string | null };
  limitations: string[];
  /** How many literal public media candidates the page exposed (0 = none). */
  candidateCount: number;
  /** Bounded page metadata used internally and never returned wholesale. */
  pageText?: string;
}

export interface VideoArtifact {
  reference: string;
  kind: "video" | "audio";
  url: string;
  contentType: string;
  bytes: number;
  sha256: string;
  expiresAt: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export interface VideoFrameOutput {
  timestamp: number;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  imageReference: string | null;
  bytes: number;
  /** Base64 without a data: prefix, suitable for an MCP image content block. */
  inlineData?: string;
  inspected: boolean;
}

export interface TimestampedTranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface VideoTranscript {
  status: "transcribed" | "no_speech_detected" | "unavailable";
  language: string | null;
  text: string | null;
  segments: TimestampedTranscriptSegment[];
  provider: string | null;
  message?: string;
}

export interface VideoEnv {
  SCREENSHOTS?: unknown;
  VIDEO_ARTIFACTS?: unknown;
  SCREENSHOT_BASE_URL?: string;
  DEMO_API_KEY?: string;
  SSRF_DNS_CHECK?: string;
  SSRF_DNS_FAIL_OPEN?: string;
  VIDEO_MAX_DURATION_SECONDS?: string | number;
  VIDEO_MAX_DOWNLOAD_MB?: string | number;
  VIDEO_ARTIFACT_TTL_SECONDS?: string | number;
  VIDEO_RATE_LIMIT_PER_MINUTE?: string | number;
  VIDEO_VISION_MODEL?: string;
  VIDEO_TRANSCRIPTION_MODEL?: string;
  AI?: unknown;
  TRANSCRIPTION_ENDPOINT?: string;
  TRANSCRIPTION_API_KEY?: string;
}

export interface VideoInput {
  url?: string;
  videoReference?: string;
}

/** What a single `video_ingest` call should produce. */
export type VideoIngestOutputMode = "frames" | "video_artifact" | "analysis" | "all";

export interface VideoIngestOptions {
  maxDurationSeconds?: number;
  /** Preferred number of representative frames (caps still apply). */
  frameCount?: number;
  /** Seconds between representative frames when `frameCount` is not given. */
  frameIntervalSeconds?: number;
  /** Explicit timestamps in seconds. Takes precedence over interval/count
   * planning; values are clamped to the decoded duration in the browser. */
  timestamps?: number[];
  /** Frame distribution when no explicit timestamps are given:
   * `"interval"` (default, backwards compatible) or `"even"` — first, middle
   * and final meaningful frames with even coverage in between. */
  frameStrategy?: "interval" | "even";
  includeAudio?: boolean;
  includeTranscript?: boolean;
  outputMode: VideoIngestOutputMode;
}

export interface VideoIngestAudio {
  status: "audio_ready" | "no_audio_track" | "unavailable";
  reference: string | null;
  url: string | null;
  contentType: string | null;
  bytes: number | null;
  expiresAt: string | null;
  message: string | null;
}

export interface VideoIngestResult {
  success: boolean;
  error: string | null;
  message: string | null;
  sourceUrl: string;
  resolvedUrl: string | null;
  mediaUrl: string | null;
  platform: VideoPlatform;
  mediaType: "video";
  outputMode: VideoIngestOutputMode;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  contentType: string | null;
  frames: VideoFrameOutput[];
  videoArtifact: VideoArtifact | null;
  audio: VideoIngestAudio | null;
  transcript: VideoTranscript | null;
  analysis: Record<string, unknown> | null;
  analysisReady: boolean;
  challenge: { detected: boolean; kind: string | null; reason: string | null };
  limitations: string[];
}

/** One stage of the `video_inspect_pipeline` diagnostic report. */
export interface PipelineStageReport {
  stage:
    | "url_validation"
    | "redirect_resolution"
    | "media_discovery"
    | "browser_access"
    | "media_retrieval"
    | "frame_extraction"
    | "r2_upload"
    | "artifact_url_generation"
    | "mcp_serialization";
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  detail: Record<string, unknown>;
  error: string | null;
}

export interface VideoPipelineReport {
  url: string;
  overall: "ok" | "partial" | "failed";
  firstFailure: string | null;
  stages: PipelineStageReport[];
  message: string | null;
}

/* -------------------------------------------------------------------------- */
/* High-level automatic video understanding (`inspect_video`)                  */
/* -------------------------------------------------------------------------- */

/** Arguments accepted by `VideoProcessor.inspectVideo`. */
export interface InspectVideoOptions {
  /** The user's original message (e.g. "React to this"). Drives reaction mode
   * and focus; raw text never reaches the vision prompt. */
  userIntent?: string | null;
  /** The explicit question, when the user asked one. */
  question?: string | null;
  /** Explicit reaction-mode override; auto-detected when omitted. */
  reactionMode?: boolean | null;
  /** Preferred frame count; a duration-aware plan is used when omitted. */
  frameCount?: number | null;
  /** Explicit timestamps in seconds; overrides the automatic plan. */
  timestamps?: number[] | null;
  /** Include title/description/content-type metadata (default true). */
  includeMetadata?: boolean | null;
  /** Attempt audio extraction + transcription (default false; best effort and
   * only through the browser's public capture API). */
  includeAudio?: boolean | null;
  /** Frame-grounded scene detection when a vision model is available (default true). */
  analyzeScenes?: boolean | null;
  /** Frame-grounded on-screen-text extraction when a vision model is available (default true). */
  analyzeOnScreenText?: boolean | null;
}

/** One actually decoded frame delivered by `inspect_video`. */
export interface InspectVideoFrame {
  timestamp: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
  /** Position of this frame in the MCP image content blocks, or null when it
   * travels only as an HTTPS reference (inline budget exhausted). */
  imageBlockIndex: number | null;
  /** Short-lived R2 retrieval URL, when frame storage is available. */
  imageReference: string | null;
  /** Base64 image bytes (no data: prefix) for the MCP image content block. */
  inlineData?: string;
  /** Optional vision-grounded hint about what happens around this frame. */
  sceneDescriptionHint: string | null;
}

/** A detected scene segment (populated only from real frame analysis). */
export interface InspectVideoScene {
  start: number;
  end: number | null;
  significance: string;
}

/** Source metadata for an inspected video. */
export interface InspectVideoSource {
  platform: VideoPlatform;
  url: string;
  resolvedUrl: string | null;
  mediaUrl: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  /** Present only when includeMetadata is enabled. */
  contentType: string | null;
  title: string | null;
  description: string | null;
}

/** Result of the high-level `inspect_video` pipeline. */
export interface InspectVideoResult {
  inspectionStatus: "complete" | "partial" | "failed";
  source: InspectVideoSource;
  intent: {
    userIntent: string | null;
    question: string | null;
    reactionMode: boolean;
    focus: string;
  };
  frames: InspectVideoFrame[];
  detectedScenes: InspectVideoScene[] | null;
  extractedText: string[] | null;
  /** Honest audio status; null when audio extraction was not requested. */
  audioStatus: "available" | "unavailable" | "failed" | null;
  transcript: VideoTranscript | null;
  framesDelivered: number;
  imageBlocksDelivered: number;
  /** True only when at least one real decoded frame reached the caller. The
   * connected AI may claim to have seen the video only when this is true. */
  visualEvidenceDelivered: boolean;
  error: string | null;
  message: string | null;
  challenge: { detected: boolean; kind: string | null; reason: string | null };
  limitations: string[];
  /** What the AI may and may not claim based on this result. */
  honestyNote: string;
  /** How to answer the user naturally, given the detected intent. */
  responseGuidance: string;
}
