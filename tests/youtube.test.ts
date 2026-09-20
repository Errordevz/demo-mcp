/**
 * Tests for YouTube URL parsing, ISO duration parsing, and the YouTube
 * capability report.
 *
 * These tests do not require a live API key — they validate the pure helpers
 * and the credential-free capability surface.
 */

import { describe, expect, it } from "vitest";
import { parseYouTubeUrl, isYouTubeVideoId, isYouTubeChannelId, isYouTubePlaylistId, parseIsoDuration, formatVideoMetadata } from "../src/youtube/client.js";
import { resolveYouTubeConfig, youTubeFlags } from "../src/youtube/config.js";
import { describeYouTubeCapabilities } from "../src/youtube/capabilities.js";

describe("YouTube URL parsing", () => {
  it("extracts video IDs from all supported URL forms", () => {
    const cases: Array<[string, string | null]> = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", "dQw4w9WgXcQ"],
      ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ];
    for (const [url, expectedId] of cases) {
      const result = parseYouTubeUrl(url);
      expect(result, url).not.toBeNull();
      expect(result?.kind, url).toBe("video");
      expect(result?.id, url).toBe(expectedId);
    }
  });

  it("extracts channel IDs from channel URLs", () => {
    const result = parseYouTubeUrl("https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("channel");
    expect(result?.id).toBe("UCuAXFkgsw1L7xaCfnd5JJOw");
  });

  it("extracts playlist IDs from playlist URLs", () => {
    const result = parseYouTubeUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("playlist");
    expect(result?.id).toBe("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf");
  });

  it("returns null for non-YouTube URLs", () => {
    expect(parseYouTubeUrl("https://example.com")).toBeNull();
    expect(parseYouTubeUrl("https://vimeo.com/123")).toBeNull();
    expect(parseYouTubeUrl("not a url")).toBeNull();
  });

  it("returns null for YouTube handles that need API lookup", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/@MrBeast")).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/c/SomeChannel")).toBeNull();
  });
});

describe("YouTube ID validation", () => {
  it("recognizes valid video IDs", () => {
    expect(isYouTubeVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeVideoId("abc123")).toBe(true);
    expect(isYouTubeVideoId("a")).toBe(false);
    expect(isYouTubeVideoId("")).toBe(false);
  });

  it("recognizes valid channel IDs (UC prefix, 20+ chars)", () => {
    expect(isYouTubeChannelId("UCuAXFkgsw1L7xaCfnd5JJOw")).toBe(true);
    expect(isYouTubeChannelId("short")).toBe(false);
  });

  it("recognizes valid playlist IDs (PL/UL/LL/FL/RD/OL prefix)", () => {
    expect(isYouTubePlaylistId("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")).toBe(true);
    expect(isYouTubePlaylistId("UUxxxxxxxxxxxxxxxxx")).toBe(true);
    expect(isYouTubePlaylistId("short")).toBe(false);
  });
});

describe("ISO 8601 duration parsing", () => {
  it("parses hours, minutes, and seconds", () => {
    expect(parseIsoDuration("PT4M13S")).toBe(253);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT30S")).toBe(30);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("PT5M")).toBe(300);
  });

  it("returns null for invalid durations", () => {
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration("")).toBeNull();
    expect(parseIsoDuration("not a duration")).toBeNull();
  });
});

describe("YouTube config resolution", () => {
  it("reports unavailable when the key is not configured", () => {
    const config = resolveYouTubeConfig({});
    expect(config.available).toBe(false);
    expect(config.apiKeyPresent).toBe(false);
    expect(config.disabledReason).toBeTruthy();
  });

  it("reports available when the key is configured", () => {
    const config = resolveYouTubeConfig({ YOUTUBE_API_KEY: "test-key-123" });
    expect(config.available).toBe(true);
    expect(config.apiKeyPresent).toBe(true);
    expect(config.disabledReason).toBeNull();
  });

  it("never exposes the key value", () => {
    const config = resolveYouTubeConfig({ YOUTUBE_API_KEY: "super-secret-key" });
    const json = JSON.stringify(config);
    expect(json).not.toContain("super-secret-key");
  });
});

describe("YouTube flags for telemetry", () => {
  it("reports unavailable without a key", () => {
    const flags = youTubeFlags({});
    expect(flags.youtubeAvailable).toBe(false);
    expect(flags.youtubeApiKeyConfigured).toBe(false);
  });

  it("reports available with a key", () => {
    const flags = youTubeFlags({ YOUTUBE_API_KEY: "test" });
    expect(flags.youtubeAvailable).toBe(true);
    expect(flags.youtubeApiKeyConfigured).toBe(true);
  });
});

describe("YouTube capability report", () => {
  it("describes the capabilities without exposing the key", () => {
    const report = describeYouTubeCapabilities({ YOUTUBE_API_KEY: "test-key" });
    expect(report.schema).toBe("demo.youtube-capabilities/1");
    expect(report.available).toBe(true);
    expect(report.scope).toBe("public_only");
    expect(report.noOAuth).toBe(true);
    expect(report.noAccountLinking).toBe(true);
    const json = JSON.stringify(report);
    expect(json).not.toContain("test-key");
  });

  it("reports unavailable when no key is configured", () => {
    const report = describeYouTubeCapabilities({});
    expect(report.available).toBe(false);
    expect(report.disabledReason).toBeTruthy();
  });
});

describe("YouTube video metadata formatting", () => {
  it("formats a video item with all fields", () => {
    const item = {
      kind: "youtube#video",
      id: "dQw4w9WgXcQ",
      snippet: {
        title: "Test Video",
        description: "A test video",
        channelTitle: "Test Channel",
        channelId: "UC123",
        publishedAt: "2024-01-01T00:00:00Z",
        categoryId: "22",
        liveBroadcastContent: "none",
      },
      contentDetails: {
        duration: "PT4M13S",
        definition: "hd",
        caption: "true",
      },
      statistics: {
        viewCount: "1000000",
        likeCount: "50000",
        commentCount: "1000",
      },
      status: {
        privacyStatus: "public",
        embeddable: true,
      },
    };

    const result = formatVideoMetadata(item);
    expect(result.video_id).toBe("dQw4w9WgXcQ");
    expect(result.title).toBe("Test Video");
    expect(result.duration_seconds).toBe(253);
    expect(result.view_count).toBe(1000000);
    expect(result.privacy_status).toBe("public");
    expect(result.embeddable).toBe(true);
    expect(result.caption_available).toBe(true);
    expect(result.canonical_url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("handles missing fields gracefully", () => {
    const item = {
      kind: "youtube#video",
      id: "abc123",
    };
    const result = formatVideoMetadata(item);
    expect(result.video_id).toBe("abc123");
    expect(result.title).toBeNull();
    expect(result.duration_seconds).toBeNull();
    expect(result.view_count).toBeNull();
  });
});
