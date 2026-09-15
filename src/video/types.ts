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
