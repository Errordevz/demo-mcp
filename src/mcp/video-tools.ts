import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { errorResult, imageResult, runTool, textResult as rawTextResult, type ToolResult } from "./results.js";
import { redactText } from "../core/redact.js";
import { LIMITS } from "../core/limits.js";
import { BrowserError } from "../core/errors.js";
import { VideoProcessor, type FrameCaptureResult } from "../video/processor.js";
import type { VideoEnv, VideoFrameOutput, VideoInput, VideoTranscript } from "../video/types.js";

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
  };
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
        "Decode a public non-DRM video in Cloudflare Browser Run and return timestamped actual image content blocks plus expiring R2 references. A URL or video_reference is required.",
      inputSchema: {
        ...inputFields,
        timestamps: z.array(z.number().min(0)).max(LIMITS.videoFramesMaxCount).optional(),
        frame_interval: z.number().min(0.5).max(120).optional().default(LIMITS.videoFramesDefaultIntervalSeconds),
        max_frame_count: z.number().int().min(1).max(LIMITS.videoFramesMaxCount).default(LIMITS.videoFramesMaxCount),
        inline: z.boolean().default(true).describe("Include MCP image blocks when each frame is within the inline size cap."),
      },
    },
    (args) =>
      runTool(async () => {
        const input = inputFrom(args);
        requireInput(input);
        const result = await processor(ctx).extractFrames(input, { timestamps: args.timestamps, frameInterval: args.frame_interval, maxFrameCount: args.max_frame_count, inline: args.inline });
        return frameToolResult(result, { video_reference: args.video_reference ?? null });
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
        "Produce timestamped speech-to-text for an expiring audio/video reference or public URL when a server-side Cloudflare AI or configured transcription provider is available. Empty speech returns no_speech_detected.",
      inputSchema: {
        url: z.string().url().optional(),
        video_reference: z.string().optional(),
        audio_reference: z.string().optional(),
        language: z.string().min(2).max(20).optional(),
      },
    },
    (args) =>
      runTool(async () => {
        const input = inputFrom(args);
        requireInput(input);
        const transcript = await processor(ctx).transcribe(input, { language: args.language });
        const payload = { success: transcript.status !== "unavailable", transcript: transcriptPayload(transcript) };
        if (transcript.status === "unavailable") return structuredVideoError("TRANSCRIPTION_UNAVAILABLE", transcript.message ?? "Speech-to-text is not available.", payload);
        return safeTextResult(payload);
      }),
  );

  mcp.registerTool(
    "video_analyze",
    {
      title: "Analyze Public Video",
      description:
        "Return a compact frame-grounded video analysis. Scene changes, OCR, people/objects and actions are populated only when actual frames were decoded and an optional server-side vision provider returned results; otherwise the response says what is unavailable.",
      inputSchema: {
        ...inputFields,
        frame_references: z.array(z.string()).max(LIMITS.videoFramesMaxCount).optional().describe("Previously returned frame references; references alone are not treated as visual evidence unless the Worker can retrieve them."),
        include_transcript: z.boolean().default(true),
      },
    },
    (args) =>
      runTool(async () => {
        const input = inputFrom(args);
        if (!input.url && !input.videoReference && !args.frame_references?.length) throw new BrowserError("invalid_input", "Provide url, video_reference, or frame_references.");
        return safeTextResult(await processor(ctx).analyze(input, { frameReferences: args.frame_references, includeTranscript: args.include_transcript }));
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
