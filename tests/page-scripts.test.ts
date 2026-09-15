import { describe, expect, it } from "vitest";
import {
  annotateInteractive,
  collectChallengeSignals,
  collectMediaInfo,
  collectPageState,
  prepareVideoForSampling,
  seekVideo,
} from "../src/browser/page-scripts.js";
import { runInPage } from "./helpers/dom.js";
import { tiktokVideoPage } from "./fixtures/pages.js";

const READ_OPTIONS = {
  maxTextChars: 20_000,
  maxLinks: 50,
  includeHtml: false,
  maxHtmlChars: 0,
  maxInteractive: 50,
  maxHeadings: 10,
  maxJsonLd: 5,
  maxRawStateChars: 100_000,
  selector: null,
};

describe("collectChallengeSignals", () => {
  it("detects password fields", () => {
    const result = runInPage(`<html><body><input type="password"></body></html>`, collectChallengeSignals);
    expect(result.hasPasswordField).toBe(true);
    expect(result.hasCaptchaWidget).toBe(false);
  });

  it("detects captcha widgets and consent banners", () => {
    const result = runInPage(
      `<html><body>
        <div class="g-recaptcha"></div>
        <div id="onetrust-banner-sdk"><button>Accept</button></div>
        <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>
      </body></html>`,
      collectChallengeSignals,
    );
    expect(result.hasCaptchaWidget).toBe(true);
    expect(result.hasConsentBanner).toBe(true);
    expect(result.iframeHosts).toContain("www.google.com");
  });

  it("reports an empty state on a plain page", () => {
    const result = runInPage(`<html><head><title>Plain</title></head><body><p>Hello</p></body></html>`, collectChallengeSignals);
    expect(result.title).toBe("Plain");
    expect(result.hasPasswordField).toBe(false);
    expect(result.hasConsentBanner).toBe(false);
  });
});

describe("collectPageState", () => {
  const html = `<html lang="en"><head><title>Read me</title>
    <meta property="og:title" content="OG title"><meta name="twitter:card" content="summary">
    <script type="application/ld+json">{"@type":"Article"}</script></head>
    <body><h1>Heading</h1><p>Visible text</p>
    <a href="/relative">Relative</a><a href="https://other.test/x">Absolute</a>
    <button id="save">Save</button><input placeholder="Search"></body></html>`;

  it("returns text, metadata, links and headings", () => {
    const result = runInPage(html, collectPageState, READ_OPTIONS);
    expect(result.title).toBe("Read me");
    expect(result.lang).toBe("en");
    expect(result.text).toContain("Visible text");
    expect(result.headings).toContain("Heading");
    expect(result.meta["og:title"]).toBe("OG title");
    expect(result.meta["twitter:card"]).toBe("summary");
    expect(result.links.map((link) => link.href)).toEqual(["https://example.com/relative", "https://other.test/x"]);
    expect(result.jsonLd).toHaveLength(1);
  });

  it("tags interactive elements with demo refs", () => {
    const result = runInPage(html, collectPageState, READ_OPTIONS);
    const refs = result.interactive.map((element) => element.ref);
    expect(refs).toContain("e1");
    expect(result.interactive.some((element) => element.tag === "button" && element.text === "Save")).toBe(true);
    expect(result.interactive.some((element) => element.placeholder === "Search")).toBe(true);
  });

  it("honours the selector scope", () => {
    const result = runInPage(html, collectPageState, { ...READ_OPTIONS, selector: "body p" });
    expect(result.selector).toBe("body p");
    expect(result.selectorMatched).toBe(true);
    expect(result.text).toContain("Visible text");
    expect(result.links).toHaveLength(0);
  });

  it("bounds output size", () => {
    const result = runInPage(html, collectPageState, { ...READ_OPTIONS, maxTextChars: 5, maxLinks: 1 });
    expect(result.text.length).toBeLessThanOrEqual(5);
    expect(result.links).toHaveLength(1);
  });
});

describe("collectMediaInfo", () => {
  it("reports video elements, posters and sources", () => {
    const html = `<html><head><title>Media</title>
      <meta property="og:video" content="https://cdn.test/v.mp4"><meta name="twitter:image" content="https://cdn.test/t.jpg"></head>
      <body><video id="v" poster="https://cdn.test/poster.jpg" playsinline controls>
        <source src="https://cdn.test/v.webm" type="video/webm">
        <source src="https://cdn.test/v.mp4" type="video/mp4">
      </video><img src="https://cdn.test/img.png" alt="Alt text"></body></html>`;
    const result = runInPage(html, collectMediaInfo, { maxMediaElements: 10, maxImages: 10, maxRawStateChars: 100_000, selector: null });
    expect(result.hasVideoElement).toBe(true);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].poster).toBe("https://cdn.test/poster.jpg");
    expect(result.videos[0].sources).toEqual(["https://cdn.test/v.webm", "https://cdn.test/v.mp4"]);
    expect(result.videos[0].playsInline).toBe(true);
    expect(result.videos[0].controls).toBe(true);
    expect(result.videos[0].protectedMedia).toBe(false);
    expect(result.meta["og:video"]).toBe("https://cdn.test/v.mp4");
    expect(result.images[0].alt).toBe("Alt text");
  });

  it("never downloads media", () => {
    const result = runInPage(tiktokVideoPage(), collectMediaInfo, { maxMediaElements: 5, maxImages: 5, maxRawStateChars: 100_000, selector: null });
    expect(result.downloadedMedia).toBe(false);
  });

  it("exposes TikTok's hydration payload for parsing", () => {
    const result = runInPage(tiktokVideoPage(), collectMediaInfo, { maxMediaElements: 5, maxImages: 5, maxRawStateChars: 100_000, selector: null });
    expect(result.rawStates.universal).toContain("webapp.video-detail");
  });
});

describe("annotateInteractive", () => {
  it("assigns sequential refs and data attributes", () => {
    const html = `<html><body><button>One</button><a href="/two">Two</a><input type="checkbox"></body></html>`;
    const result = runInPage(html, annotateInteractive, { maxElements: 10, reset: true });
    expect(result.map((element) => element.ref)).toEqual(["e1", "e2", "e3"]);
    expect(result[2].checked).toBe(false);
    expect(result[0].tag).toBe("button");
  });
});

describe("video sampling helpers", () => {
  it("prepares the video and reports that it is not DRM protected", () => {
    const result = runInPage(
      `<html><body><video src="https://cdn.test/v.mp4"></video></body></html>`,
      prepareVideoForSampling,
      { index: 0, selector: null, muted: true },
    );
    expect(result.found).toBe(true);
    expect(result.protectedMedia).toBe(false);
    // jsdom cannot decode media, so no duration is available — the inspector
    // must report that honestly rather than guess.
    expect(result.durationSeconds).toBeNull();
  });

  it("reports a missing video instead of throwing", () => {
    const result = runInPage(`<html><body></body></html>`, prepareVideoForSampling, { index: 0, selector: null, muted: true });
    expect(result.found).toBe(false);
    expect(result.errorMessage).toMatch(/No <video> element/);
  });

  it("seek resolves with an error when there is no video", async () => {
    const result = await runInPage(`<html><body></body></html>`, seekVideo, { index: 0, selector: null, time: 1, timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No <video> element/);
  });
});
