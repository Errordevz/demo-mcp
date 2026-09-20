/**
 * MCP surface for public YouTube Data API operations.
 *
 * Four read-only tools:
 *  - `youtube_search`  — search public videos, channels, playlists
 *  - `youtube_video`   — public video metadata by URL or ID
 *  - `youtube_channel` — public channel metadata by ID, handle or URL
 *  - `youtube_playlist` — public playlist metadata + optional items
 *
 * Integration with the existing video pipeline:
 *  When `youtube_video` is given a YouTube URL, the tool retrieves public
 *  metadata via the Data API. If the video's access status indicates actual
 *  media is retrievable (public, embeddable), the tool reports that the
 *  existing video pipeline (inspect_video / video_resolve) can be used for
 *  frame extraction, audio, transcription and vision analysis.
 *
 * Metadata retrieval is NOT equivalent to watching the video. The tool
 * clearly distinguishes metadata_only from actual media availability.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { errorResult, textResult, type ToolResult } from "./results.js";
import { redactValue, safeLog } from "../core/redact.js";
import { resolveYouTubeConfig, type YouTubeConfig, type YouTubeEnv } from "../youtube/config.js";
import {
  searchYouTube,
  getYouTubeVideo,
  getYouTubeChannel,
  getYouTubeChannelByHandle,
  getYouTubePlaylist,
  getYouTubePlaylistItems,
  parseYouTubeUrl,
  isYouTubeVideoId,
  isYouTubeChannelId,
  isYouTubePlaylistId,
  formatVideoMetadata,
  formatChannelMetadata,
  formatPlaylistMetadata,
  formatSearchResult,
} from "../youtube/client.js";
import { describeYouTubeCapabilities, YOUTUBE_CAPABILITIES_URI } from "../youtube/capabilities.js";

export const YOUTUBE_TOOL_NAMES = ["youtube_search", "youtube_video", "youtube_channel", "youtube_playlist"] as const;
export type YouTubeToolName = (typeof YOUTUBE_TOOL_NAMES)[number];

export interface YouTubeToolContext {
  env: Record<string, unknown> & YouTubeEnv;
  requestUrl?: string | null;
}

function guardYouTube(ctx: YouTubeToolContext): { config: YouTubeConfig; apiKey: string } | ToolResult {
  const config = resolveYouTubeConfig(ctx.env);
  if (!config.available) {
    return errorResult(
      JSON.stringify(
        {
          error: "capability_unavailable",
          message: "YouTube tools are not available on this deployment.",
          hint: config.disabledReason ?? "Set the YOUTUBE_API_KEY secret on this Worker to enable YouTube operations.",
          retryable: false,
        },
        null,
        2,
      ),
    );
  }
  const apiKey = String(ctx.env.YOUTUBE_API_KEY ?? "").trim();
  return { config, apiKey };
}

async function run(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(redactValue(await work()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code ?? "internal";
    safeLog("warn", "youtube-tool-error", { code, message }, "youtube");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: code,
              message,
              ...((error as { hint?: string })?.hint ? { hint: (error as { hint: string }).hint } : {}),
              retryable: Boolean((error as { retryable?: boolean })?.retryable),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}

/**
 * Determine whether the existing video pipeline can process this YouTube video.
 * Returns a structured status object indicating what level of access is available.
 */
function videoPipelineStatus(video: Record<string, unknown>): {
  pipeline_available: boolean;
  access_status: string;
  metadata_level: string;
  can_inspect_video: boolean;
  note: string;
} {
  const privacy = video.privacy_status as string | null;
  const embeddable = video.embeddable as boolean | null;

  // Public and embeddable → full pipeline available
  if (privacy === "public" && embeddable === true) {
    return {
      pipeline_available: true,
      access_status: "public",
      metadata_level: "full_metadata",
      can_inspect_video: true,
      note: "This video is public and embeddable. Use inspect_video or video_resolve to attempt actual media retrieval, frame extraction, and analysis through the existing video pipeline.",
    };
  }
  // Public but not embeddable → pipeline may still work through direct page parsing
  if (privacy === "public") {
    return {
      pipeline_available: true,
      access_status: "public_limited",
      metadata_level: "full_metadata",
      can_inspect_video: true,
      note: "This video is public but may have embedding restrictions. The existing video pipeline can attempt retrieval through page parsing, though some renditions may be unavailable.",
    };
  }
  // Private or other restricted status → metadata only
  return {
    pipeline_available: false,
    access_status: privacy ?? "unavailable",
    metadata_level: "metadata_only",
    can_inspect_video: false,
    note: `This video's privacy status is '${privacy ?? "unknown"}'. Only public metadata is available. The video pipeline cannot retrieve actual media for non-public videos.`,
  };
}

export function registerYouTubeTools(mcp: McpServer, ctx: YouTubeToolContext): void {
  mcp.registerTool(
    "youtube_search",
    {
      title: "Search Public YouTube",
      description:
        "Search public YouTube videos, channels, or playlists using the YouTube Data API v3. Returns public metadata (titles, descriptions, thumbnails, channel names). Does not retrieve actual video content — use inspect_video for that. Requires YOUTUBE_API_KEY secret.",
      annotations: {
        title: "Search Public YouTube",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        query: z.string().min(1).max(500).describe("The search query."),
        type: z.enum(["video", "channel", "playlist"]).default("video").describe("What kind of resource to search for."),
        max_results: z.number().int().min(1).max(50).default(10).describe("Maximum number of results (1-50)."),
        page_token: z.string().optional().describe("Pagination token from a previous search response."),
      },
    },
    async ({ query, type, max_results, page_token }) => {
      const guard = guardYouTube(ctx);
      if ("content" in guard) return guard;
      return run(async () => {
        const result = await searchYouTube(guard.config, guard.apiKey, {
          query,
          type,
          maxResults: max_results,
          pageToken: page_token,
        });
        return {
          tool: "youtube_search",
          success: true,
          query,
          type,
          results: (result.items ?? []).map(formatSearchResult),
          total_results: result.pageInfo?.totalResults ?? null,
          results_per_page: result.pageInfo?.resultsPerPage ?? null,
          next_page_token: result.nextPageToken ?? null,
          prev_page_token: result.prevPageToken ?? null,
          source: "youtube_data_api_v3",
          note: "This is public search metadata. To retrieve actual video content, use inspect_video with the video URL.",
        };
      });
    },
  );

  mcp.registerTool(
    "youtube_video",
    {
      title: "Get YouTube Video Info",
      description:
        "Retrieve public metadata for a YouTube video by URL or video ID. Returns title, description, channel, duration, thumbnails, statistics, and access status. Also reports whether the existing video pipeline (inspect_video) can retrieve actual frames/audio from this video. Requires YOUTUBE_API_KEY secret. " +
        "Supported URL forms: youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…, youtube.com/embed/…",
      annotations: {
        title: "Get YouTube Video Info",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url_or_id: z.string().min(1).describe("A YouTube video URL or video ID."),
      },
    },
    async ({ url_or_id }) => {
      const guard = guardYouTube(ctx);
      if ("content" in guard) return guard;
      return run(async () => {
        // Parse the input to extract a video ID
        let videoId: string | null = null;
        const parsed = parseYouTubeUrl(url_or_id);
        if (parsed && parsed.kind === "video") {
          videoId = parsed.id;
        } else if (isYouTubeVideoId(url_or_id)) {
          videoId = url_or_id;
        } else {
          return {
            tool: "youtube_video",
            success: false,
            error: "invalid_input",
            message: "Could not extract a YouTube video ID from the provided input.",
            hint: "Provide a YouTube URL (youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…, youtube.com/embed/…) or a video ID.",
          };
        }

        const result = await getYouTubeVideo(guard.config, guard.apiKey, videoId);
        if (!result.items || result.items.length === 0) {
          return {
            tool: "youtube_video",
            success: false,
            error: "not_found",
            message: `No YouTube video found for ID: ${videoId}`,
            hint: "The video may be deleted, private, or the ID may be incorrect.",
          };
        }

        const video = formatVideoMetadata(result.items[0]);
        const pipeline = videoPipelineStatus(video);

        return {
          tool: "youtube_video",
          success: true,
          ...video,
          pipeline_status: pipeline,
          source: "youtube_data_api_v3",
          metadata_note: "This is public metadata from the YouTube Data API. Metadata retrieval is NOT equivalent to watching the video. Use inspect_video to attempt actual frame/audio retrieval through the existing video pipeline.",
        };
      });
    },
  );

  mcp.registerTool(
    "youtube_channel",
    {
      title: "Get YouTube Channel Info",
      description:
        "Retrieve public metadata for a YouTube channel by channel ID, @handle, or channel URL. Returns title, description, statistics, thumbnails. Requires YOUTUBE_API_KEY secret.",
      annotations: {
        title: "Get YouTube Channel Info",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url_or_id: z.string().min(1).describe("A YouTube channel URL, @handle, or channel ID."),
      },
    },
    async ({ url_or_id }) => {
      const guard = guardYouTube(ctx);
      if ("content" in guard) return guard;
      return run(async () => {
        // Parse the input to extract a channel ID or handle
        const parsed = parseYouTubeUrl(url_or_id);
        let channelId: string | null = null;
        let handle: string | null = null;

        if (parsed && parsed.kind === "channel") {
          channelId = parsed.id;
        } else if (isYouTubeChannelId(url_or_id)) {
          channelId = url_or_id;
        } else if (url_or_id.startsWith("@")) {
          handle = url_or_id;
        } else if (url_or_id.includes("/@")) {
          const match = /\/@([A-Za-z0-9_.-]+)/.exec(url_or_id);
          if (match) handle = `@${match[1]}`;
        }

        if (!channelId && !handle) {
          return {
            tool: "youtube_channel",
            success: false,
            error: "invalid_input",
            message: "Could not extract a YouTube channel ID or handle from the provided input.",
            hint: "Provide a channel ID (UC...), a @handle (e.g. @MrBeast), or a channel URL (youtube.com/channel/UC... or youtube.com/@handle).",
          };
        }

        const result = channelId
          ? await getYouTubeChannel(guard.config, guard.apiKey, channelId)
          : await getYouTubeChannelByHandle(guard.config, guard.apiKey, handle!);

        if (!result.items || result.items.length === 0) {
          return {
            tool: "youtube_channel",
            success: false,
            error: "not_found",
            message: `No YouTube channel found for: ${channelId ?? handle}`,
            hint: "The channel may not exist, or the handle/ID may be incorrect.",
          };
        }

        return {
          tool: "youtube_channel",
          success: true,
          ...formatChannelMetadata(result.items[0]),
          source: "youtube_data_api_v3",
        };
      });
    },
  );

  mcp.registerTool(
    "youtube_playlist",
    {
      title: "Get YouTube Playlist Info",
      description:
        "Retrieve public metadata for a YouTube playlist by playlist ID or URL. Optionally includes playlist items. Requires YOUTUBE_API_KEY secret.",
      annotations: {
        title: "Get YouTube Playlist Info",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url_or_id: z.string().min(1).describe("A YouTube playlist URL or playlist ID."),
        include_items: z.boolean().default(false).describe("Whether to include playlist items (videos) in the response."),
        max_items: z.number().int().min(1).max(50).default(25).describe("Maximum number of playlist items to include (1-50)."),
      },
    },
    async ({ url_or_id, include_items, max_items }) => {
      const guard = guardYouTube(ctx);
      if ("content" in guard) return guard;
      return run(async () => {
        const parsed = parseYouTubeUrl(url_or_id);
        let playlistId: string | null = null;

        if (parsed && parsed.kind === "playlist") {
          playlistId = parsed.id;
        } else if (isYouTubePlaylistId(url_or_id)) {
          playlistId = url_or_id;
        } else {
          // Try to extract list= from URL
          try {
            const url = new URL(url_or_id);
            const list = url.searchParams.get("list");
            if (list && isYouTubePlaylistId(list)) playlistId = list;
          } catch { /* not a URL */ }
        }

        if (!playlistId) {
          return {
            tool: "youtube_playlist",
            success: false,
            error: "invalid_input",
            message: "Could not extract a YouTube playlist ID from the provided input.",
            hint: "Provide a playlist URL (youtube.com/playlist?list=…) or a playlist ID (PL…, UU…, LL…, FL…, RD…, OL…).",
          };
        }

        const result = await getYouTubePlaylist(guard.config, guard.apiKey, playlistId);
        if (!result.items || result.items.length === 0) {
          return {
            tool: "youtube_playlist",
            success: false,
            error: "not_found",
            message: `No YouTube playlist found for ID: ${playlistId}`,
            hint: "The playlist may be private, deleted, or the ID may be incorrect.",
          };
        }

        const playlist = formatPlaylistMetadata(result.items[0]);

        let items: Record<string, unknown>[] | null = null;
        if (include_items) {
          const itemsResult = await getYouTubePlaylistItems(guard.config, guard.apiKey, playlistId, { maxResults: max_items });
          items = (itemsResult.items ?? []).map((item) => {
            const snippet = item.snippet;
            // Playlist items use a different structure for video ID
            const contentDetails = (item as unknown as { contentDetails?: { videoId?: string } }).contentDetails;
            return {
              type: item.id?.kind === "youtube#video" ? "video" : "unknown",
              id: contentDetails?.videoId ?? item.id?.videoId ?? null,
              title: snippet?.title ?? null,
              description: snippet?.description ?? null,
              channel: snippet?.channelTitle ?? null,
              published_at: snippet?.publishedAt ?? null,
              thumbnails: snippet?.thumbnails ?? null,
            };
          });
        }

        return {
          tool: "youtube_playlist",
          success: true,
          ...playlist,
          ...(items ? { items, items_returned: items.length } : {}),
          source: "youtube_data_api_v3",
        };
      });
    },
  );

  // Register the capabilities resource
  mcp.registerResource(
    "youtube_capabilities",
    YOUTUBE_CAPABILITIES_URI,
    {
      title: "DEMO YouTube Capabilities",
      description:
        "Whether this deployment can query the YouTube Data API v3 for public metadata (search, video, channel, playlist), what tools are available, and how YouTube integrates with the existing video pipeline. Configuration presence only — no credential value.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(describeYouTubeCapabilities(ctx.env), null, 2) }],
    }),
  );
}

/**
 * Shared capability report for the MCP resource, `/capabilities/youtube` and
 * the inspector surfaces. Synchronous and credential-free by construction.
 */
export function youTubeCapabilitiesReport(env: Record<string, unknown> | undefined) {
  return describeYouTubeCapabilities(env);
}

export { YOUTUBE_CAPABILITIES_URI };
