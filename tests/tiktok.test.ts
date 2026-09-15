import { describe, expect, it } from "vitest";
import { canonicalTikTokUrl, extractTikTokVideoId, isTikTokUrl, parseTikTok } from "../src/browser/tiktok.js";
import { collectMediaInfo } from "../src/browser/page-scripts.js";
import { runInPage } from "./helpers/dom.js";
import { TIKTOK_VERIFICATION, tiktokSigiPage, tiktokVideoPage } from "./fixtures/pages.js";

const TIKTOK_URL = "https://www.tiktok.com/@creator.one/video/7300000000000000001";

function mediaPayload(html: string, url = TIKTOK_URL) {
  return runInPage(
    html,
    collectMediaInfo,
    { maxMediaElements: 5, maxImages: 5, maxRawStateChars: 300_000, selector: null },
    url,
  );
}

describe("tiktok url helpers", () => {
  it("recognises TikTok hosts", () => {
    for (const url of [
      "https://www.tiktok.com/@creator.one/video/7300000000000000001",
      "https://vt.tiktok.com/ZSShort123/",
      "https://vm.tiktok.com/ABC/",
      "https://m.tiktok.com/v/7300000000000000001.html",
    ]) {
      expect(isTikTokUrl(url), url).toBe(true);
    }
    expect(isTikTokUrl("https://example.com/video/1")).toBe(false);
  });

  it("extracts video ids", () => {
    expect(extractTikTokVideoId(TIKTOK_URL)).toBe("7300000000000000001");
    expect(extractTikTokVideoId("https://www.tiktok.com/@a/video/123?lang=en")).toBe("123");
    expect(extractTikTokVideoId("https://www.tiktok.com/@a")).toBeNull();
  });

  it("builds canonical urls", () => {
    expect(canonicalTikTokUrl("creator.one", "7300000000000000001")).toBe(TIKTOK_URL);
    expect(canonicalTikTokUrl(null, null)).toBeNull();
  });
});

describe("tiktok metadata extraction", () => {
  it("parses the universal hydration payload", () => {
    const payload = mediaPayload(tiktokVideoPage());
    const info = parseTikTok({ url: payload.url, meta: payload.meta, rawStates: payload.rawStates });
    expect(info).not.toBeNull();
    expect(info?.source).toBe("universal");
    expect(info?.videoId).toBe("7300000000000000001");
    expect(info?.author?.uniqueId).toBe("creator.one");
    expect(info?.author?.nickname).toBe("Creator One");
    expect(info?.author?.verified).toBe(true);
    expect(info?.description).toContain("Testing the new browser tool");
    expect(info?.durationSeconds).toBe(17);
    expect(info?.thumbnail).toContain("p16-sign.tiktokcdn.com");
    expect(info?.media?.playUrl).toContain("tiktokcdn.com");
    expect(info?.media?.width).toBe(720);
    expect(info?.media?.height).toBe(1280);
    expect(info?.stats?.plays).toBe(1_250_000);
    expect(info?.stats?.likes).toBe(98_000);
    expect(info?.music?.title).toBe("Original Sound");
    expect(info?.hashtags).toContain("demo");
    expect(info?.isImagePost).toBe(false);
    expect(info?.createdAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it("parses the legacy SIGI payload", () => {
    const payload = mediaPayload(tiktokSigiPage(), "https://www.tiktok.com/@legacy/video/7300000000000000002");
    const info = parseTikTok({ url: payload.url, meta: payload.meta, rawStates: payload.rawStates });
    expect(info?.source).toBe("sigi");
    expect(info?.videoId).toBe("7300000000000000002");
    expect(info?.author?.uniqueId).toBe("legacy.creator");
    expect(info?.durationSeconds).toBe(9);
  });

  it("falls back to OpenGraph metadata when no hydration payload is exposed", () => {
    const html = `<html><head><title>Verify</title>
      <meta property="og:url" content="https://www.tiktok.com/@creator.one/video/7300000000000000001">
      <meta property="og:image" content="https://p16.tiktokcdn.com/cover.jpeg">
      <meta property="og:description" content="A caption #cats">
      <meta property="og:video:url" content="https://v16.tiktokcdn.com/v.mp4">
      <meta property="video:duration" content="12">
    </head><body><div class="captcha-verify-container">Please verify you are human</div></body></html>`;
    const payload = mediaPayload(html);
    const info = parseTikTok({ url: payload.url, meta: payload.meta, rawStates: payload.rawStates });
    expect(info?.source).toBe("meta");
    expect(info?.videoId).toBe("7300000000000000001");
    expect(info?.durationSeconds).toBe(12);
    expect(info?.thumbnail).toContain("cover.jpeg");
    expect(info?.limitations.join(" ")).toMatch(/hydration payload/i);
  });

  it("returns null when nothing is available", () => {
    expect(parseTikTok({ url: "https://www.tiktok.com/@a", meta: {}, rawStates: {} })).toBeNull();
  });

  it("flags photo posts", () => {
    const payload = mediaPayload(tiktokVideoPage({ imagePost: true }));
    const info = parseTikTok({ url: payload.url, meta: payload.meta, rawStates: payload.rawStates });
    expect(info?.isImagePost).toBe(true);
    expect(info?.limitations.join(" ")).toMatch(/image\/photo carousel/i);
  });

  it("reports honestly when no playable media URL was exposed", () => {
    const payload = mediaPayload(tiktokVideoPage({ withoutMedia: true }));
    const info = parseTikTok({ url: payload.url, meta: payload.meta, rawStates: payload.rawStates });
    expect(info?.media?.playUrl ?? null).toBeNull();
    expect(info?.limitations.join(" ")).toMatch(/No playable media URL was exposed/i);
  });

  it("produces no invented data for a verification wall", () => {
    const payload = mediaPayload(TIKTOK_VERIFICATION);
    const info = parseTikTok({ url: payload.url, meta: payload.meta, rawStates: payload.rawStates });
    // Only the og tags are available; the video payload is absent.
    expect(info === null || info.source === "meta").toBe(true);
    expect(info === null || info.durationSeconds === null).toBe(true);
  });
});
