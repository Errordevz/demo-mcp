import { describe, expect, it } from "vitest";
import { detectChallenge, HUMAN_STATUSES, isBlockingStatus } from "../src/browser/challenge.js";

describe("challenge detection", () => {
  it("reports normal pages as normal", () => {
    const verdict = detectChallenge({
      url: "https://example.com/article",
      title: "How to build things",
      text: "A long article about building things responsibly. ".repeat(10),
    });
    expect(verdict.status).toBe("normal");
    expect(verdict.requiresHuman).toBe(false);
  });

  it("detects Cloudflare's interstitial as a bot check", () => {
    const verdict = detectChallenge({
      url: "https://site.example/",
      title: "Just a moment...",
      text: "Checking your browser before accessing site.example. Please enable JavaScript and cookies to continue. Ray ID: abc",
      status: 403,
    });
    expect(["bot_check", "captcha"]).toContain(verdict.status);
    expect(verdict.requiresHuman).toBe(true);
    expect(verdict.confidence).toBeGreaterThan(0.5);
  });

  it("detects reCAPTCHA widgets and names the vendor", () => {
    const verdict = detectChallenge({
      url: "https://site.example/login",
      title: "Verify",
      text: "Please complete the reCAPTCHA below.",
      hasCaptchaWidget: true,
    });
    expect(verdict.status).toBe("captcha");
    expect(verdict.vendor).toBe("google-recaptcha");
  });

  it("detects hCaptcha, Turnstile, DataDome and Arkose", () => {
    for (const [snippet, vendor] of [
      ["Solve the h-captcha to continue", "hcaptcha"],
      ["cf-turnstile response is required", "cloudflare-turnstile"],
      ["Blocked by DataDome captcha-delivery.com", "datadome"],
      ["Arkose Labs funcaptcha challenge", "arkose"],
    ] as const) {
      const verdict = detectChallenge({ url: "https://x.example/", title: "Check", text: snippet });
      expect(verdict.status, snippet).toBe("captcha");
      expect(verdict.vendor, snippet).toBe(vendor);
    }
  });

  it("detects login walls", () => {
    const verdict = detectChallenge({
      url: "https://app.example.com/dashboard",
      title: "Sign in to continue",
      text: "You must be logged in to view this page.",
      hasPasswordField: true,
    });
    expect(verdict.status).toBe("login_required");
    expect(verdict.requiresHuman).toBe(true);
  });

  it("detects consent dialogs", () => {
    const verdict = detectChallenge({
      url: "https://news.example.com/",
      title: "News",
      text: "We use cookies to personalise content. Accept all cookies.",
      hasConsentBanner: true,
    });
    expect(verdict.status).toBe("consent_required");
    expect(verdict.recommendedAction).toMatch(/consent|pause/i);
  });

  it("detects access denied and missing pages", () => {
    const denied = detectChallenge({ url: "https://x.example/", title: "Access denied", text: "Error code: 1020. Access denied.", status: 403 });
    expect(["access_denied", "bot_check"]).toContain(denied.status);
    const missing = detectChallenge({ url: "https://x.example/nope", title: "Page not found", text: "This page isn't available.", status: 404 });
    expect(missing.status).toBe("unavailable");
    const error = detectChallenge({ url: "https://x.example/", title: "Error", text: "Something went wrong.", status: 500 });
    expect(error.status).toBe("unavailable");
  });

  it("detects pages that are still loading", () => {
    const verdict = detectChallenge({ url: "https://x.example/", title: "Loading…", text: "Loading", readyState: "loading", bodyTextLength: 20 });
    expect(verdict.status).toBe("loading");
    expect(verdict.requiresHuman).toBe(false);
  });

  it("does not flag ordinary pages that merely mention logging in", () => {
    const verdict = detectChallenge({
      url: "https://www.tiktok.com/@creator.one/video/7300000000000000001",
      title: "Creator One on TikTok",
      text: "Log in to follow the creator. ".repeat(20) + "This is a public video about cats. ".repeat(20),
      readyState: "complete",
    });
    expect(verdict.status).toBe("normal");
  });

  it("marks human statuses as blocking", () => {
    for (const status of HUMAN_STATUSES) {
      expect(isBlockingStatus(status)).toBe(true);
    }
    expect(isBlockingStatus("normal")).toBe(false);
  });
});
