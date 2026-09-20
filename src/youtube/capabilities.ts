/**
 * YouTube capability description — one source of truth.
 *
 * Reports whether this deployment can query the YouTube Data API v3 for public
 * metadata, what tools are available, and how YouTube integrates with the
 * existing video pipeline.
 */

import { resolveYouTubeConfig, type YouTubeEnv } from "./config.js";

export const YOUTUBE_CAPABILITIES_URI = "demo://capabilities/youtube";

export interface YouTubeCapabilityReport {
  schema: "demo.youtube-capabilities/1";
  available: boolean;
  disabledReason: string | null;
  apiKeyPresent: boolean;
  tools: {
    youtube_search: {
      description: string;
      supportedTypes: string[];
      maxResults: number;
      pagination: boolean;
    };
    youtube_video: {
      description: string;
      supportedUrlForms: string[];
      returnsMetadata: boolean;
      pipelineIntegration: boolean;
    };
    youtube_channel: {
      description: string;
      supportedInputs: string[];
    };
    youtube_playlist: {
      description: string;
      supportedInputs: string[];
      canListItems: boolean;
    };
  };
  videoPipelineIntegration: {
    description: string;
    whenAvailable: string;
    metadataIsNotWatching: string;
    pipelineTools: string[];
  };
  scope: "public_only";
  noOAuth: boolean;
  noAccountLinking: boolean;
}

/**
 * Describe what this deployment can do with YouTube.
 *
 * `env` is read for *presence* of the API key only. The key value is never
 * included in the report.
 */
export function describeYouTubeCapabilities(env: Record<string, unknown> | undefined): YouTubeCapabilityReport {
  const config = resolveYouTubeConfig(env);

  return {
    schema: "demo.youtube-capabilities/1",
    available: config.available,
    disabledReason: config.disabledReason,
    apiKeyPresent: config.apiKeyPresent,
    tools: {
      youtube_search: {
        description: "Search public YouTube videos, channels, or playlists.",
        supportedTypes: ["video", "channel", "playlist"],
        maxResults: 50,
        pagination: true,
      },
      youtube_video: {
        description: "Retrieve public video metadata (title, description, channel, duration, statistics, thumbnails).",
        supportedUrlForms: [
          "https://www.youtube.com/watch?v=VIDEO_ID",
          "https://youtu.be/VIDEO_ID",
          "https://www.youtube.com/shorts/VIDEO_ID",
          "https://www.youtube.com/embed/VIDEO_ID",
        ],
        returnsMetadata: true,
        pipelineIntegration: true,
      },
      youtube_channel: {
        description: "Retrieve public channel metadata (title, description, statistics, thumbnails).",
        supportedInputs: ["channel ID (UC...)", "@handle", "channel URL"],
      },
      youtube_playlist: {
        description: "Retrieve public playlist metadata and optionally list items.",
        supportedInputs: ["playlist ID (PL...)", "playlist URL"],
        canListItems: true,
      },
    },
    videoPipelineIntegration: {
      description: "YouTube metadata is separate from the video pipeline. When a video is public and embeddable, the existing video pipeline (inspect_video, video_resolve, video_fetch) can attempt actual media retrieval.",
      whenAvailable: "Public, embeddable videos can be passed to inspect_video for frame extraction, audio, transcription, and vision analysis.",
      metadataIsNotWatching: "YouTube Data API metadata retrieval is NOT equivalent to watching the video. DEMO never claims to have watched, seen, heard, or analyzed a YouTube video unless the actual media was obtained through the video pipeline.",
      pipelineTools: ["inspect_video", "video_resolve", "video_fetch", "video_extract_frames", "video_extract_audio", "video_transcribe", "video_analyze"],
    },
    scope: "public_only",
    noOAuth: true,
    noAccountLinking: true,
  };
}
