/**
 * YouTube Data API v3 HTTP client.
 *
 * This is the only place in the repository that holds a YouTube API key: it is
 * read from the Worker secret at call time, placed in exactly one query
 * parameter, and never written into a URL that is returned to a caller, a log
 * line, an error message or a tool result. The key is deliberately *not*
 * stored on the config object.
 *
 * All requests are read-only public operations. No OAuth, no account linking.
 */

import { BrowserError } from "../core/errors.js";
import { redactText } from "../core/redact.js";
import {
  YOUTUBE_API_ORIGIN,
  YOUTUBE_VIDEOS_PATH,
  YOUTUBE_SEARCH_PATH,
  YOUTUBE_CHANNELS_PATH,
  YOUTUBE_PLAYLISTS_PATH,
  YOUTUBE_PLAYLIST_ITEMS_PATH,
  type YouTubeConfig,
} from "./config.js";
import type {
  YouTubeApiResponse,
  YouTubeVideoItem,
  YouTubeChannelItem,
  YouTubePlaylistItem,
  YouTubeSearchResult,
  YouTubeUrlParse,
} from "./types.js";

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

export interface YouTubeApiOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 2_000;

/**
 * Parse ISO 8601 duration (YouTube's format) to seconds.
 * Examples: PT4M13S → 253, PT1H2M3S → 3723, PT30S → 30
 */
export function parseIsoDuration(duration: string | undefined): number | null {
  if (!duration) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match) return null;
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse a YouTube URL and extract the video/channel/playlist ID.
 *
 * Supported forms:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://www.youtube.com/shorts/VIDEO_ID
 *   https://www.youtube.com/embed/VIDEO_ID
 *   https://www.youtube.com/channel/CHANNEL_ID
 *   https://www.youtube.com/@handle (not resolvable to an ID without API lookup)
 *   https://www.youtube.com/playlist?list=PLAYLIST_ID
 *   https://www.youtube.com/c/CUSTOM_NAME (not resolvable without API lookup)
 *   https://www.youtube.com/user/USERNAME (not resolvable without API lookup)
 */
export function parseYouTubeUrl(input: string): YouTubeUrlParse | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const isYouTube = host === "youtube.com" || host === "www.youtube.com" || host === "youtu.be" || host === "m.youtube.com";
  if (!isYouTube) return null;

  const path = url.pathname;

  // youtu.be/VIDEO_ID
  if (host === "youtu.be") {
    const videoId = path.slice(1).split("/")[0];
    if (videoId && /^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
      return { kind: "video", id: videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
    }
    return null;
  }

  // /watch?v=VIDEO_ID
  const watchId = url.searchParams.get("v");
  if (path.startsWith("/watch") && watchId && /^[A-Za-z0-9_-]{6,}$/.test(watchId)) {
    return { kind: "video", id: watchId, canonicalUrl: `https://www.youtube.com/watch?v=${watchId}` };
  }

  // /shorts/VIDEO_ID
  const shortsMatch = /^\/shorts\/([A-Za-z0-9_-]{6,})/.exec(path);
  if (shortsMatch) {
    return { kind: "video", id: shortsMatch[1], canonicalUrl: `https://www.youtube.com/watch?v=${shortsMatch[1]}` };
  }

  // /embed/VIDEO_ID
  const embedMatch = /^\/embed\/([A-Za-z0-9_-]{6,})/.exec(path);
  if (embedMatch) {
    return { kind: "video", id: embedMatch[1], canonicalUrl: `https://www.youtube.com/watch?v=${embedMatch[1]}` };
  }

  // /channel/CHANNEL_ID
  const channelMatch = /^\/channel\/([A-Za-z0-9_-]{20,})/.exec(path);
  if (channelMatch) {
    return { kind: "channel", id: channelMatch[1], canonicalUrl: `https://www.youtube.com/channel/${channelMatch[1]}` };
  }

  // /playlist?list=PLAYLIST_ID
  if (path.startsWith("/playlist")) {
    const listId = url.searchParams.get("list");
    if (listId && /^[A-Za-z0-9_-]{10,}$/.test(listId)) {
      return { kind: "playlist", id: listId, canonicalUrl: `https://www.youtube.com/playlist?list=${listId}` };
    }
  }

  // /@handle — requires API lookup, not directly resolvable
  // /c/CUSTOM_NAME — requires API lookup
  // /user/USERNAME — requires API lookup
  // These return null because they need a separate forHandle lookup.

  return null;
}

/** Check whether a string looks like a YouTube video ID. */
export function isYouTubeVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{6,}$/.test(value);
}

/** Check whether a string looks like a YouTube channel ID. */
export function isYouTubeChannelId(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,}$/.test(value);
}

/** Check whether a string looks like a YouTube playlist ID. */
export function isYouTubePlaylistId(value: string): boolean {
  return /^(PL|UU|LL|FL|RD|OL)[A-Za-z0-9_-]{8,}$/.test(value);
}

async function apiRequest<T>(
  config: YouTubeConfig,
  apiKey: string,
  path: string,
  params: Record<string, string>,
  options: YouTubeApiOptions = {},
): Promise<T> {
  if (!config.available) {
    throw new BrowserError("capability_unavailable", "YouTube API is not available.", {
      hint: config.disabledReason ?? "Set the YOUTUBE_API_KEY secret on this Worker.",
    });
  }

  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const url = new URL(`${YOUTUBE_API_ORIGIN}${path}`);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new BrowserError("internal", "No fetch implementation available.");

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let errorBody: Record<string, unknown> = {};
      try {
        errorBody = JSON.parse(text);
      } catch { /* not JSON */ }

      const apiError = (errorBody.error as Record<string, unknown>) ?? {};
      const status = response.status;

      if (status === 403) {
        const reason = ((apiError.errors as Array<Record<string, unknown>>)?.[0]?.reason as string) ?? "";
        if (reason === "quotaExceeded") {
          throw new BrowserError("rate_limited", "YouTube API quota exceeded.", {
            hint: "The daily YouTube API quota has been reached. Retry tomorrow or request a higher quota.",
            retryable: true,
          });
        }
        throw new BrowserError("capability_unavailable", "YouTube API access denied.", {
          hint: "The YouTube API key may lack permission for this operation.",
        });
      }
      if (status === 404) {
        throw new BrowserError("VIDEO_NOT_FOUND", "YouTube resource not found.", { retryable: false });
      }
      if (status === 400) {
        throw new BrowserError("invalid_input", `YouTube API rejected the request: ${(apiError.message as string) ?? "bad request"}.`, { retryable: false });
      }
      if (status >= 500 || status === 429) {
        throw new BrowserError("rate_limited", `YouTube API returned ${status}.`, { retryable: true });
      }
      throw new BrowserError("internal", `YouTube API error (${status}): ${redactText(String(apiError.message ?? text), 500)}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    if ((error as Error)?.name === "AbortError") {
      throw new BrowserError("timeout", "YouTube API request timed out.", { retryable: true });
    }
    throw new BrowserError("internal", `YouTube API request failed: ${(error as Error).message ?? String(error)}`, { retryable: false });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function searchYouTube(
  config: YouTubeConfig,
  apiKey: string,
  input: { query: string; type?: "video" | "channel" | "playlist"; maxResults?: number; pageToken?: string },
  options?: YouTubeApiOptions,
): Promise<YouTubeApiResponse<YouTubeSearchResult>> {
  const params: Record<string, string> = {
    part: "snippet",
    q: input.query,
    type: input.type ?? "video",
    maxResults: String(Math.min(Math.max(input.maxResults ?? 10, 1), 50)),
  };
  if (input.pageToken) params.pageToken = input.pageToken;
  return apiRequest(config, apiKey, YOUTUBE_SEARCH_PATH, params, options);
}

export async function getYouTubeVideo(
  config: YouTubeConfig,
  apiKey: string,
  videoId: string,
  options?: YouTubeApiOptions,
): Promise<YouTubeApiResponse<YouTubeVideoItem>> {
  return apiRequest(config, apiKey, YOUTUBE_VIDEOS_PATH, {
    part: "snippet,contentDetails,statistics,status",
    id: videoId,
  }, options);
}

export async function getYouTubeChannel(
  config: YouTubeConfig,
  apiKey: string,
  channelId: string,
  options?: YouTubeApiOptions,
): Promise<YouTubeApiResponse<YouTubeChannelItem>> {
  return apiRequest(config, apiKey, YOUTUBE_CHANNELS_PATH, {
    part: "snippet,statistics,contentDetails",
    id: channelId,
  }, options);
}

export async function getYouTubeChannelByHandle(
  config: YouTubeConfig,
  apiKey: string,
  handle: string,
  options?: YouTubeApiOptions,
): Promise<YouTubeApiResponse<YouTubeChannelItem>> {
  return apiRequest(config, apiKey, YOUTUBE_CHANNELS_PATH, {
    part: "snippet,statistics,contentDetails",
    forHandle: handle.startsWith("@") ? handle : `@${handle}`,
  }, options);
}

export async function getYouTubePlaylist(
  config: YouTubeConfig,
  apiKey: string,
  playlistId: string,
  options?: YouTubeApiOptions,
): Promise<YouTubeApiResponse<YouTubePlaylistItem>> {
  return apiRequest(config, apiKey, YOUTUBE_PLAYLISTS_PATH, {
    part: "snippet,contentDetails",
    id: playlistId,
  }, options);
}

export async function getYouTubePlaylistItems(
  config: YouTubeConfig,
  apiKey: string,
  playlistId: string,
  input?: { maxResults?: number; pageToken?: string },
  options?: YouTubeApiOptions,
): Promise<YouTubeApiResponse<YouTubeSearchResult>> {
  const params: Record<string, string> = {
    part: "snippet,contentDetails",
    playlistId,
    maxResults: String(Math.min(Math.max(input?.maxResults ?? 25, 1), 50)),
  };
  if (input?.pageToken) params.pageToken = input.pageToken;
  return apiRequest(config, apiKey, YOUTUBE_PLAYLIST_ITEMS_PATH, params, options);
}

/**
 * Format a YouTube video item into a clean public metadata object.
 * Redacts nothing (no secrets in YouTube public data), but normalizes shapes.
 */
export function formatVideoMetadata(item: YouTubeVideoItem): Record<string, unknown> {
  const snippet = item.snippet;
  const contentDetails = item.contentDetails;
  const statistics = item.statistics;
  const status = item.status;

  return {
    video_id: item.id,
    title: snippet?.title ?? null,
    description: snippet?.description ?? null,
    channel: snippet?.channelTitle ?? null,
    channel_id: snippet?.channelId ?? null,
    published_at: snippet?.publishedAt ?? null,
    duration_seconds: contentDetails?.duration ? parseIsoDuration(contentDetails.duration) : null,
    duration_iso: contentDetails?.duration ?? null,
    thumbnails: snippet?.thumbnails ?? null,
    category_id: snippet?.categoryId ?? null,
    tags: snippet?.tags ?? null,
    live_broadcast_content: snippet?.liveBroadcastContent ?? null,
    view_count: statistics?.viewCount ? parseInt(statistics.viewCount, 10) : null,
    like_count: statistics?.likeCount ? parseInt(statistics.likeCount, 10) : null,
    comment_count: statistics?.commentCount ? parseInt(statistics.commentCount, 10) : null,
    privacy_status: status?.privacyStatus ?? null,
    embeddable: status?.embeddable ?? null,
    definition: contentDetails?.definition ?? null,
    caption_available: (contentDetails?.caption) === "true",
    canonical_url: `https://www.youtube.com/watch?v=${item.id}`,
  };
}

export function formatChannelMetadata(item: YouTubeChannelItem): Record<string, unknown> {
  const snippet = item.snippet;
  const statistics = item.statistics;
  const contentDetails = item.contentDetails;

  return {
    channel_id: item.id,
    title: snippet?.title ?? null,
    description: snippet?.description ?? null,
    custom_url: snippet?.customUrl ?? null,
    published_at: snippet?.publishedAt ?? null,
    thumbnails: snippet?.thumbnails ?? null,
    subscriber_count: statistics?.subscriberCount ? parseInt(statistics.subscriberCount, 10) : null,
    view_count: statistics?.viewCount ? parseInt(statistics.viewCount, 10) : null,
    video_count: statistics?.videoCount ? parseInt(statistics.videoCount, 10) : null,
    hidden_subscriber_count: statistics?.hiddenSubscriberCount ?? false,
    uploads_playlist_id: contentDetails?.relatedPlaylists?.uploads ?? null,
    likes_playlist_id: contentDetails?.relatedPlaylists?.likes ?? null,
    canonical_url: `https://www.youtube.com/channel/${item.id}`,
  };
}

export function formatPlaylistMetadata(item: YouTubePlaylistItem): Record<string, unknown> {
  const snippet = item.snippet;
  const contentDetails = item.contentDetails;

  return {
    playlist_id: item.id,
    title: snippet?.title ?? null,
    description: snippet?.description ?? null,
    channel: snippet?.channelTitle ?? null,
    channel_id: snippet?.channelId ?? null,
    published_at: snippet?.publishedAt ?? null,
    thumbnails: snippet?.thumbnails ?? null,
    item_count: contentDetails?.itemCount ?? null,
    canonical_url: `https://www.youtube.com/playlist?list=${item.id}`,
  };
}

export function formatSearchResult(item: YouTubeSearchResult): Record<string, unknown> {
  const snippet = item.snippet ?? {};
  const idKind = item.id?.kind ?? "";

  let resourceType = "unknown";
  let resourceId: string | null = null;
  if (idKind === "youtube#video") { resourceType = "video"; resourceId = item.id.videoId ?? null; }
  else if (idKind === "youtube#channel") { resourceType = "channel"; resourceId = item.id.channelId ?? null; }
  else if (idKind === "youtube#playlist") { resourceType = "playlist"; resourceId = item.id.playlistId ?? null; }

  return {
    type: resourceType,
    id: resourceId,
    title: snippet.title ?? null,
    description: snippet.description ?? null,
    channel: snippet.channelTitle ?? null,
    channel_id: snippet.channelId ?? null,
    published_at: snippet.publishedAt ?? null,
    thumbnails: snippet.thumbnails ?? null,
    live_broadcast_content: snippet.liveBroadcastContent ?? null,
  };
}
