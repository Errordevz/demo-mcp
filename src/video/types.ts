/**
 * Types shared by the public video pipeline.
 *
 * The pipeline deliberately distinguishes a public URL from a downloaded
 * artifact. A URL is never treated as a local file path and an artifact is
 * always an expiring R2 reference, never an opaque Worker filesystem path.
 */

import type { AccessStatusInfo, VideoAccessStatus } from "./access.js";
import type { MediaSignature } from "./probe.js";
import type { QualityPreference, StreamCandidate } from "./streams.js";
import type { DetectedIntent, IntentInput } from "./intent.js";
import type { TikTokAccessFlags, TikTokMusic, TikTokStats } from "../browser/tiktok.js";

export type VideoPlatform = "tiktok" | "instagram" | "youtube" | "x" | "reddit" | "generic";

/** Where the reported metadata actually came from. */
export type VideoMetadataSource = "direct_url" | "http_headers" | "universal" | "sigi" | "platform_payload" | "json_ld" | "meta" | "none";

/** How strongly the chosen media URL was verified. */
export type VideoVerification =
  /** Real bytes were read and proved a video container signature. */
  | "bytes"
  /** Only the declared content type / literal extension supported it. */
  | "content_type"
  /** Nothing verified it. */
  | "none";

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

/** Creator/account information published by the page. */
export interface VideoCreator {
  id: string | null;
  uniqueId: string | null;
  nickname: string | null;
  verified: boolean | null;
}

/**
 * Everything `video_resolve` reports beyond the bare URL/metadata contract:
 * the honest access verdict, canonical identity, the caption (which is *not* a
 * transcript), every literal stream URL the page published, and how strongly
 * each one was verified.
 */
export interface VideoResolutionDetail {
  access: AccessStatusInfo;
  accessStatus: VideoAccessStatus;
  canonicalUrl: string | null;
  videoId: string | null;
  creator: VideoCreator | null;
  /** The post caption. Never a transcript and never generated text. */
  caption: string | null;
  captionSource: "tiktok_post" | "instagram_post" | "youtube_video" | "x_post" | "reddit_post" | "og_description" | "page_title" | "json_ld" | null;
  hashtags: string[];
  createdAt: string | null;
  stats: TikTokStats | null;
  music: TikTokMusic | null;
  accessFlags: TikTokAccessFlags;
  isImagePost: boolean;
  /** Ranked stream candidates with probe results. */
  streams: StreamCandidate[];
  streamCount: number;
  metadataSource: VideoMetadataSource;
  platformStatusCode: number | null;
  platformStatusMessage: string | null;
  httpStatus: number | null;
  /** How strongly `mediaUrl` was verified. */
  verification: VideoVerification;
  /** Byte-signature of the probed sample, when one was readable. */
  signature: MediaSignature | null;
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
  /** Rich resolution detail (access verdict, streams, creator, caption). */
  detail: VideoResolutionDetail;
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
  /** Pixel size of the actual delivered image, read from its header. */
  width?: number | null;
  height?: number | null;
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
/**
 * Optional decision hook the tool layer may inject so this module never depends on a
 * decision provider. It receives the deterministic verdict and may return a refined one
 * plus the record of what the engine actually said.
 */
export type IntentDecisionHook = (
  input: IntentInput,
  deterministic: DetectedIntent,
) => Promise<{ intent: DetectedIntent | Partial<DetectedIntent>; decision?: unknown }>;

/** What a decision engine contributed, reported verbatim so it can be audited. */
export interface IntentDecisionRecord {
  template: string;
  decision: string;
  source: string;
  policy: string;
  certainty: number | null;
  thresholds: { review: number; accept: number };
  requiresReview: boolean;
  reviewReason: string | null;
  proposedDecision: string | null;
  model: string | null;
  note: string | null;
}

export interface InspectVideoResult {
  inspectionStatus: "complete" | "partial" | "failed";
  source: InspectVideoSource;
  intent: {
    userIntent: string | null;
    question: string | null;
    reactionMode: boolean;
    focus: string;
    /**
     * Present only when a decision engine is configured *and* DEMO's own rules could
     * not decide the focus. Advisory: it refined which frames to look at and nothing
     * else — it granted no permission and skipped no confirmation.
     */
    decision?: IntentDecisionRecord | null;
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

/* -------------------------------------------------------------------------- */
/* `video_resolve` — URL resolution with an honest access verdict              */
/* -------------------------------------------------------------------------- */

export interface VideoResolveOptions {
  /** Preferred stream quality when several literal URLs are published. */
  quality?: QualityPreference;
  /** How many ranked candidates to probe with real public requests. */
  probeLimit?: number;
  /** Verify the chosen stream by reading real bytes (default true). */
  verifyBytes?: boolean;
  /** Omit signed query strings from returned stream URLs (default false). */
  includeSignedUrls?: boolean;
  /** Platform hint; auto-detected when omitted. */
  platform?: VideoPlatform | "auto";
}

export interface VideoResolveResult {
  success: boolean;
  accessStatus: VideoAccessStatus;
  access: AccessStatusInfo;
  platform: VideoPlatform;
  sourceUrl: string;
  resolvedUrl: string | null;
  canonicalUrl: string | null;
  videoId: string | null;
  creator: VideoCreator | null;
  caption: string | null;
  captionSource: VideoResolutionDetail["captionSource"];
  hashtags: string[];
  createdAt: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  contentType: string | null;
  contentLengthBytes: number | null;
  thumbnailUrl: string | null;
  metadataSource: VideoMetadataSource;
  verification: VideoVerification;
  streams: StreamCandidate[];
  streamCount: number;
  bestStreamUrl: string | null;
  stats: TikTokStats | null;
  music: TikTokMusic | null;
  accessFlags: TikTokAccessFlags;
  isImagePost: boolean;
  platformStatusCode: number | null;
  platformStatusMessage: string | null;
  httpStatus: number | null;
  redirectCount: number;
  challenge: { detected: boolean; kind: string | null; reason: string | null };
  signature: MediaSignature | null;
  error: string | null;
  message: string | null;
  limitations: string[];
  /** What the connected AI may say about this URL. */
  guidance: string;
  nextSteps: string[];
}

/* -------------------------------------------------------------------------- */
/* `video_fetch` — verified, streamed retrieval of the actual video bytes       */
/* -------------------------------------------------------------------------- */

export interface VideoFetchOptions {
  maxDurationSeconds?: number;
  maxSizeMb?: number;
  quality?: QualityPreference;
  /** Reuse an already completed resolution instead of resolving again. */
  resolution?: VideoResolution;
}

export interface VideoFetchResult {
  success: boolean;
  accessStatus: VideoAccessStatus;
  sourceUrl: string;
  resolvedUrl: string | null;
  canonicalUrl: string | null;
  mediaUrl: string | null;
  platform: VideoPlatform;
  artifact: VideoArtifact | null;
  /** Real SHA-256 of the stored bytes, or null when the runtime could not digest. */
  sha256: string | null;
  contentAddressed: boolean;
  /** How the bytes reached R2: streamed (bounded memory) or buffered. */
  delivery: "streamed" | "buffered";
  contentType: string | null;
  detectedContainer: string | null;
  signature: MediaSignature | null;
  verification: VideoVerification;
  bytes: number | null;
  durationSeconds: number | null;
  durationSource: "page_metadata" | "head_sample" | "tail_sample" | "artifact_tail" | null;
  durationVerified: boolean;
  width: number | null;
  height: number | null;
  quality: QualityPreference;
  error: string | null;
  message: string | null;
  challenge: { detected: boolean; kind: string | null; reason: string | null };
  limitations: string[];
}

/* -------------------------------------------------------------------------- */
/* `video_analyze` (unified) and `video_react`                                 */
/* -------------------------------------------------------------------------- */

export type VideoAnalysisMode = "summary" | "detailed" | "reaction" | "fact_check_visual" | "transcript" | "full";

export const VIDEO_ANALYSIS_MODES: VideoAnalysisMode[] = ["summary", "detailed", "reaction", "fact_check_visual", "transcript", "full"];

export interface VideoAnalyzeOptions {
  question?: string | null;
  analysisMode?: VideoAnalysisMode;
  maxFrames?: number | null;
  includeAudio?: boolean | null;
  includeTranscript?: boolean | null;
  userIntent?: string | null;
}

/** What evidence actually exists — the core of the honesty contract. */
export interface VideoEvidenceSummary {
  videoBytesRetrieved: boolean;
  framesDecoded: number;
  framesDeliveredInline: number;
  transcriptAvailable: boolean;
  transcriptKind: "speech_to_text" | "none";
  audioAvailable: boolean;
  metadataOnly: boolean;
  thumbnailUsedAsFrame: boolean;
  visualEvidence: boolean;
}

export interface VideoAnalyzeResult {
  success: boolean;
  analysisMode: VideoAnalysisMode;
  accessStatus: VideoAccessStatus;
  access: AccessStatusInfo;
  sourceUrl: string;
  resolvedUrl: string | null;
  canonicalUrl: string | null;
  videoId: string | null;
  platform: VideoPlatform;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  metadata: VideoMetadata & { creator: VideoCreator | null; caption: string | null; captionSource: VideoResolutionDetail["captionSource"]; hashtags: string[]; createdAt: string | null; stats: TikTokStats | null; music: TikTokMusic | null };
  frames: InspectVideoFrame[];
  framesDelivered: number;
  imageBlocksDelivered: number;
  visualEvidenceDelivered: boolean;
  transcript: VideoTranscript | null;
  /** Clearly separated text sources, so a caption is never presented as speech. */
  textSources: {
    transcript: { available: boolean; text: string | null; kind: "speech_to_text" | "none"; provider: string | null };
    platformCaption: { available: boolean; text: string | null; source: VideoResolutionDetail["captionSource"] };
    generatedCaption: { available: false; text: null; note: string };
    onScreenText: { available: boolean; text: string[] | null; source: "vision_model" | "none" };
  };
  audioStatus: "available" | "unavailable" | "failed" | "not_requested";
  detectedScenes: InspectVideoScene[] | null;
  evidence: VideoEvidenceSummary;
  analysisContext: {
    question: string | null;
    userIntent: string | null;
    focus: string;
    reactionMode: boolean;
    whatCanBeAnswered: string[];
    whatCannotBeAnswered: string[];
    factCheck: { requested: boolean; visualClaimsAssessable: boolean; note: string };
    honestyNote: string;
    responseGuidance: string;
  };
  error: string | null;
  message: string | null;
  challenge: { detected: boolean; kind: string | null; reason: string | null };
  limitations: string[];
}

export type VideoReactStyle = "casual" | "funny" | "serious" | "detailed";

export const VIDEO_REACT_STYLES: VideoReactStyle[] = ["casual", "funny", "serious", "detailed"];

export interface VideoReactOptions {
  style?: VideoReactStyle;
  question?: string | null;
  maxFrames?: number | null;
  includeAudio?: boolean | null;
}

/**
 * The grounded evidence package a connected model reacts to. DEMO deliberately
 * does not author the natural-language reaction: `reaction` is always null and
 * `reactionAuthor` names who must produce it, so no fake reaction can ever be
 * returned as if it came from watching the video.
 */
export interface VideoReactResult {
  success: boolean;
  style: VideoReactStyle;
  accessStatus: VideoAccessStatus;
  sourceUrl: string;
  canonicalUrl: string | null;
  platform: VideoPlatform;
  durationSeconds: number | null;
  caption: string | null;
  captionIsNotTranscript: true;
  frames: InspectVideoFrame[];
  framesDelivered: number;
  imageBlocksDelivered: number;
  visualEvidenceDelivered: boolean;
  transcript: VideoTranscript | null;
  audioStatus: "available" | "unavailable" | "failed" | "not_requested";
  evidence: VideoEvidenceSummary;
  /** Frame-grounded observations from a configured server-side vision model. */
  visionSummary: { available: boolean; provider: string | null; observations: string[]; groundedInFrames: boolean } | null;
  /** Always null: DEMO never authors the reaction. */
  reaction: null;
  reactionAuthor: "connected_model";
  reactionGuidance: string;
  styleGuidance: string;
  honestyNote: string;
  error: string | null;
  message: string | null;
  challenge: { detected: boolean; kind: string | null; reason: string | null };
  limitations: string[];
}
