/**
 * Types for YouTube Data API v3 responses.
 *
 * Only public metadata types are defined here — no private/account-specific
 * types, because this integration is public YouTube only.
 */

export interface YouTubeThumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface YouTubeThumbnails {
  default?: YouTubeThumbnail;
  medium?: YouTubeThumbnail;
  high?: YouTubeThumbnail;
  standard?: YouTubeThumbnail;
  maxres?: YouTubeThumbnail;
}

export interface YouTubeChannelSnippet {
  title: string;
  description?: string;
  customUrl?: string;
  publishedAt?: string;
  thumbnails?: YouTubeThumbnails;
}

export interface YouTubeChannelStatistics {
  viewCount?: string;
  subscriberCount?: string;
  videoCount?: string;
  hiddenSubscriberCount?: boolean;
}

export interface YouTubeChannelContentDetails {
  relatedPlaylists?: {
    likes?: string;
    uploads?: string;
  };
}

export interface YouTubeChannelItem {
  kind: string;
  etag?: string;
  id: string;
  snippet?: YouTubeChannelSnippet;
  statistics?: YouTubeChannelStatistics;
  contentDetails?: YouTubeChannelContentDetails;
}

export interface YouTubeVideoSnippet {
  title: string;
  description?: string;
  channelTitle?: string;
  channelId?: string;
  publishedAt?: string;
  thumbnails?: YouTubeThumbnails;
  categoryId?: string;
  tags?: string[];
  liveBroadcastContent?: string;
}

export interface YouTubeVideoContentDetails {
  duration?: string;
  dimension?: string;
  definition?: string;
  caption?: string;
}

export interface YouTubeVideoStatistics {
  viewCount?: string;
  likeCount?: string;
  commentCount?: string;
}

export interface YouTubeVideoStatus {
  privacyStatus?: string;
  uploadStatus?: string;
  license?: string;
  embeddable?: boolean;
  publicStatsViewable?: boolean;
}

export interface YouTubeVideoItem {
  kind: string;
  etag?: string;
  id: string;
  snippet?: YouTubeVideoSnippet;
  contentDetails?: YouTubeVideoContentDetails;
  statistics?: YouTubeVideoStatistics;
  status?: YouTubeVideoStatus;
}

export interface YouTubePlaylistSnippet {
  title: string;
  description?: string;
  channelTitle?: string;
  channelId?: string;
  publishedAt?: string;
  thumbnails?: YouTubeThumbnails;
}

export interface YouTubePlaylistContentDetails {
  itemCount?: number;
}

export interface YouTubePlaylistItem {
  kind: string;
  etag?: string;
  id: string;
  snippet?: YouTubePlaylistSnippet;
  contentDetails?: YouTubePlaylistContentDetails;
}

export interface YouTubeSearchResult {
  kind: string;
  etag?: string;
  id: {
    kind: string;
    videoId?: string;
    channelId?: string;
    playlistId?: string;
  };
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: YouTubeThumbnails;
    liveBroadcastContent?: string;
  };
}

export interface YouTubeApiResponse<T> {
  kind: string;
  etag?: string;
  pageInfo?: {
    totalResults?: number;
    resultsPerPage?: number;
  };
  nextPageToken?: string;
  prevPageToken?: string;
  items?: T[];
}

/** Parsed YouTube URL result. */
export interface YouTubeUrlParse {
  kind: "video" | "channel" | "playlist" | "shorts" | "embed";
  id: string;
  canonicalUrl: string;
}
