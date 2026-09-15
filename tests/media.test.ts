import { describe, expect, it } from "vitest";
import { MediaInspector, buildMediaReport } from "../src/browser/media.js";
import { ScreenshotManager } from "../src/browser/screenshot.js";
import { collectMediaInfo } from "../src/browser/page-scripts.js";
import { runInPage } from "./helpers/dom.js";
import { FakeObjectStore, FakePage } from "./helpers/fake-provider.js";
import { TIKTOK_VERIFICATION, tiktokVideoPage } from "./fixtures/pages.js";

const TIKTOK_URL = "https://www.tiktok.com/@creator.one/video/7300000000000000001";

function payload(html: string, url = TIKTOK_URL) {
  return runInPage(html, collectMediaInfo, { maxMediaElements: 5, maxImages: 5, maxRawStateChars: 300_000, selector: null }, url);
}

function inspector() {
  const store = new FakeObjectStore();
  return { store, media: new MediaInspector(new ScreenshotManager(store as never, "https://demo.test/screenshots")) };
}

describe("buildMediaReport", () => {
  it("splits metadata into OpenGraph, Twitter and standard buckets", () => {
    const report = buildMediaReport(
      payload(`<html><head><title>T</title>
        <meta property="og:title" content="OG"><meta name="twitter:card" content="summary">
        <meta name="description" content="Standard"></head><body></body></html>`, "https://example.com/"),
    );
    expect(report.platform).toBe("generic");
    expect(report.meta.openGraph["og:title"]).toBe("OG");
    expect(report.meta.twitter["twitter:card"]).toBe("summary");
    expect(report.meta.standard.description).toBe("Standard");
  });

  it("parses JSON-LD and keeps unparsable blocks", () => {
    const report = buildMediaReport(
      payload(`<html><head>
        <script type="application/ld+json">{"@type":"VideoObject","name":"V"}</script>
        <script type="application/ld+json">{not json}</script>
      </head><body></body></html>`, "https://example.com/"),
    );
    expect(report.jsonLd[0]).toMatchObject({ ok: true, data: { "@type": "VideoObject" } });
    expect(report.jsonLd[1]).toMatchObject({ ok: false });
  });

  it("reports TikTok videos with author, caption and exposed media", () => {
    const report = buildMediaReport(payload(tiktokVideoPage()));
    expect(report.platform).toBe("tiktok");
    expect(report.hasVideoElement).toBe(true);
    expect(report.tiktok?.author?.uniqueId).toBe("creator.one");
    expect(report.tiktok?.durationSeconds).toBe(17);
    expect(report.tiktok?.media?.playUrl).toBeTruthy();
    expect(report.limitations.join(" ")).toMatch(/signed, region-scoped/i);
  });

  it("reports honestly for a TikTok verification wall", () => {
    const report = buildMediaReport(payload(TIKTOK_VERIFICATION));
    expect(report.platform).toBe("tiktok");
    expect(report.hasVideoElement).toBe(false);
    expect(report.limitations.join(" ")).toMatch(/hydration payload|did not expose/i);
    expect(report.limitations.join(" ")).toMatch(/No HTML5 <video>/i);
    expect(report.limitations.join(" ")).not.toMatch(/bypass/i);
  });

  it("flags DRM protected media", () => {
    const raw = payload(`<html><body><video src="https://cdn.test/drm.mp4"></video></body></html>`, "https://example.com/");
    raw.videos[0].protectedMedia = true;
    const report = buildMediaReport(raw);
    expect(report.limitations.join(" ")).toMatch(/Encrypted Media Extensions/i);
  });
});

describe("video frame sampling", () => {
  it("reports unavailable when the page has no video element", async () => {
    const { media } = inspector();
    const page = new FakePage("https://example.com/", "<html><body><p>No media here</p></body></html>", {
      id: "t1",
      routes: {},
      bytes: new Uint8Array([1, 2, 3]),
    });
    const report = await media.sampleFrames(page, { count: 4 });
    expect(report.available).toBe(false);
    expect(report.frames).toHaveLength(0);
    expect(report.reason).toMatch(/No <video> element/);
  });

  it("refuses to touch DRM protected media", async () => {
    const { media } = inspector();
    const page = new FakePage("https://example.com/", "<html><body><video src='https://cdn.test/drm.mp4'></video></body></html>", {
      id: "t2",
      routes: {},
      bytes: new Uint8Array([1, 2, 3]),
    });
    await page.evaluate(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "mediaKeys", { configurable: true, get: () => ({}) });
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: () => 30 });
    });
    const report = await media.sampleFrames(page, { count: 3 });
    expect(report.available).toBe(false);
    expect(report.reason).toMatch(/DRM|Encrypted Media/);
  });

  it("reports when the browser cannot decode any media", async () => {
    const { media } = inspector();
    const page = new FakePage("https://example.com/", "<html><body><video src='https://cdn.test/v.mp4'></video></body></html>", {
      id: "t3",
      routes: {},
      bytes: new Uint8Array([1, 2, 3]),
    });
    const report = await media.sampleFrames(page, { count: 3 });
    expect(report.available).toBe(false);
    expect(report.reason).toMatch(/duration is unknown/i);
  });

  it("captures a bounded number of frames and stores them externally", async () => {
    const { media, store } = inspector();
    const page = new FakePage("https://www.tiktok.com/@a/video/1", "<html><body><video src='https://cdn.test/v.mp4' playsinline></video></body></html>", {
      id: "t4",
      routes: {},
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]),
    });
    // Make the fake video behave like a decodable 10 second clip.
    await page.evaluate(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: () => 10 });
      Object.defineProperty(HTMLMediaElement.prototype, "videoWidth", { configurable: true, get: () => 720 });
      Object.defineProperty(HTMLMediaElement.prototype, "videoHeight", { configurable: true, get: () => 1280 });
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        configurable: true,
        get(this: HTMLMediaElement) {
          return (this as unknown as { __t?: number }).__t ?? 0;
        },
        set(this: HTMLMediaElement, value: number) {
          (this as unknown as { __t?: number }).__t = value;
          setTimeout(() => this.dispatchEvent(new Event("seeked")), 0);
        },
      });
      (HTMLMediaElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView = function scrollIntoView() {};
    });

    const report = await media.sampleFrames(page, { count: 3 });
    expect(report.durationSeconds).toBe(10);
    expect(report.frames.length).toBe(3);
    expect(report.frames.every((frame) => frame.ok)).toBe(true);
    expect(report.frames[0].url).toMatch(/\/screenshots\/screenshots\//);
    expect(store.objects.size).toBe(3);
    expect(report.limitations.join(" ")).toMatch(/rendered video element/i);

    // Timestamps are spread across the clip, not all at the start.
    const times = report.frames.map((frame) => frame.timeSeconds);
    expect(new Set(times).size).toBe(3);
    expect(Math.max(...times)).toBeGreaterThan(5);
  });

  it("honours explicit timestamps and the frame cap", async () => {
    const { media } = inspector();
    const page = new FakePage("https://example.com/", "<html><body><video src='https://cdn.test/v.mp4'></video></body></html>", {
      id: "t5",
      routes: {},
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await page.evaluate(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: () => 100 });
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        configurable: true,
        get(this: HTMLMediaElement) {
          return (this as unknown as { __t?: number }).__t ?? 0;
        },
        set(this: HTMLMediaElement, value: number) {
          (this as unknown as { __t?: number }).__t = value;
          setTimeout(() => this.dispatchEvent(new Event("seeked")), 0);
        },
      });
      (HTMLMediaElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView = function scrollIntoView() {};
    });
    const report = await media.sampleFrames(page, { timestamps: [1, 20, 50, 80, 95, 99, 99.5] });
    // Capped at LIMITS.framesMaxCount (8) and clamped below the duration.
    expect(report.frames.length).toBe(7);
    expect(report.frames[0].timeSeconds).toBe(1);
  });
});
