import { describe, expect, it, vi } from "vitest";
import { BrowserError } from "../src/core/errors.js";
import { assertNavigableUrl } from "../src/core/url-guard.js";
import { ChallengeManager } from "../src/browser/challenge.js";
import { MediaInspector } from "../src/browser/media.js";
import { ScreenshotManager } from "../src/browser/screenshot.js";
import { BrowserRuntime, createSessionState } from "../src/browser/runtime.js";
import { FakeBrowser, FakeObjectStore, FakeProvider, type FakeRoute } from "./helpers/fake-provider.js";

const BASE = "https://demo.test/screenshots";

function build(routes: Record<string, FakeRoute>, options: { liveView?: boolean; handoff?: boolean } = {}) {
  const provider = new FakeProvider({ routes, liveView: options.liveView ?? true, handoff: options.handoff ?? true });
  const store = new FakeObjectStore();
  const screenshots = new ScreenshotManager(store as never, BASE);
  const challenge = new ChallengeManager(provider);
  const media = new MediaInspector(screenshots);
  const state = createSessionState("s-test", "cloudflare", 300_000);
  const runtime = new BrowserRuntime(provider, state, { screenshots, challenge, media }, {
    persist: async () => undefined,
    validateUrl: async (url: string) => (await assertNavigableUrl(url, { dns: null, allowInsecureHttp: true })).url,
    scheduleHeartbeat: async () => undefined,
  });
  return { provider, store, runtime, screenshots };
}

const SIMPLE_PAGE = `<html><head><title>Example Domain</title><meta name="description" content="A test page"></head>
<body><h1>Example Domain</h1><p>This domain is for use in documentation examples.</p><a href="/more">More</a></body></html>`;

describe("browser session runtime", () => {
  it("opens a normal website and returns final url, title and page stats", async () => {
    const { runtime } = build({ "https://example.com/": { html: SIMPLE_PAGE, status: 200 } });
    const result = await runtime.open(null, "https://example.com/", {});
    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.title).toBe("Example Domain");
    expect(result.status).toBe(200);
    expect(result.challenge.status).toBe("normal");
    expect(result.page.linkCount).toBeGreaterThan(0);
  });

  it("follows redirects, including TikTok short links", async () => {
    const routes: Record<string, FakeRoute> = {
      "https://vt.tiktok.com/ZSShort123/": { redirect: "https://www.tiktok.com/@creator/video/7300000000000000001" },
      "https://www.tiktok.com/@creator/video/7300000000000000001": { html: SIMPLE_PAGE, status: 200 },
    };
    const { runtime } = build(routes);
    const result = await runtime.open(null, "https://vt.tiktok.com/ZSShort123/", {});
    expect(result.redirected).toBe(true);
    expect(result.finalUrl).toBe("https://www.tiktok.com/@creator/video/7300000000000000001");
  });

  it("captures a screenshot and stores the bytes outside the MCP payload", async () => {
    const { runtime, store } = build({ "https://example.com/": { html: SIMPLE_PAGE } });
    const opened = await runtime.open(null, "https://example.com/", {});
    const shot = await runtime.screenshot(opened.tab.id, { type: "png", fullPage: false });
    expect(shot.image.url).toMatch(/^https:\/\/demo\.test\/screenshots\/screenshots\/[a-f0-9]+$/);
    expect(shot.image.mimeType).toBe("image/png");
    expect(store.objects.size).toBe(1);
    expect([...(store.objects.values() as IterableIterator<{ bytes: Uint8Array }>)][0].bytes.byteLength).toBeGreaterThan(8);
  });

  it("returns an accessibility snapshot with roles and names", async () => {
    const { runtime } = build({ "https://example.com/": { html: SIMPLE_PAGE } });
    await runtime.open(null, "https://example.com/", {});
    const snapshot = await runtime.snapshot(null, { mode: "accessibility" });
    const roles = snapshot.nodes.map((node) => node.role);
    expect(roles).toContain("heading");
    expect(roles).toContain("button");
    expect(snapshot.text).toContain("Play");
  });

  it("manages multiple tabs", async () => {
    const { runtime } = build({
      "https://example.com/": { html: SIMPLE_PAGE },
      "https://example.org/": { html: `<html><head><title>Org</title></head><body>Second</body></html>` },
    });
    const first = await runtime.open(null, "https://example.com/", {});
    const second = await runtime.newTab("https://example.org/");
    const listed = await runtime.listTabs();
    expect(listed.tabs.length).toBe(2);
    expect(listed.activeTabId).toBe(second.tab.id);

    const selected = await runtime.selectTab(first.tab.id);
    expect(selected.activeTabId).toBe(first.tab.id);

    const closed = await runtime.closeTab(second.tab.id);
    expect(closed.closed).toBe(second.tab.id);
    expect(closed.tabs.length).toBe(1);
  });

  it("rejects invalid and non-http URLs", async () => {
    const { runtime } = build({});
    await expect(runtime.open(null, "not-a-url", {})).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runtime.open(null, "file:///etc/passwd", {})).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports timeouts with a stable error code", async () => {
    const { runtime } = build({ "https://slow.example/": { failWith: "Navigation timeout of 45000 ms exceeded" } });
    await expect(runtime.open(null, "https://slow.example/", {})).rejects.toMatchObject({ code: "timeout" });
  });

  it("detects a login wall and marks it as requiring a human", async () => {
    const { runtime } = build({
      "https://app.example.com/private": {
        html: `<html><head><title>Sign in to continue</title></head><body><h1>Sign in required</h1><form><input type="password" name="password"></form><p>You must be logged in to view this page.</p></body></html>`,
      },
    });
    const result = await runtime.open(null, "https://app.example.com/private", {});
    expect(result.challenge.status).toBe("login_required");
    expect(result.challenge.requiresHuman).toBe(true);
    expect(result.challenge.recommendedAction).toMatch(/pause_for_human/);
  });

  it("detects a CAPTCHA, pauses for a human and resumes afterwards", async () => {
    const captchaPage = `<html><head><title>Just a moment...</title></head><body>
      <div class="cf-browser-verification"><h1>Please complete the security check</h1>
      <div class="g-recaptcha" data-sitekey="6Lc"></div><p>Verify you are human</p></div></body></html>`;
    const routes: Record<string, FakeRoute> = {
      "https://protected.example/": { html: captchaPage, status: 403 },
    };
    const { runtime } = build(routes, { liveView: true, handoff: true });
    const opened = await runtime.open(null, "https://protected.example/", {});
    expect(["captcha", "bot_check"]).toContain(opened.challenge.status);

    const status = await runtime.challengeStatus(opened.tab.id, { screenshot: true });
    expect(status.challenge.requiresHuman).toBe(true);
    expect(status.screenshot?.url).toMatch(/\/screenshots\//);
    expect(status.liveViewUrl).toContain("live.browser.run");

    const paused = await runtime.pauseForHuman(opened.tab.id, { instructions: "Solve the CAPTCHA", timeoutMs: 60_000 });
    expect(paused.status).toBe("challenge_required");
    expect(paused.handoffId).toBeTruthy();
    expect(paused.liveViewUrl).toContain("live.browser.run");
    expect(paused.waitingForHuman).toBe(true);
    expect(paused.note).toMatch(/does not solve or bypass/i);

    // While the human handoff is still open, resume must not claim success.
    FakeBrowser.handoffActive = true;
    const stillWaiting = await runtime.resume(opened.tab.id, { screenshot: false });
    expect(stillWaiting.status).toBe("waiting_for_human");

    // The human finishes; the page now serves normal content.
    FakeBrowser.handoffActive = false;
    routes["https://protected.example/"] = { html: `<html><head><title>Welcome</title></head><body><h1>Welcome back</h1></body></html>`, status: 200 };
    const resumed = await runtime.resume(opened.tab.id, { reload: true, screenshot: false });
    expect(resumed.status).toBe("resumed");
    expect(resumed.challenge.status).toBe("normal");
    FakeBrowser.handoffActive = true;
  });

  it("keeps working when Live View and handoff are unavailable", async () => {
    const { runtime } = build(
      { "https://protected.example/": { html: `<html><head><title>Verify</title></head><body><div class="h-captcha"></div><p>Are you a robot?</p></body></html>` } },
      { liveView: false, handoff: false },
    );
    const opened = await runtime.open(null, "https://protected.example/", {});
    expect(opened.challenge.status).toBe("captcha");
    const paused = await runtime.pauseForHuman(opened.tab.id, {});
    expect(paused.liveViewUrl).toBeNull();
    expect(paused.handoffId).toBeNull();
    expect(paused.note).toMatch(/does not expose Live View/);
  });

  it("reports capability_unavailable instead of crashing when the browser binding is missing", async () => {
    const { runtime, provider } = build({});
    provider.available = false;
    await expect(runtime.open(null, "https://example.com/", {})).rejects.toSatisfy(
      (error: unknown) => error instanceof BrowserError && error.code === "capability_unavailable",
    );
  });

  it("surfaces Browser Run rate limits as retryable", async () => {
    const { runtime, provider } = build({});
    provider.launchError = "Unable to create new browser: code: 429: message: rate limit";
    await expect(runtime.open(null, "https://example.com/", {})).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("never logs the value typed into a field", async () => {
    const { runtime } = build({
      "https://example.com/login": {
        html: `<html><head><title>Login</title></head><body><form><input id="u" name="username"><input id="p" type="password"></form></body></html>`,
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runtime.open(null, "https://example.com/login", {});
      const typed = await runtime.type(null, { kind: "selector", value: "#p" }, "super-secret-password", { secret: true });
      expect(typed.typedCharacters).toBe("super-secret-password".length);
      expect(typed.valueLogged).toBe(false);
      const logged = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).not.toContain("super-secret-password");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("closes the session on demand", async () => {
    const { runtime, provider } = build({ "https://example.com/": { html: SIMPLE_PAGE } });
    await runtime.open(null, "https://example.com/", {});
    const closed = await runtime.close();
    expect(closed.closed).toBe(true);
    expect(provider.browsers[0].closed).toBe(true);
  });
});
