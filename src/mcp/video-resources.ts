/**
 * MCP resources describing DEMO's video capabilities.
 *
 * A connected AI needs to know — before it promises a user anything — which
 * platforms DEMO can resolve, whether it can obtain the *actual video bytes*,
 * whether it can decode *frames*, whether it can *transcribe* audio, and which
 * optional providers are configured. Tools answer that per call; these
 * resources answer it up front, and `/health` + `demo_ping` expose the same
 * facts for non-MCP clients.
 *
 * Only provider *names and presence* are published. No key, token, account id
 * or binding value ever appears here.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { describeVideoCapabilities, videoCapabilityFlags, type VideoCapabilityReport } from "../video/capabilities.js";
import { LIMITS } from "../core/limits.js";
import type { VideoEnv } from "../video/types.js";

export const VIDEO_CAPABILITIES_URI = "demo://capabilities/video";
export const VIDEO_HONESTY_URI = "demo://video/honesty-contract";

export interface VideoResourceContext {
  env: VideoEnv & Record<string, unknown>;
  requestUrl?: string | null;
}

/** Read the live browser/storage bindings so the report is never aspirational. */
function reportFor(ctx: VideoResourceContext, capabilitiesFor: (env: unknown, requestUrl: string | null) => { browserAvailable: boolean; provider: string; videoFrames: boolean; reason?: string | null; screenshots?: boolean }): VideoCapabilityReport {
  const browser = capabilitiesFor(ctx.env, ctx.requestUrl ?? null);
  return describeVideoCapabilities(ctx.env, browser);
}

export function registerVideoResources(
  mcp: McpServer,
  ctx: VideoResourceContext,
  capabilitiesFor: (env: unknown, requestUrl: string | null) => { browserAvailable: boolean; provider: string; videoFrames: boolean; reason?: string | null; screenshots?: boolean },
): void {
  mcp.registerResource(
    "video_capabilities",
    VIDEO_CAPABILITIES_URI,
    {
      title: "DEMO Video Capabilities",
      description:
        "Live capability report for DEMO's public video pipeline: supported platforms, whether actual video bytes can be retrieved, whether frames can be decoded, whether audio/transcription is available, which providers are configured (names only), the enforced limits and the security policy. Read this before promising a user that DEMO can watch a video.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(reportFor(ctx, capabilitiesFor), null, 2),
        },
      ],
    }),
  );

  mcp.registerResource(
    "video_honesty_contract",
    VIDEO_HONESTY_URI,
    {
      title: "DEMO Video Honesty Contract",
      description:
        "The rules DEMO and the connected model must follow so nobody claims to have watched a video they did not: what counts as visual evidence, how access_status maps to what may be said, and the difference between a transcript, a creator's caption and generated text.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              schema: "demo.video-honesty-contract/1",
              rule: "The connected model may describe a video's content ONLY when a tool returned visualEvidenceDelivered=true (real decoded frame image blocks) or an actual transcript. Metadata, a thumbnail, a caption, a stream URL or a successful download are NOT evidence of content.",
              evidenceHierarchy: [
                { level: 1, evidence: "Decoded frame image blocks (video_analyze, video_react, inspect_video, video_extract_frames)", mayDescribeContent: true },
                { level: 2, evidence: "Speech-to-text transcript from a configured provider (video_transcribe)", mayDescribeContent: "only what was said" },
                { level: 3, evidence: "Verified video bytes stored in R2 (video_fetch)", mayDescribeContent: false, note: "Proves retrieval, not understanding. Extract frames next." },
                { level: 4, evidence: "Resolution metadata, canonical URL, creator, duration, dimensions (video_resolve)", mayDescribeContent: false },
                { level: 5, evidence: "Post caption / OpenGraph description", mayDescribeContent: false, note: "Written by the creator. Never a transcript and never proof of what the video shows." },
                { level: 6, evidence: "Thumbnail or cover image", mayDescribeContent: false, note: "DEMO never returns a thumbnail inside `frames`." },
              ],
              accessStatusMeaning: {
                public: "A normal public request reached playable media.",
                deleted: "The item was removed. Say so; describe nothing.",
                private: "Only the creator/approved followers can view it. Say so; describe nothing.",
                login_required: "An authenticated session is needed and DEMO never uses one. Say so.",
                region_restricted: "Not available to this requester's region. Say so.",
                challenge_required: "A CAPTCHA/bot check or access denial blocked retrieval and is never bypassed. Say so.",
                rate_limited: "The platform throttled the request. Suggest retrying later.",
                not_found: "No such item exists at that URL.",
                expired: "A signed media URL or temporary artifact passed its expiry. Re-resolve the original link.",
                blocked_url: "Rejected by the SSRF guard before any request (private/internal/unsafe target).",
                unsupported: "Reachable but not a supported decodable video (manifest, audio-only, still image).",
                unavailable: "The page was reachable but exposed no playable public media.",
                unknown: "Not enough signal. Never presented as success.",
              },
              textSourceRules: {
                transcript: "Real speech-to-text from a configured provider. Marked kind=speech_to_text, is_transcript=true.",
                platform_caption: "The creator's post caption. Marked caption_is_not_transcript=true. Never quote it as speech.",
                generated_caption: "DEMO generates no caption text. Always reported as unavailable.",
                on_screen_text: "Only present when a vision model actually read decoded frames.",
              },
              never: [
                "Claim to have watched, seen or played the video without decoded frames or a transcript.",
                "Claim continuous playback: frames are samples.",
                "Invent dialogue, sound effects, music or events outside the evidence.",
                "Substitute a thumbnail, caption or metadata for video content.",
                "Bypass a CAPTCHA, login wall, DRM, paywall or private-account control.",
              ],
              limits: {
                maxFrames: LIMITS.videoFramesMaxCount,
                maxDownloadMb: LIMITS.videoMaxDownloadMb,
                maxDurationSeconds: LIMITS.videoMaxDurationSeconds,
                inlineImageBytes: LIMITS.inlineImageMaxBytes,
                artifactTtlSeconds: LIMITS.videoArtifactTtlSeconds,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}

/** Compact flags for `demo_ping`, `/`, `/health` and platform telemetry. */
export function videoStatusFlags(ctx: VideoResourceContext, capabilitiesFor: (env: unknown, requestUrl: string | null) => { browserAvailable: boolean; provider: string; videoFrames: boolean; reason?: string | null; screenshots?: boolean }) {
  return videoCapabilityFlags(reportFor(ctx, capabilitiesFor));
}
