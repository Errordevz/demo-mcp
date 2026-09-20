/**
 * YouTube Data API v3 configuration.
 *
 * Public-only: uses YOUTUBE_API_KEY (a Cloudflare Worker secret) for read-only
 * operations on public YouTube resources. No Google OAuth, no account linking,
 * no Drive/Gmail/Calendar access.
 *
 * The key is deliberately *not* stored on the config object. It is read from
 * `env` at call time by the HTTP client, never logged, never returned by any
 * endpoint, and never included in a tool result.
 */

/** YouTube Data API v3 origin. Pinned so a misconfigured variable cannot
 *  redirect the key at a different host. */
export const YOUTUBE_API_ORIGIN = "https://www.googleapis.com";
export const YOUTUBE_VIDEOS_PATH = "/youtube/v3/videos";
export const YOUTUBE_SEARCH_PATH = "/youtube/v3/search";
export const YOUTUBE_CHANNELS_PATH = "/youtube/v3/channels";
export const YOUTUBE_PLAYLISTS_PATH = "/youtube/v3/playlists";
export const YOUTUBE_PLAYLIST_ITEMS_PATH = "/youtube/v3/playlistItems";

export interface YouTubeEnv {
  /** Worker secret. Never a `vars` entry, never returned by any endpoint. */
  YOUTUBE_API_KEY?: string;
}

export interface YouTubeConfig {
  /** Ready to call: the key is present. */
  available: boolean;
  /** Presence only — the key itself is read at call time from `env`. */
  apiKeyPresent: boolean;
  /** Why it is off/unusable, in user-facing terms. Never mentions the key value. */
  disabledReason: string | null;
  endpoint: string;
}

/**
 * Resolve the deployment's YouTube settings.
 *
 * Deliberately synchronous and allocation-free: `/health`, `demo_ping` and the
 * capability report call it on every request.
 */
export function resolveYouTubeConfig(env: Record<string, unknown> | undefined): YouTubeConfig {
  const values = (env ?? {}) as YouTubeEnv;
  const apiKey = typeof values.YOUTUBE_API_KEY === "string" ? values.YOUTUBE_API_KEY.trim() : "";

  let disabledReason: string | null = null;
  if (!apiKey) {
    disabledReason = "Set the YOUTUBE_API_KEY secret on this Worker to enable YouTube operations.";
  }

  return {
    available: apiKey.length > 0,
    apiKeyPresent: apiKey.length > 0,
    disabledReason,
    endpoint: `${YOUTUBE_API_ORIGIN}/youtube/v3`,
  };
}

/** Presence-only flags for `demo_ping`, `/health` and platform telemetry. */
export function youTubeFlags(env: Record<string, unknown> | undefined): Record<string, boolean | string | null> {
  const config = resolveYouTubeConfig(env);
  return {
    youtubeAvailable: config.available,
    youtubeApiKeyConfigured: config.apiKeyPresent,
  };
}
