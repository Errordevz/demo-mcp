/**
 * Instagram / YouTube / X / Reddit extraction depth.
 *
 * Each platform gets a dedicated parser over the page's own public payload
 * (shortcode-media JSON, ytInitialPlayerResponse, __NEXT_DATA__,
 * shreddit-player/reddit_video) plus precise unsupported reporting when the
 * media is login-gated, private, manifest-only, ciphered, or a photo post.
 * Every case runs offline against fixtures in tests/fixtures/pages.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractInstagramShortcode,
  extractRedditPostId,
  extractXStatus,
  extractYouTubeVideoId,
  parseInstagram,
  parsePlatformPage,
  parseReddit,
  parseX,
  parseYouTube,
} from "../src/browser/platforms.js";
import { VideoProcessor } from "../src/video/processor.js";
import { classifyAccess } from "../src/video/access.js";
import { parsePage, platformForUrl } from "../src/video/http.js";
import { describeVideoCapabilities } from "../src/video/capabilities.js";
import { instagramReelPage, redditPostPage, xPostPage, youtubeWatchPage } from "./fixtures/pages.js";

const INSTAGRAM_URL = "https://www.instagram.com/reel/C0d3R33lXyZ/";
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const X_URL = "https://x.com/launch_creator/status/1700000000000000001";
const REDDIT_URL = "https://www.reddit.com/r/space/comments/abc123x/my_first_successful_landing/";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mp4Bytes(): Uint8Array {
  const bytes = new Uint8Array(128);
  // Minimal ISO-BMFF: size + 'ftyp' + brand keeps the signature probe honest.
  bytes.set([0, 0, 0, 32], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 8);
  return bytes;
}

describe("platform URL identity", () => {
  it("routes each platform to its own parser", () => {
    expect(platformForUrl(INSTAGRAM_URL)).toBe("instagram");
    expect(platformForUrl(YOUTUBE_URL)).toBe("youtube");
    expect(platformForUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(platformForUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("youtube");
    expect(platformForUrl(X_URL)).toBe("x");
    expect(platformForUrl("https://twitter.com/launch_creator/status/1700000000000000001")).toBe("x");
    expect(platformForUrl(REDDIT_URL)).toBe("reddit");
    expect(platformForUrl("https://redd.it/abc123x")).toBe("reddit");
    expect(platformForUrl("https://v.redd.it/abc123x")).toBe("generic");
  });

  it("extracts video ids without any network access", () => {
    expect(extractInstagramShortcode(INSTAGRAM_URL)).toEqual({ kind: "reel", shortcode: "C0d3R33lXyZ" });
    expect(extractYouTubeVideoId(YOUTUBE_URL)).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractXStatus(X_URL)).toEqual({ user: "launch_creator", statusId: "1700000000000000001" });
    expect(extractRedditPostId(REDDIT_URL)).toBe("abc123x");
    expect(extractRedditPostId("https://v.redd.it/abc123x")).toBe("abc123x");
  });
});

describe("Instagram extraction", () => {
  it("parses shortcode media JSON into identity, author, duration and streams", () => {
    const parsed = parsePage(instagramReelPage(), INSTAGRAM_URL);
    const info = parsed.platformInfo;
    expect(info?.platform).toBe("instagram");
    expect(info?.videoId).toBe("C0d3R33lXyZ");
    expect(info?.canonicalUrl).toBe(INSTAGRAM_URL);
    expect(info?.author?.uniqueId).toBe("reel.creator");
    expect(info?.description).toContain("Sunset timelapse");
    expect(info?.durationSeconds).toBe(12.5);
    expect(info?.width).toBe(720);
    expect(info?.height).toBe(1280);
    expect(info?.source).toBe("platform_payload");
    expect(info?.accessHint).toBeNull();
    expect(info?.isImagePost).toBe(false);
    const sources = parsed.candidates.map((candidate) => candidate.source);
    expect(sources).toContain("instagram.video_url");
    expect(sources).toContain("instagram.playable_url");
    expect(parsed.durationSeconds).toBe(12.5);
  });

  it("flags photo posts as image posts with no video streams", () => {
    const info = parseInstagram({ url: INSTAGRAM_URL, html: instagramReelPage({ imagePost: true }), meta: {} });
    expect(info?.isImagePost).toBe(true);
    expect(info?.streams).toHaveLength(0);
    expect(info?.limitations.some((entry) => /photo, not a video/i.test(entry))).toBe(true);
  });

  it("reports a private account precisely instead of an empty resolve", () => {
    const info = parseInstagram({ url: INSTAGRAM_URL, html: instagramReelPage({ privateAccount: true }), meta: {} });
    expect(info?.streams).toHaveLength(0);
    expect(info?.accessHint?.status).toBe("private");
    const access = classifyAccess({ platform: "instagram", httpStatus: 200, platformHint: info?.accessHint, playableStreamFound: false });
    expect(access.status).toBe("private");
    expect(access.mayDescribeContent).toBe(false);
  });

  it("reports the Instagram login wall as login_required", () => {
    const info = parseInstagram({ url: INSTAGRAM_URL, html: instagramReelPage({ loginWall: true }), meta: {} });
    expect(info?.accessHint?.status).toBe("login_required");
  });
});

describe("YouTube extraction", () => {
  it("parses id, title, author, duration and a literal progressive URL", () => {
    const parsed = parsePage(youtubeWatchPage(), YOUTUBE_URL);
    const info = parsed.platformInfo;
    expect(info?.platform).toBe("youtube");
    expect(info?.videoId).toBe("dQw4w9WgXcQ");
    expect(info?.canonicalUrl).toBe(YOUTUBE_URL);
    expect(info?.author?.nickname).toBe("Rick Astley");
    expect(info?.durationSeconds).toBe(212);
    expect(info?.createdAt).toBe("2009-10-25T00:00:00.000Z");
    expect(info?.thumbnail).toContain("i.ytimg.com");
    expect(info?.source).toBe("platform_payload");
    expect(info?.accessHint).toBeNull();
    const playable = parsed.candidates.filter((candidate) => candidate.source === "youtube.format_url");
    expect(playable).toHaveLength(1);
    expect(playable[0].url).toContain("googlevideo.com");
    expect(info?.manifests.map((entry) => entry.kind).sort()).toEqual(["dash", "hls"]);
  });

  it("never uses ciphered renditions and says so in the limitations", () => {
    const info = parseYouTube({ url: YOUTUBE_URL, html: youtubeWatchPage({ cipheredOnly: true }), meta: {} });
    expect(info?.streams.some((entry) => entry.source === "youtube.format_url")).toBe(false);
    expect(info?.manifestOnly).toBe(true);
    expect(info?.limitations.some((entry) => /never deciphers signatures/i.test(entry))).toBe(true);
    expect(info?.limitations.some((entry) => /never streamed or assembled/i.test(entry))).toBe(true);
  });

  it("maps YouTube's own playability verdict to precise access statuses", () => {
    const privateInfo = parseYouTube({ url: YOUTUBE_URL, html: youtubeWatchPage({ playability: "PRIVATE", noStreaming: true }), meta: {} });
    expect(privateInfo?.accessHint?.status).toBe("private");
    expect(privateInfo?.statusMessage).toMatch(/PRIVATE/);

    const loginInfo = parseYouTube({ url: YOUTUBE_URL, html: youtubeWatchPage({ playability: "LOGIN_REQUIRED", noStreaming: true }), meta: {} });
    expect(loginInfo?.accessHint?.status).toBe("login_required");

    const goneInfo = parseYouTube({ url: YOUTUBE_URL, html: youtubeWatchPage({ playability: "UNPLAYABLE", noStreaming: true }), meta: {} });
    expect(goneInfo?.accessHint?.status).toBe("unavailable");

    const access = classifyAccess({ platform: "youtube", httpStatus: 200, platformHint: privateInfo?.accessHint, playableStreamFound: false });
    expect(access.status).toBe("private");
  });
});

describe("X extraction", () => {
  it("parses status id, author, tweet text and MP4 variants", () => {
    const parsed = parsePage(xPostPage(), X_URL);
    const info = parsed.platformInfo;
    expect(info?.platform).toBe("x");
    expect(info?.videoId).toBe("1700000000000000001");
    expect(info?.canonicalUrl).toBe(X_URL);
    expect(info?.author?.uniqueId).toBe("launch_creator");
    expect(info?.description).toContain("Launch day has arrived");
    expect(info?.durationSeconds).toBe(15);
    expect(info?.source).toBe("platform_payload");
    const variants = parsed.candidates.filter((candidate) => candidate.source === "x.variant");
    expect(variants).toHaveLength(2);
    expect(variants.every((entry) => entry.url.includes("video.twimg.com"))).toBe(true);
    expect(info?.manifests).toHaveLength(1);
    expect(info?.manifestOnly).toBe(false);
  });

  it("flags photo-only posts and protected accounts precisely", () => {
    const photo = parseX({ url: X_URL, html: xPostPage({ photoOnly: true }), meta: {} });
    expect(photo?.isImagePost).toBe(true);
    expect(photo?.streams).toHaveLength(0);

    const locked = parseX({ url: "https://x.com/locked_creator/status/1700000000000000001", html: xPostPage({ protectedAccount: true }), meta: {} });
    expect(locked?.accessHint?.status).toBe("private");
  });
});

describe("Reddit extraction", () => {
  it("parses post id, author, title, duration and the video-only fallback", () => {
    const parsed = parsePage(redditPostPage(), REDDIT_URL);
    const info = parsed.platformInfo;
    expect(info?.platform).toBe("reddit");
    expect(info?.videoId).toBe("abc123x");
    expect(info?.author?.uniqueId).toBe("rocketeer");
    expect(info?.description).toContain("successful landing");
    expect(info?.durationSeconds).toBe(15);
    expect(info?.width).toBe(720);
    expect(info?.height).toBe(1280);
    expect(info?.source).toBe("platform_payload");
    const fallback = parsed.candidates.filter((candidate) => candidate.source === "reddit.fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0].url).toContain("v.redd.it");
    expect(info?.limitations.some((entry) => /video-only/i.test(entry))).toBe(true);
  });

  it("reports private communities and image posts precisely", () => {
    const locked = parseReddit({ url: REDDIT_URL, html: redditPostPage({ privateCommunity: true }), meta: {} });
    expect(locked?.accessHint?.status).toBe("private");
    const access = classifyAccess({ platform: "reddit", httpStatus: 200, platformHint: locked?.accessHint, playableStreamFound: false });
    expect(access.status).toBe("private");

    const photo = parseReddit({ url: REDDIT_URL, html: redditPostPage({ imagePost: true }), meta: {} });
    expect(photo?.isImagePost).toBe(true);
    expect(photo?.streams).toHaveLength(0);
  });

  it("resolves a Reddit post end to end through the real pipeline", async () => {
    const page = redditPostPage();
    const media = mp4Bytes();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { method?: string }) => {
        const url = String(input);
        const method = String(init?.method ?? "GET").toUpperCase();
        if (url === REDDIT_URL) {
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
          return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
        }
        if (url.startsWith("https://v.redd.it/")) {
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(media.byteLength) } });
          return new Response(media.slice() as unknown as BodyInit, { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes 0-${media.byteLength - 1}/${media.byteLength}` } });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const processor = new VideoProcessor({ SSRF_DNS_CHECK: "false", SCREENSHOTS: undefined } as never, "https://demo.test/mcp");
    const resolution = await processor.resolve(REDDIT_URL);
    expect(resolution.success).toBe(true);
    expect(resolution.platform).toBe("reddit");
    expect(resolution.mediaUrl).toContain("v.redd.it");
    expect(resolution.detail.access.status).toBe("public");
    expect(resolution.detail.videoId).toBe("abc123x");
    expect(resolution.detail.creator?.uniqueId).toBe("rocketeer");
    expect(resolution.detail.captionSource).toBe("reddit_post");
    expect(resolution.detail.metadataSource).toBe("platform_payload");
    expect(resolution.metadata.durationSeconds).toBe(15);
    expect(resolution.limitations.some((entry) => /video-only/i.test(entry))).toBe(true);
  });
});

describe("platform fallback dispatch", () => {
  it("returns null for TikTok and generic URLs", () => {
    expect(parsePlatformPage({ url: "https://www.tiktok.com/@a/video/1", html: "<html></html>" })).toBeNull();
    expect(parsePlatformPage({ url: "https://example.com/video.mp4", html: "<html></html>" })).toBeNull();
  });

  it("names the video-artifacts lifecycle rule in the capability report", () => {
    const report = describeVideoCapabilities({}, { browserAvailable: true, provider: "cloudflare", videoFrames: true });
    expect(report.storage.cleanup).toMatch(/demo-video-artifacts-expiry/);
    expect(report.storage.cleanup).toMatch(/video-artifacts\//);
    expect(report.storage.cleanup).toMatch(/--expire-days 2/);
  });

  it("describes the new extractors honestly in the capability report", () => {
    const report = describeVideoCapabilities({}, { browserAvailable: false, provider: "none", videoFrames: false });
    const byPlatform = Object.fromEntries(report.supportedPlatforms.map((entry) => [entry.platform, entry.notes]));
    expect(byPlatform.instagram).toMatch(/video_url/);
    expect(byPlatform.instagram).toMatch(/never persisted/);
    expect(byPlatform.youtube).toMatch(/playability/);
    expect(byPlatform.youtube).toMatch(/never deciphered/);
    expect(byPlatform.x).toMatch(/video_info/);
    expect(byPlatform.reddit).toMatch(/video-only/);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/dedicated parsing is not|no dedicated/i);
  });
});
