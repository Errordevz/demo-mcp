import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { errorResult, imageResult, runTool, textResult as rawTextResult, type ToolResult } from "./results.js";
import { redactText } from "../core/redact.js";
import { LIMITS } from "../core/limits.js";
import { BrowserError } from "../core/errors.js";
import { accessStatusGuidance } from "../video/access.js";
import { describeStream, QUALITY_PREFERENCES, type QualityPreference } from "../video/streams.js";
import { notAVideoMessage } from "../video/probe.js";
import { VideoProcessor, type FrameCaptureResult } from "../video/processor.js";
import type {
  VideoAnalysisMode,
  VideoAnalyzeResult,
  VideoEnv,
  VideoFrameOutput,
  VideoInput,
  VideoReactResult,
  VideoReactStyle,
  VideoResolveResult,
  VideoTranscript,
} from "../video/types.js";

export interface VideoToolContext {
  env: VideoEnv & Record<string, unknown>;
  requestUrl?: string | null;
}

function safeVideoUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:api[_-]?key|authorization|client[_-]?secret|password|cookie|session[_-]?id|refresh[_-]?token|access[_-]?token)/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return redactText(value, 2_000);
  }
}

function safeVideoValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (/(?:^|_)(?:url|uri|source_url|media_url|thumbnail_url)(?:$|_)/i.test(key)) return safeVideoUrl(value);
    if (/(?:message|error|limitation|description)/i.test(key)) return redactText(value, 2_000);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => safeVideoValue(entry, key));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = /(?:api[_-]?key|authorization|cookie|password|client[_-]?secret)/i.test(childKey) ? "[redacted]" : safeVideoValue(childValue, childKey);
    }
    return output;
  }
  return value;
}

const inputFields = {
  url: z.string().url().optional().describe("A public http(s) page or direct media URL."),
  video_reference: z.string().optional().describe("An expiring video_<sha256> reference returned by video_download_public."),
};

function processor(ctx: VideoToolContext): VideoProcessor {
  return new VideoProcessor(ctx.env, ctx.requestUrl ?? null);
}

function inputFrom(args: { url?: string; video_reference?: string; audio_reference?: string }): VideoInput {
  return { ...(args.url ? { url: args.url } : {}), ...(args.video_reference || args.audio_reference ? { videoReference: args.video_reference ?? args.audio_reference } : {}) };
}

function requireInput(input: VideoInput): void {
  if (!input.url && !input.videoReference) throw new BrowserError("invalid_input", "Provide either url or video_reference.");
}

function framePayload(frame: VideoFrameOutput) {
  return {
    timestamp: frame.timestamp,
    timestamp_seconds: frame.timestamp,
    content_type: frame.contentType,
    image_reference: frame.imageReference,
    bytes: frame.bytes,
    width: frame.width ?? null,
    height: frame.height ?? null,
    inspected: frame.inspected,
  };
}

function inlineImages(frames: VideoFrameOutput[]): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  let total = 0;
  for (const frame of frames) {
    if (!frame.inlineData) continue;
    const approximateBytes = Math.ceil(frame.inlineData.length * 0.75);
    if (total + approximateBytes > LIMITS.videoInlineMaxTotalBytes) break;
    images.push({ data: frame.inlineData, mimeType: frame.contentType });
    total += approximateBytes;
  }
  return images;
}

function frameToolResult(result: FrameCaptureResult, extra: Record<string, unknown> = {}): ToolResult {
  const payload = {
    success: result.success,
    source_url: result.sourceUrl,
    duration_seconds: result.durationSeconds,
    width: result.width,
    height: result.height,
    frames: result.frames.map(framePayload),
    analysis_ready: result.success && result.frames.some((frame) => frame.inspected),
    limitations: result.limitations,
    ...extra,
    ...(result.error ? { error: result.error } : {}),
    ...(result.message ? { message: result.message } : {}),
  };
  const images = inlineImages(result.frames.filter((frame) => frame.inspected));
  const safePayload = safeVideoValue(payload) as Record<string, unknown>;
  return images.length ? imageResult(images, safePayload) : safeTextResult(safePayload);
}

function structuredVideoError(error: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return errorResult(JSON.stringify(safeVideoValue({ success: false, error, message, ...extra }), null, 2));
}

function safeTextResult(value: unknown): ToolResult {
  return rawTextResult(safeVideoValue(value));
}

function transcriptPayload(transcript: VideoTranscript) {
  return {
    status: transcript.status,
    language: transcript.language,
    text: transcript.text,
    segments: transcript.segments.map((segment) => ({
      start_seconds: segment.startSeconds,
      end_seconds: segment.endSeconds,
      text: segment.text,
    })),
    provider: transcript.provider,
    ...(transcript.message ? { message: transcript.message } : {}),
    // The three text kinds DEMO can ever return, kept strictly separate so a
    // creator's caption is never mistaken for speech, and generated text is
    // never mistaken for either.
    kind: transcript.status === "transcribed" ? "speech_to_text" : "none",
    is_transcript: transcript.status === "transcribed",
    is_generated_text: false,
  };
}

/** `video_resolve` payload: identity, access verdict and real stream list. */
function resolvePayload(result: VideoResolveResult, options: { includeSignedUrls: boolean }) {
  return {
    tool: "video_resolve",
    success: result.success,
    access_status: result.accessStatus,
    access_label: result.access.label,
    // Resolution is metadata, never visual evidence: nothing here may be used to
    // describe what the video shows, even when the item is public.
    may_describe_content: false,
    content_is_publicly_reachable: result.access.mayDescribeContent && result.accessStatus === "public",
    platform: result.platform,
    source_url: result.sourceUrl,
    resolved_url: result.resolvedUrl,
    canonical_url: result.canonicalUrl,
    video_id: result.videoId,
    creator: result.creator
      ? { id: result.creator.id, unique_id: result.creator.uniqueId, nickname: result.creator.nickname, verified: result.creator.verified }
      : null,
    caption: result.caption,
    caption_source: result.captionSource,
    caption_is_not_transcript: true,
    hashtags: result.hashtags,
    created_at: result.createdAt,
    duration_seconds: result.durationSeconds,
    width: result.width,
    height: result.height,
    content_type: result.contentType,
    content_length_bytes: result.contentLengthBytes,
    thumbnail_url: result.thumbnailUrl,
    thumbnail_is_not_a_frame: true,
    metadata_source: result.metadataSource,
    verification: result.verification,
    stream_count: result.streamCount,
    streams: result.streams.map((stream) => describeStream(stream, { includeSignedUrls: options.includeSignedUrls })),
    best_stream_url: result.bestStreamUrl ? (options.includeSignedUrls ? result.bestStreamUrl : `${result.bestStreamUrl.split("?")[0]}?signed_query_removed=true`) : null,
    is_image_post: result.isImagePost,
    platform_status_code: result.platformStatusCode,
    platform_status_message: result.platformStatusMessage,
    http_status: result.httpStatus,
    redirect_count: result.redirectCount,
    challenge: result.challenge,
    signature: result.signature ? { kind: result.signature.kind, detected_as: result.signature.detectedAs, container: result.signature.container, detail: result.signature.detail } : null,
    error: result.error,
    message: result.message,
    limitations: result.limitations,
    guidance: result.guidance,
    next_steps: result.nextSteps,
  };
}

/** Shared honesty block for evidence-bearing tools. */
function evidencePayload(evidence: {
  videoBytesRetrieved: boolean;
  framesDecoded: number;
  framesDeliveredInline: number;
  transcriptAvailable: boolean;
  audioAvailable: boolean;
  metadataOnly: boolean;
  thumbnailUsedAsFrame: boolean;
  visualEvidence: boolean;
}) {
  return {
    video_bytes_retrieved: evidence.videoBytesRetrieved,
    frames_decoded: evidence.framesDecoded,
    frames_delivered_inline: evidence.framesDeliveredInline,
    transcript_available: evidence.transcriptAvailable,
    audio_available: evidence.audioAvailable,
    metadata_only: evidence.metadataOnly,
    thumbnail_used_as_frame: evidence.thumbnailUsedAsFrame,
    visual_evidence: evidence.visualEvidence,
  };
}

function analyzeFramesPayload(frames: VideoAnalyzeResult["frames"]) {
  return frames.map((frame) => ({
    timestamp: frame.timestamp,
    timestamp_seconds: frame.timestamp,
    image: frame.imageBlockIndex !== null ? `mcp_image_block_${frame.imageBlockIndex}` : (frame.imageReference ?? null),
    mime_type: frame.mimeType,
    bytes: frame.bytes,
    ...(frame.imageReference ? { image_reference: frame.imageReference } : {}),
    ...(frame.sceneDescriptionHint ? { scene_description_hint: frame.sceneDescriptionHint } : {}),
  }));
}


export function registerVideoTools(mcp: McpServer, ctx: VideoToolContext): void {
  mcp.registerTool(
    "inspect_video",
    {
      title: "Inspect Video (Watch, Understand & React)",
      description:
        "Automatic video viewing and understanding from a URL alone — the ONLY tool needed when a user sends a video link. Resolves the platform and actual media (direct MP4/WebM files, public video pages, TikTok/Instagram/X/Reddit links including vt./vm. short URLs), extracts REAL decoded frames from throughout the video in Cloudflare Browser Rendering (first, middle, final and intent-biased moments — never thumbnails or cover images), and returns them as MCP image content blocks a vision model can examine directly, plus structured context: source metadata, detected scenes, on-screen text, honest audio status. " +
        "CALL AUTOMATICALLY when a user sends a public video URL and asks 'What do you think of this?', 'React to this.', 'Watch this.', 'What happens?', 'Is this real?', 'Is this funny?', 'Explain this video.', 'Rate the vibe.', 'Look at this', 'What does the text say?', or pastes only a link with no explanation — pass the user's original message as userIntent and their explicit question as question; reaction mode and the frame plan are then derived automatically. Never ask the user to download the video, extract frames, upload screenshots, or provide timestamps. " +
        "RESPONSE CONTRACT: the returned image blocks are the visual evidence. When visualEvidenceDelivered=true, examine the frames and answer the user's intent naturally — for reaction requests give a genuine, context-aware reaction matching the user's tone instead of a robotic metadata summary; mention uncertainty where the frames do not establish something. When visualEvidenceDelivered=false the inspection failed: say so honestly and NEVER claim to have seen or watched the video. Frames are samples, not continuous playback: do not claim to have watched the whole video, and never invent audio, dialogue, or events outside the frames.",
      annotations: {
        title: "Inspect Video (Watch, Understand & React)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().url().describe("Public video URL: a direct media file (mp4/webm/mov), a public video page, or a share/short link (https://vt.tiktok.com/..., https://vm.tiktok.com/..., Instagram/X/Reddit/YouTube links)."),
        userIntent: z.string().max(2_000).optional().describe("The user's original message, e.g. 'React to this' or 'Is this real?'. Drives automatic reaction mode and analysis focus."),
        question: z.string().max(2_000).optional().describe("The explicit question about the video, when the user asked one."),
        reactionMode: z.boolean().optional().describe("Force reaction mode on/off. Omit to auto-detect: enabled when the user says 'react', 'what do you think', 'look at this', or sends only the link."),
        frameCount: z.number().int().min(1).max(LIMITS.videoFramesMaxCount).optional().describe("Frames to extract. Omit for the automatic duration-aware plan (5–8 frames under 10s, 8–12 up to a minute, up to 16 for longer videos)."),
        timestamps: z.array(z.number().min(0)).max(LIMITS.videoFramesMaxCount).optional().describe("Explicit timestamps in seconds. Omit for automatic beginning/middle/end sampling biased toward the user's focus (e.g. the ending for 'what happens at the end?')."),
        includeMetadata: z.boolean().default(true).describe("Include title/description/content-type metadata in the source object."),
        includeAudio: z.boolean().default(false).describe("Best-effort audio extraction + speech-to-text when the Cloudflare-compatible capture path supports it. audioStatus reports 'available' | 'unavailable' | 'failed' honestly; visual analysis never depends on audio and dialogue is never fabricated."),
        analyzeScenes: z.boolean().default(true).describe("Frame-grounded scene detection when a server-side vision model is configured; unavailable analysis is reported, never guessed."),
        analyzeOnScreenText: z.boolean().default(true).describe("Frame-grounded on-screen text (OCR) extraction when a server-side vision model is configured; the raw frames are always returned so the calling vision model can read text itself."),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await processor(ctx).inspectVideo(args.url, {
          userIntent: args.userIntent ?? null,
          question: args.question ?? null,
          reactionMode: args.reactionMode ?? null,
          frameCount: args.frameCount ?? null,
          timestamps: args.timestamps ?? null,
          includeMetadata: args.includeMetadata,
          includeAudio: args.includeAudio,
          analyzeScenes: args.analyzeScenes,
          analyzeOnScreenText: args.analyzeOnScreenText,
        });
        const images = result.frames
          .filter((frame) => frame.imageBlockIndex !== null && frame.inlineData)
          .sort((a, b) => (a.imageBlockIndex as number) - (b.imageBlockIndex as number))
          .map((frame) => ({ data: frame.inlineData as string, mimeType: frame.mimeType }));
        const payload = {
          tool: "inspect_video",
          inspectionStatus: result.inspectionStatus,
          source: {
            platform: result.source.platform,
            url: result.source.url,
            resolvedUrl: result.source.resolvedUrl,
            durationSeconds: result.source.durationSeconds,
            width: result.source.width,
            height: result.source.height,
            ...(result.source.contentType !== null ? { mimeType: result.source.contentType } : {}),
            ...(result.source.title !== null ? { title: result.source.title } : {}),
            ...(result.source.description !== null ? { description: result.source.description } : {}),
          },
          intent: {
            userIntent: result.intent.userIntent,
            question: result.intent.question,
            reactionMode: result.intent.reactionMode,
            focus: result.intent.focus,
          },
          frames: result.frames.map((frame) => ({
            timestamp: frame.timestamp,
            image: frame.imageBlockIndex !== null ? `mcp_image_block_${frame.imageBlockIndex}` : (frame.imageReference ?? null),
            mimeType: frame.mimeType,
            bytes: frame.bytes,
            ...(frame.imageReference ? { imageReference: frame.imageReference } : {}),
            ...(frame.sceneDescriptionHint ? { sceneDescriptionHint: frame.sceneDescriptionHint } : {}),
          })),
          detectedScenes: result.detectedScenes,
          extractedText: result.extractedText,
          audioStatus: result.audioStatus,
          transcript: result.transcript ? transcriptPayload(result.transcript) : null,
          framesDelivered: result.framesDelivered,
          imageBlocksDelivered: result.imageBlocksDelivered,
          visualEvidenceDelivered: result.visualEvidenceDelivered,
          ...(result.error ? { error: result.error } : {}),
          ...(result.message ? { message: result.message } : {}),
          challenge: result.challenge,
          limitations: result.limitations,
          honestyNote: result.honestyNote,
          responseGuidance: result.responseGuidance,
          imageDeliveryNote:
            "MCP image content blocks precede this JSON, in frame order: mcp_image_block_N is the (N+1)th image block. imageReference values are short-lived R2 retrieval links for the same decoded frames.",
        };
        const safePayload = safeVideoValue(payload) as Record<string, unknown>;
        if (result.inspectionStatus === "failed") return errorResult(JSON.stringify(safePayload, null, 2));
        return images.length ? imageResult(images, safePayload) : safeTextResult(safePayload);
      }),
  );

  mcp.registerTool(
    "video_resolve",
    {
      title: "Resolve Video URL",
      description:
        "Resolve a public video URL into its real identity and playable streams WITHOUT downloading or claiming to have watched anything. Follows TikTok short links (vt.tiktok.com, vm.tiktok.com) and canonical @user/video/<id> URLs as normal public redirects, validates every hop against the SSRF guard, and parses the page robustly from several independent sources (TikTok's __UNIVERSAL_DATA_FOR_REHYDRATION__ hydration payload with its published item status code, SIGI_STATE, schema.org JSON-LD, OpenGraph/Twitter meta and literal <video> elements) instead of one fragile selector. " +
        "Returns canonical_url, video_id, creator, caption (which is NOT a transcript), duration, dimensions, every literal stream URL the page published with per-stream probe results, and — most importantly — access_status: public | deleted | private | login_required | region_restricted | challenge_required | rate_limited | not_found | expired | blocked_url | unsupported | unavailable | unknown. " +
        "Use it to find out whether a video is actually retrievable before promising the user anything. CAPTCHAs, login walls, DRM and private accounts are reported, never bypassed. Signed CDN URLs are short-lived and are never logged or persisted.",
      annotations: { title: "Resolve Video URL", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        url: z.string().url().describe("Public video URL: a TikTok/Instagram/X/Reddit/YouTube page or share link (incl. vt./vm. short links), any public video page, or a direct media file URL."),
        platform: z.enum(["auto", "tiktok", "instagram", "youtube", "x", "reddit", "generic"]).default("auto").describe("Optional platform hint. Detection is host-based; a mismatching hint is reported, not trusted."),
        quality: z.enum(QUALITY_PREFERENCES).default("auto").describe("Preferred stream when the page publishes several literal URLs. Never raises any size or duration limit."),
        probe_limit: z.number().int().min(1).max(LIMITS.videoMaxProbedStreams).default(LIMITS.videoMaxProbedStreams).describe("How many ranked stream candidates to probe with normal public requests."),
        verify_bytes: z.boolean().default(true).describe("Read a bounded 128 KiB sample of each probed stream and prove the container from its byte signature (recommended)."),
        include_signed_urls: z.boolean().default(true).describe("Set false to strip signed/expiring query strings from returned stream URLs. Those URLs are then not directly fetchable."),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await processor(ctx).resolveDetailed(args.url, {
          platform: args.platform,
          quality: args.quality as QualityPreference,
          probeLimit: args.probe_limit,
          verifyBytes: args.verify_bytes,
          includeSignedUrls: args.include_signed_urls,
        });
        const payload = safeVideoValue(resolvePayload(result, { includeSignedUrls: args.include_signed_urls })) as Record<string, unknown>;
        // A non-public verdict is not a tool crash — it is the answer. Only a
        // guard rejection is surfaced as an MCP error.
        if (result.accessStatus === "blocked_url") return errorResult(JSON.stringify(payload, null, 2));
        return safeTextResult(payload);
      }),
  );

  mcp.registerTool(
    "video_fetch",
    {
      title: "Fetch Actual Video Bytes",
      description:
        "Retrieve the ACTUAL video file (not metadata, not a thumbnail) from a public URL or a previous video_reference, and store it as an expiring Cloudflare R2 artifact. The body is STREAMED into R2 through a bounded transform — a Worker never buffers the whole file and never touches a local disk. The first 128 KiB are inspected and must prove a real video container signature (ISO-BMFF/mp4/mov, Matroska/WebM, Ogg, MPEG-TS, FLV). " +
        "If the response turns out to be an HTML page, a JSON error, a JPEG/PNG thumbnail, an audio-only file or an HLS/DASH manifest, the partial object is deleted and the call fails with NOT_A_VIDEO or UNSUPPORTED_MEDIA plus detected_as — a failed retrieval is never reported as a download. Enforces size, duration, timeout and content-type policy, validates every redirect hop against the SSRF guard, and never sends cookies or bypasses login, CAPTCHA, DRM or private-account controls.",
      annotations: { title: "Fetch Actual Video Bytes", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().url().optional().describe("Public video URL (page or direct media file). Provide url or video_reference."),
        video_reference: z.string().optional().describe("An expiring video_<64 hex> reference from a previous video_fetch/video_download_public. Reports its true state (ok | expired | missing)."),
        max_duration: z.number().int().min(1).max(LIMITS.videoMaxDurationSeconds).optional().describe("Maximum video duration in seconds. Can only lower the deployment limit."),
        max_size_mb: z.number().int().min(1).max(LIMITS.videoMaxDownloadMb).optional().describe("Maximum download size in MiB. Can only lower the deployment limit."),
        quality: z.enum(QUALITY_PREFERENCES).default("auto").describe("Which published stream to prefer when several exist."),
      },
    },
    (args) =>
      runTool(async () => {
        const input: VideoInput = { ...(args.url ? { url: args.url } : {}), ...(args.video_reference ? { videoReference: args.video_reference } : {}) };
        if (!input.url && !input.videoReference) throw new BrowserError("invalid_input", "Provide either url or video_reference.");
        const result = await processor(ctx).fetchVideo(input, { maxDurationSeconds: args.max_duration, maxSizeMb: args.max_size_mb, quality: args.quality as QualityPreference });
        const payload = safeVideoValue({
          tool: "video_fetch",
          success: result.success,
          access_status: result.accessStatus,
          guidance: accessStatusGuidance(result.accessStatus),
          source_url: result.sourceUrl,
          resolved_url: result.resolvedUrl,
          canonical_url: result.canonicalUrl,
          platform: result.platform,
          artifact: result.artifact
            ? {
                video_reference: result.artifact.reference,
                url: result.artifact.url,
                content_type: result.artifact.contentType,
                bytes: result.artifact.bytes,
                sha256: result.artifact.sha256,
                content_addressed: result.contentAddressed,
                expires_at: result.artifact.expiresAt,
              }
            : null,
          delivery: result.delivery,
          verification: result.verification,
          detected_container: result.detectedContainer,
          signature: result.signature ? { kind: result.signature.kind, detected_as: result.signature.detectedAs, container: result.signature.container, detail: result.signature.detail } : null,
          content_type: result.contentType,
          bytes: result.bytes,
          duration_seconds: result.durationSeconds,
          duration_source: result.durationSource,
          duration_verified: result.durationVerified,
          width: result.width,
          height: result.height,
          quality: result.quality,
          challenge: result.challenge,
          limitations: result.limitations,
          error: result.error,
          message: result.message,
          ...(result.error === "NOT_A_VIDEO" && result.signature ? { detected_as: result.signature.detectedAs, why_not_a_video: notAVideoMessage(result.signature) } : {}),
          honesty_note: result.success
            ? "Verified video bytes are stored in temporary R2 storage. This proves retrieval only — it is not visual understanding. Call video_extract_frames or video_analyze to actually inspect content."
            : "Nothing was retrieved and nothing is stored. DEMO does not claim a download that did not produce verified video bytes.",
        }) as Record<string, unknown>;
        return result.success ? safeTextResult(payload) : errorResult(JSON.stringify(payload, null, 2));
      }),
  );

  mcp.registerTool(
    "video_inspect_url",
    {
      title: "Inspect Public Video URL",
      description:
        "Resolve a public webpage or direct media URL, follow only safe public redirects, locate literal public video media, and return timestamped MCP image frames when Cloudflare Browser Run can decode them. Login walls, DRM and bot challenges are reported rather than bypassed.",
      inputSchema: {
        url: z.string().url(),
        max_duration: z.number().int().min(1).max(LIMITS.videoMaxDurationSeconds).optional().describe("Maximum seconds processed; never increases the deployment limit."),
        frame_interval: z.number().min(0.5).max(120).default(LIMITS.videoFramesDefaultIntervalSeconds).describe("Seconds between representative frames."),
        include_transcript: z.boolean().default(true),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await processor(ctx).inspect(args.url, { maxDuration: args.max_duration, frameInterval: args.frame_interval, includeTranscript: args.include_transcript });
        const payload = {
          success: result.success,
          source_url: result.sourceUrl,
          resolved_url: result.resolvedUrl,
          media_url: result.mediaUrl,
          platform: result.platform,
          duration_seconds: result.metadata.durationSeconds,
          width: result.metadata.width,
          height: result.metadata.height,
          content_type: result.metadata.contentType,
          content_length: result.metadata.contentLength,
          title: result.metadata.title,
          description: result.metadata.description,
          thumbnail_url: result.metadata.thumbnailUrl,
          processing_status: result.processingStatus,
          analysis_ready: result.analysisReady,
          frames: result.frames.map(framePayload),
          transcript: result.transcript ? transcriptPayload(result.transcript) : null,
          challenge: result.challenge,
          limitations: result.limitations,
          ...(result.error ? { error: result.error } : {}),
          ...(result.message ? { message: result.message } : {}),
          visibility_note: result.frames.some((frame) => frame.inlineData)
            ? "Actual decoded frame images are included as MCP image content blocks; image_reference values are short-lived R2 retrieval links."
            : "No decoded frame image was returned. DEMO does not claim to have seen the video; inspect the error and limitations fields.",
        };
        const images = inlineImages(result.frames);
        const safePayload = safeVideoValue(payload) as Record<string, unknown>;
        return images.length ? imageResult(images, safePayload) : safeTextResult(safePayload);
      }),
  );

  mcp.registerTool(
    "video_ingest",
    {
      title: "Ingest Public Video",
      description:
        "One-call public video ingestion. Validates the URL, follows only safe public redirects (TikTok https://www.tiktok.com/..., https://vm.tiktok.com/... and https://vt.tiktok.com/... short links supported), downloads the actual media file to expiring R2 storage, decodes real frames in Cloudflare Browser Run, and returns MCP image content blocks plus short-lived artifact URLs. Never bypasses CAPTCHAs, logins, paywalls or DRM; failures name the exact stage and stable error code.",
      inputSchema: {
        url: z.string().url().describe("Public video URL: a page or a direct media URL, including TikTok short links."),
        max_duration_seconds: z.number().int().min(1).max(LIMITS.videoMaxDurationSeconds).optional().describe("Maximum video duration processed; never raises the deployment limit."),
        frame_count: z.number().int().min(1).max(LIMITS.videoFramesMaxCount).optional().describe("Representative frames to extract (capped by the deployment limit)."),
        frame_interval_seconds: z.number().min(0.5).max(120).optional().describe("Seconds between frames when frame_count is omitted."),
        include_audio: z.boolean().default(false).describe("Also extract the decoded audio track to an expiring audio artifact (best effort, non-DRM only)."),
        include_transcript: z.boolean().default(false).describe("Also request speech-to-text when a server-side provider is configured."),
        output_mode: z.enum(["frames", "video_artifact", "analysis", "all"]).default("all").describe("frames: decoded frames only; video_artifact: R2-stored media file only; analysis: frames plus frame-grounded analysis fields; all: frames and artifact (audio/transcript when requested)."),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await processor(ctx).ingest(args.url, {
          maxDurationSeconds: args.max_duration_seconds,
          frameCount: args.frame_count,
          frameIntervalSeconds: args.frame_interval_seconds,
          includeAudio: args.include_audio,
          includeTranscript: args.include_transcript,
          outputMode: args.output_mode,
        });
        const payload = {
          success: result.success,
          source_url: result.sourceUrl,
          resolved_url: result.resolvedUrl,
          media_url: result.mediaUrl,
          platform: result.platform,
          media_type: result.mediaType,
          output_mode: result.outputMode,
          duration_seconds: result.durationSeconds,
          width: result.width,
          height: result.height,
          mime_type: result.contentType,
          frames: result.frames.map((frame) => ({
            timestamp_seconds: frame.timestamp,
            mime_type: frame.contentType,
            url: frame.imageReference,
            bytes: frame.bytes,
            inspected: frame.inspected,
          })),
          video_artifact: result.videoArtifact
            ? {
                mime_type: result.videoArtifact.contentType,
                url: result.videoArtifact.url,
                reference: result.videoArtifact.reference,
                bytes: result.videoArtifact.bytes,
                sha256: result.videoArtifact.sha256,
                expires_at: result.videoArtifact.expiresAt,
              }
            : null,
          audio: result.audio,
          transcript: result.transcript ? transcriptPayload(result.transcript) : null,
          analysis: result.analysis,
          analysis_ready: result.analysisReady,
          challenge: result.challenge,
          limitations: result.limitations,
          ...(result.error ? { error: result.error } : {}),
          ...(result.message ? { message: result.message } : {}),
          visibility_note: result.frames.some((frame) => frame.inlineData)
            ? "Actual decoded frame images are included as MCP image content blocks. Frame url values are short-lived R2 retrieval links; video_artifact.url is a short-lived R2 media link."
            : "No decoded frame image was returned. DEMO does not claim to have seen the video; inspect the error and limitations fields.",
        };
        const images = inlineImages(result.frames.filter((frame) => frame.inspected));
        const safePayload = safeVideoValue(payload) as Record<string, unknown>;
        return images.length ? imageResult(images, safePayload) : safeTextResult(safePayload);
      }),
  );

  mcp.registerTool(
    "video_download_public",
    {
      title: "Download Public Video",
      description:
        "Download a bounded, publicly accessible video into expiring Cloudflare R2 storage. It validates every redirect, content type, byte limit, timeout and known duration. It never sends cookies or bypasses login, CAPTCHA, DRM or private-account controls.",
      inputSchema: {
        url: z.string().url(),
        max_size_mb: z.number().int().min(1).max(LIMITS.videoMaxDownloadMb).optional().describe("Maximum download size, capped by the deployment policy."),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await processor(ctx).download(args.url, args.max_size_mb);
        if (!result.artifact) return structuredVideoError(result.error ?? result.resolution.error ?? "VIDEO_NOT_PUBLIC", result.message ?? result.resolution.message ?? "The public video could not be downloaded.", { source_url: args.url, resolved_url: result.resolution.resolvedUrl, media_url: result.resolution.mediaUrl, platform: result.resolution.platform, limitations: result.resolution.limitations });
        return safeTextResult({
          success: true,
          source_url: args.url,
          resolved_url: result.resolution.resolvedUrl,
          media_url: result.resolution.mediaUrl,
          platform: result.resolution.platform,
          artifact: {
            video_reference: result.artifact.reference,
            media_url: result.artifact.url,
            content_type: result.artifact.contentType,
            bytes: result.artifact.bytes,
            sha256: result.artifact.sha256,
            expires_at: result.artifact.expiresAt,
          },
          duration_seconds: result.resolution.metadata.durationSeconds,
          width: result.resolution.metadata.width,
          height: result.resolution.metadata.height,
          processing_status: "downloaded",
          cleanup: "The artifact is content-addressed and expires automatically; the route rejects expired references.",
        });
      }),
  );

  mcp.registerTool(
    "video_extract_frames",
    {
      title: "Extract Public Video Frames",
      description:
        "Decode a public non-DRM video in Cloudflare Browser Rendering and return ACTUAL timestamped image content blocks plus expiring R2 references. Frames are rendered pixels seeked from the real <video> element — never thumbnails, posters, cover images or webpage screenshots. Representative sampling always covers the beginning, middle and end; explicit `timestamps` give targeted inspection. A URL or video_reference is required. When no frame can be decoded the result says so explicitly (success=false, FRAMES_UNAVAILABLE, frames=[]) instead of substituting metadata.",
      inputSchema: {
        ...inputFields,
        timestamps: z.array(z.number().min(0)).max(LIMITS.videoFramesMaxCount).optional().describe("Explicit timestamps in seconds. Takes precedence over interval sampling."),
        interval_seconds: z.number().min(0.5).max(120).optional().describe("Seconds between representative frames when no explicit timestamps are given."),
        frame_interval: z.number().min(0.5).max(120).optional().default(LIMITS.videoFramesDefaultIntervalSeconds).describe("Alias of interval_seconds (kept for backwards compatibility)."),
        max_frames: z.number().int().min(1).max(LIMITS.videoFramesMaxCount).optional().describe("Maximum frames to return. Defaults to the deployment cap."),
        max_frame_count: z.number().int().min(1).max(LIMITS.videoFramesMaxCount).default(LIMITS.videoFramesMaxCount).describe("Alias of max_frames (kept for backwards compatibility)."),
        resize: z
          .object({
            max_width: z.number().int().min(LIMITS.videoFrameResizeMinPx).max(LIMITS.videoFrameResizeMaxPx).optional(),
            max_height: z.number().int().min(LIMITS.videoFrameResizeMinPx).max(LIMITS.videoFrameResizeMaxPx).optional(),
          })
          .optional()
          .describe("Optional output size bound. Applied by scaling the browser viewport so Chromium renders smaller frames — no Worker-side image codec, and frames are never upscaled."),
        inline: z.boolean().default(true).describe("Include MCP image blocks when each frame is within the inline size cap."),
      },
    },
    (args) =>
      runTool(async () => {
        const input = inputFrom(args);
        requireInput(input);
        const maxFrames = args.max_frames ?? args.max_frame_count;
        const interval = args.interval_seconds ?? args.frame_interval;
        const result = await processor(ctx).extractFrames(input, {
          timestamps: args.timestamps,
          frameInterval: interval,
          maxFrameCount: maxFrames,
          inline: args.inline,
          resize: args.resize ? { maxWidth: args.resize.max_width ?? null, maxHeight: args.resize.max_height ?? null } : null,
        });
        return frameToolResult(result, { video_reference: args.video_reference ?? null, resize_requested: args.resize ?? null });
      }),
  );

  mcp.registerTool(
    "video_extract_audio",
    {
      title: "Extract Public Video Audio",
      description:
        "Best-effort extraction of a decoded public audio track using the browser Media Capture API. Returns an expiring audio artifact, or an honest no-audio/unsupported result; it never touches DRM or protected streams.",
      inputSchema: {
        ...inputFields,
        max_seconds: z.number().int().min(1).max(LIMITS.videoAudioMaxSeconds).default(LIMITS.videoAudioMaxSeconds),
      },
    },
    (args) =>
      runTool(async () => {
        const input = inputFrom(args);
        requireInput(input);
        const result = await processor(ctx).extractAudio(input, { maxSeconds: args.max_seconds });
        if (!result.artifact) {
          if (result.status === "no_audio_track") return safeTextResult({ success: true, status: "no_audio_track", audio_reference: null, duration_seconds: result.durationSeconds, message: result.message });
          return structuredVideoError(result.error ?? "TRANSCRIPTION_UNAVAILABLE", result.message ?? "The audio track could not be extracted.", { status: result.status, duration_seconds: result.durationSeconds });
        }
        return safeTextResult({
          success: true,
          status: "audio_ready",
          audio_reference: result.artifact.reference,
          audio_url: result.artifact.url,
          content_type: result.artifact.contentType,
          bytes: result.artifact.bytes,
          duration_seconds: result.durationSeconds,
          expires_at: result.artifact.expiresAt,
        });
      }),
  );

  mcp.registerTool(
    "video_transcribe",
    {
      title: "Transcribe Public Video",
      description:
        "Produce timestamped speech-to-text for an expiring audio/video reference or public URL, using a configurable provider (Workers AI Whisper by default, or an explicitly configured HTTPS TRANSCRIPTION_ENDPOINT). Omit `language` for provider-side language detection, or pass a hint. Empty speech returns no_speech_detected; a missing provider returns TRANSCRIPTION_UNAVAILABLE. The result always states kind=speech_to_text and is_transcript=true so real transcribed speech can never be confused with a creator's post caption or with generated text — DEMO invents dialogue in no circumstance.",
      inputSchema: {
        url: z.string().url().optional(),
        video_reference: z.string().optional(),
        audio_reference: z.string().optional(),
        language: z.string().min(2).max(20).optional().describe("Optional language hint (e.g. \"en\", \"es\"). Omit to let the provider detect the language."),
      },
    },
    (args) =>
      runTool(async () => {
        const input = inputFrom(args);
        requireInput(input);
        const transcript = await processor(ctx).transcribe(input, { language: args.language });
        const providerConfigured = Boolean(ctx.env.AI || ctx.env.TRANSCRIPTION_ENDPOINT);
        const payload = {
          tool: "video_transcribe",
          success: transcript.status !== "unavailable",
          transcript: transcriptPayload(transcript),
          language_detected: transcript.language,
          language_hint: args.language ?? null,
          provider: transcript.provider,
          provider_configured: providerConfigured,
          captions_note:
            "This tool only ever returns speech-to-text. A platform post caption (caption_source in video_resolve) was written by the creator and is never a transcript; DEMO generates no caption text of its own.",
        };
        if (transcript.status === "unavailable") {
          return structuredVideoError(
            providerConfigured ? "TRANSCRIPTION_UNAVAILABLE" : "PROVIDER_UNAVAILABLE",
            transcript.message ?? "Speech-to-text is not available.",
            { ...payload, hint: providerConfigured ? undefined : "Bind Workers AI (AI) or set TRANSCRIPTION_ENDPOINT + TRANSCRIPTION_API_KEY. Without a provider DEMO reports the audio as untranscribed instead of inventing dialogue." },
          );
        }
        return safeTextResult(payload);
      }),
  );

  mcp.registerTool(
    "video_analyze",
    {
      title: "Analyze Public Video (Unified)",
      description:
        "The unified high-level video analysis tool: resolve the URL → retrieve the actual media → extract representative decoded frames (beginning, middle, end) → optionally extract and transcribe audio → return one structured evidence result. The payload contains access_status, source_url, canonical_url, duration, metadata (creator, post caption, dimensions, published stats), frames with timestamps delivered as MCP image content blocks, the transcript when one exists, limitations, and analysis_context telling you exactly what can and cannot be answered from this evidence. " +
        "Text sources are kept strictly separate: textSources.transcript is real speech-to-text, textSources.platformCaption is the creator's post caption, textSources.generatedCaption is always unavailable (DEMO generates none), and textSources.onScreenText only exists when a vision model read the actual frames. If no frames and no transcript could be obtained, the result says so and MUST NOT be used to describe the video.",
      annotations: { title: "Analyze Public Video (Unified)", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().url().describe("Public video URL (page, share/short link or direct media file)."),
        question: z.string().max(2_000).optional().describe("The specific question to answer from the video, e.g. \"Is this real?\" or \"What does the text say?\". Biases frame allocation and the vision focus."),
        analysis_mode: z.enum(["summary", "detailed", "reaction", "fact_check_visual", "transcript", "full"]).default("summary").describe("summary: ~8 frames. detailed: ~12 frames + audio/transcript. reaction: intent-biased frames for a natural reaction. fact_check_visual: up to 16 dense frames focused on staging/editing evidence. transcript: minimal frames + forced audio/transcript. full: maximum frames + audio + transcript + vision analysis."),
        max_frames: z.number().int().min(1).max(LIMITS.videoFramesMaxCount).optional().describe("Override the mode's frame budget (still capped by the deployment limit)."),
        include_audio: z.boolean().optional().describe("Attempt audio extraction + transcription. Defaults per analysis_mode; audioStatus always reports available | unavailable | failed | not_requested honestly."),
        include_transcript: z.boolean().optional().describe("Request speech-to-text when a provider is configured. Defaults per analysis_mode."),
        frame_references: z.array(z.string()).max(LIMITS.videoFramesMaxCount).optional().describe("Previously returned frame references to analyse without re-decoding. References alone are not visual evidence unless the Worker can retrieve them."),
      },
    },
    (args) =>
      runTool(async () => {
        // Re-analyse already-decoded frames without touching the network again.
        if (!args.url && args.frame_references?.length) {
          return safeTextResult(await processor(ctx).analyze({ url: undefined }, { frameReferences: args.frame_references, includeTranscript: false }));
        }
        if (!args.url) throw new BrowserError("invalid_input", "Provide url (or frame_references to re-analyse stored frames).");
        const result = await processor(ctx).analyzeUnified(args.url, {
          question: args.question ?? null,
          analysisMode: args.analysis_mode as VideoAnalysisMode,
          maxFrames: args.max_frames ?? null,
          includeAudio: args.include_audio ?? null,
          includeTranscript: args.include_transcript ?? null,
        });
        const images = result.frames
          .filter((frame) => frame.imageBlockIndex !== null && frame.inlineData)
          .sort((a, b) => (a.imageBlockIndex as number) - (b.imageBlockIndex as number))
          .map((frame) => ({ data: frame.inlineData as string, mimeType: frame.mimeType }));
        const payload = safeVideoValue({
          tool: "video_analyze",
          success: result.success,
          analysis_mode: result.analysisMode,
          access_status: result.accessStatus,
          access_label: result.access.label,
          may_describe_content: result.visualEvidenceDelivered || result.textSources.transcript.available,
          source_url: result.sourceUrl,
          resolved_url: result.resolvedUrl,
          canonical_url: result.canonicalUrl,
          video_id: result.videoId,
          platform: result.platform,
          duration_seconds: result.durationSeconds,
          width: result.width,
          height: result.height,
          metadata: {
            content_type: result.metadata.contentType,
            content_length: result.metadata.contentLength,
            title: result.metadata.title,
            description: result.metadata.description,
            creator: result.metadata.creator,
            caption: result.metadata.caption,
            caption_source: result.metadata.captionSource,
            hashtags: result.metadata.hashtags,
            created_at: result.metadata.createdAt,
            stats: result.metadata.stats,
            music: result.metadata.music,
            thumbnail_url: result.metadata.thumbnailUrl,
            thumbnail_is_not_a_frame: true,
          },
          frames: analyzeFramesPayload(result.frames),
          frames_delivered: result.framesDelivered,
          image_blocks_delivered: result.imageBlocksDelivered,
          visual_evidence_delivered: result.visualEvidenceDelivered,
          transcript: result.transcript ? transcriptPayload(result.transcript) : null,
          text_sources: {
            transcript: result.textSources.transcript,
            platform_caption: { available: result.textSources.platformCaption.available, text: result.textSources.platformCaption.text, source: result.textSources.platformCaption.source, is_not_transcript: true },
            generated_caption: result.textSources.generatedCaption,
            on_screen_text: result.textSources.onScreenText,
          },
          audio_status: result.audioStatus,
          detected_scenes: result.detectedScenes,
          evidence: evidencePayload(result.evidence),
          analysis_context: {
            question: result.analysisContext.question,
            focus: result.analysisContext.focus,
            reaction_mode: result.analysisContext.reactionMode,
            what_can_be_answered: result.analysisContext.whatCanBeAnswered,
            what_cannot_be_answered: result.analysisContext.whatCannotBeAnswered,
            fact_check: result.analysisContext.factCheck,
            honesty_note: result.analysisContext.honestyNote,
            response_guidance: result.analysisContext.responseGuidance,
          },
          challenge: result.challenge,
          limitations: result.limitations,
          error: result.error,
          message: result.message,
          image_delivery_note:
            "MCP image content blocks precede this JSON in frame order: mcp_image_block_N is the (N+1)th image block. Those are the decoded frames — examine them before answering.",
        }) as Record<string, unknown>;
        if (!result.success) return errorResult(JSON.stringify(payload, null, 2));
        return images.length ? imageResult(images, payload) : safeTextResult(payload);
      }),
  );

  mcp.registerTool(
    "video_react",
    {
      title: "React to a Video (Grounded Evidence Package)",
      description:
        "Prepare genuine, inspectable video evidence so YOU can react to what actually happens — DEMO does not write the reaction. It resolves the link, decodes real frames from throughout the video (returned as MCP image content blocks), attaches a transcript when one exists, and adds style-specific guidance plus frame-grounded observations when a server-side vision model is configured. `reaction` is always null and `reaction_author` is always \"connected_model\": there are no canned reactions and nothing is derived from the caption alone. " +
        "Call this when the user says \"react to this\", \"what do you think\", \"look at this\", or sends a bare video link. Examine the returned frames first, then react in the requested style, anchoring claims to timestamps you can actually see. If visualEvidenceDelivered=false the retrieval failed: say so honestly and never pretend to have watched the video.",
      annotations: { title: "React to a Video (Grounded Evidence Package)", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().url().describe("Public video URL (TikTok/Instagram/X/Reddit/YouTube link, share/short link, public page or direct media file)."),
        style: z.enum(["casual", "funny", "serious", "detailed"]).default("casual").describe("Register for the connected model's reaction: casual (short, natural), funny (lean into what is actually amusing), serious (measured and factual), detailed (timeline walkthrough)."),
        question: z.string().max(2_000).optional().describe("Optional explicit question to answer alongside the reaction, e.g. \"Is this staged?\"."),
        max_frames: z.number().int().min(1).max(LIMITS.videoFramesMaxCount).optional().describe("Override the style's frame budget (still capped by the deployment limit)."),
        include_audio: z.boolean().default(false).describe("Also attempt audio capture + transcription so the reaction can reference what is said (when a provider is configured)."),
      },
    },
    (args) =>
      runTool(async () => {
        const result: VideoReactResult = await processor(ctx).react(args.url, {
          style: args.style as VideoReactStyle,
          question: args.question ?? null,
          maxFrames: args.max_frames ?? null,
          includeAudio: args.include_audio,
        });
        const images = result.frames
          .filter((frame) => frame.imageBlockIndex !== null && frame.inlineData)
          .sort((a, b) => (a.imageBlockIndex as number) - (b.imageBlockIndex as number))
          .map((frame) => ({ data: frame.inlineData as string, mimeType: frame.mimeType }));
        const payload = safeVideoValue({
          tool: "video_react",
          success: result.success,
          style: result.style,
          access_status: result.accessStatus,
          guidance: accessStatusGuidance(result.accessStatus),
          source_url: result.sourceUrl,
          canonical_url: result.canonicalUrl,
          platform: result.platform,
          duration_seconds: result.durationSeconds,
          caption: result.caption,
          caption_is_not_transcript: result.captionIsNotTranscript,
          frames: analyzeFramesPayload(result.frames),
          frames_delivered: result.framesDelivered,
          image_blocks_delivered: result.imageBlocksDelivered,
          visual_evidence_delivered: result.visualEvidenceDelivered,
          transcript: result.transcript ? transcriptPayload(result.transcript) : null,
          audio_status: result.audioStatus,
          evidence: evidencePayload(result.evidence),
          vision_summary: result.visionSummary
            ? { available: true, provider: result.visionSummary.provider, grounded_in_frames: result.visionSummary.groundedInFrames, observations: result.visionSummary.observations }
            : null,
          reaction: result.reaction,
          reaction_author: result.reactionAuthor,
          reaction_guidance: result.reactionGuidance,
          style_guidance: result.styleGuidance,
          honesty_note: result.honestyNote,
          challenge: result.challenge,
          limitations: result.limitations,
          error: result.error,
          message: result.message,
          image_delivery_note:
            "MCP image content blocks precede this JSON in frame order: mcp_image_block_N is the (N+1)th image block. They are the actual decoded frames — react from them, not from the caption.",
        }) as Record<string, unknown>;
        if (!result.success) return errorResult(JSON.stringify(payload, null, 2));
        return images.length ? imageResult(images, payload) : safeTextResult(payload);
      }),
  );

  mcp.registerTool(
    "video_get_frame",
    {
      title: "Get Public Video Frame",
      description: "Return one actual timestamped MCP image from a decoded public video or expiring video reference. It never returns a thumbnail in place of the requested video frame.",
      inputSchema: {
        ...inputFields,
        timestamp: z.number().min(0),
        inline: z.boolean().default(true),
      },
    },
    (args) =>
      runTool(async () => {
        const input = inputFrom(args);
        requireInput(input);
        const result = await processor(ctx).getFrame(input, args.timestamp);
        return frameToolResult(result, { requested_timestamp: args.timestamp });
      }),
  );

  mcp.registerTool(
    "video_inspect_pipeline",
    {
      title: "Inspect Video Pipeline",
      description:
        "Diagnostic for the public video pipeline. Runs each stage in order — URL validation, redirect resolution, media discovery, browser access, actual media retrieval (64 KiB ranged sample), frame extraction, R2 upload (round trip), artifact URL generation and MCP response serialization — and reports exactly where it succeeds or fails. Never returns credentials, cookies or page bodies.",
      inputSchema: {
        url: z.string().url().describe("The public video URL to diagnose."),
        include_download: z.boolean().default(true).describe("Sample the actual media URL with a bounded 64 KiB ranged GET."),
        include_frames: z.boolean().default(true).describe("Attempt Browser Run frame extraction."),
      },
    },
    (args) =>
      runTool(async () => {
        const report = await processor(ctx).inspectPipeline(args.url, { includeDownload: args.include_download, includeFrames: args.include_frames });
        return safeTextResult({
          tool: "video_inspect_pipeline",
          success: report.overall !== "failed",
          overall: report.overall,
          first_failure: report.firstFailure,
          stages: report.stages,
          message: report.message,
          note: "Stages identify the failing stage of the public video pipeline. No credentials, cookies or page bodies are included.",
        });
      }),
  );
}

export const VIDEO_TOOL_NAMES = [
  "inspect_video",
  "video_resolve",
  "video_fetch",
  "video_react",
  "video_inspect_url",
  "video_ingest",
  "video_download_public",
  "video_extract_frames",
  "video_extract_audio",
  "video_transcribe",
  "video_analyze",
  "video_get_frame",
  "video_inspect_pipeline",
] as const;
