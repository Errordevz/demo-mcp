/**
 * Regression tests for defects confirmed against the deployed Worker on
 * 2026-09-29 (`https://demo-mcp.amidevz.workers.dev`). Each block names the
 * live evidence that produced it, so the test is a reproduction, not a guess.
 *
 *  1. GET /favicon.ico and /apple-touch-icon.png answered 404 on every visit.
 *  2. /platform/stats reported `uptimeSeconds ≈ 1_790_703_000` (~57 years)
 *     because `Date.now()` is not a wall clock while workerd evaluates modules.
 *  3. `caps()` read `health.capabilities`, which /health does not send (the
 *     flags are top-level), so the Browser capability rendered "Unavailable"
 *     on a deployment whose own telemetry said it was available.
 *  4. The page fired a private request (GET /oauth/roblox/status) for anonymous
 *     visitors, which answers 401 by design — a guaranteed console error.
 *  5. `TYPESAFE_REVIEW_THRESHOLD=0.5` was floored to `0`, silently disabling the
 *     documented review policy; the live report advertised `review: 0`.
 *  6. Every guarded fetch to DEMO's own origin returned `error code: 1042`.
 *  7. The DNS half of the SSRF guard defaulted to fail-open.
 */
import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import platform from "../platform-entry.js";
import { demoUiHtml } from "../ui.js";
import { appleTouchIconRoute, faviconRoute, iconAssets } from "../src/ui/icons.js";
import { checkUrl, checkUrlSync } from "../src/core/url-guard.js";
import { createSsrfGuard, dnsFailOpenFor, selfOrigins } from "../src/core/guarded-fetch.js";
import { resolveJevConfig } from "../src/jev/config.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

/* ------------------------------------------------------------------ 1. icons */

describe("brand icons", () => {
  it("serves a real PNG at /favicon.ico and /apple-touch-icon.png instead of 404", async () => {
    for (const path of ["/favicon.ico", "/favicon.png", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
      const response = await platform.fetch(new Request(`https://demo.test${path}`), {} as never, CTX);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("image/png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      // PNG magic number — a browser must get an image, not HTML.
      expect([...bytes.slice(0, 4)], path).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(bytes.byteLength, path).toBeGreaterThan(100);
      expect(response.headers.get("cache-control"), path).toContain("max-age");
    }
  });

  it("serves the SVG mark and references every icon from the document", async () => {
    const svg = await platform.fetch(new Request("https://demo.test/favicon.svg"), {} as never, CTX);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain("<svg");

    const html = demoUiHtml("https://demo-mcp.amidevz.workers.dev/", {});
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="icon" href="/favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  });

  it("exposes the icons as CSP-safe data URLs for the head", () => {
    // The page's CSP forbids external resources; the head must therefore not
    // need a network request to paint a placeholder icon.
    expect(iconAssets.faviconPngDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(iconAssets.appleTouchDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    // Derived helpers stay reachable for the route table.
    expect(typeof faviconRoute).toBe("function");
    expect(typeof appleTouchIconRoute).toBe("function");
  });
});

/* ------------------------------------------------------------- 2. isolate age */

describe("isolate telemetry", () => {
  it("reports a plausible isolate age, never a 1970-anchored value", async () => {
    const response = await platform.fetch(new Request("https://demo.test/platform/stats"), {} as never, CTX);
    const stats = (await response.json()) as { uptimeSeconds: number; generatedAt: string };
    expect(Number.isFinite(stats.uptimeSeconds)).toBe(true);
    expect(stats.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Reproduced live at ~1.79e9 seconds (57 years). Anything near that is the bug.
    expect(stats.uptimeSeconds).toBeLessThan(90 * 24 * 3600);
    // The reading must also be consistent with the timestamp next to it.
    const ageFromNow = Math.abs(Date.now() - Date.parse(stats.generatedAt)) / 1000;
    expect(ageFromNow).toBeLessThan(60);
  });

  it("anchors the age on the isolate's first request, not on the first stats call", async () => {
    // A real isolate serves many requests before anything asks for telemetry,
    // and workerd hands module scope a zero clock. Reproduce both conditions:
    // load a FRESH copy of the entry point while the clock reads 1970 (so the
    // module-level timestamp is unusable, exactly as on the deployment), then
    // serve a non-telemetry request and only afterwards read the age.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      vi.resetModules();
      const fresh = (await import("../platform-entry.js")) as { default: typeof platform };
      vi.setSystemTime(new Date(10_000));
      await fresh.default.fetch(new Request("https://demo.test/health"), {} as never, CTX);
      vi.setSystemTime(new Date(160_000));
      const stats = (await (await fresh.default.fetch(new Request("https://demo.test/platform/stats"), {} as never, CTX)).json()) as { uptimeSeconds: number; requestCountSinceIsolateStart: number };
      expect(stats.requestCountSinceIsolateStart).toBe(2);
      expect(stats.uptimeSeconds).toBe(150);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

});

/* ------------------------------------------------------- 3/4. UI status truth */

function jsonResponse(payload: unknown, status = 200): unknown {
  return {
    ok: status < 400,
    status,
    headers: { get: (key: string) => (key.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(payload),
  };
}

/** The real GET /health body, captured from the deployment on 2026-09-29 (trimmed). */
const LIVE_HEALTH = {
  ok: true,
  name: "DEMO",
  version: "1.0.0",
  status: "online",
  mcp: "/mcp",
  browser: true,
  browserWatching: true,
  browserSessions: true,
  screenshots: true,
  screenshotLinks: true,
  liveView: true,
  publicVideo: true,
  videoResolution: true,
  videoBytesRetrieval: true,
  videoFrames: true,
  videoAudioExtraction: true,
  videoTranscription: true,
  videoVisionAnalysis: true,
  videoArtifacts: true,
  toolCount: 90,
};

const LIVE_STATS = {
  ok: true,
  status: "online",
  version: "1.0.0",
  generatedAt: "2026-09-29T17:25:51.615Z",
  uptimeSeconds: 120,
  requestCountSinceIsolateStart: 1,
  toolCount: 90,
  capabilities: {
    browser: true,
    browserSessions: true,
    screenshots: true,
    liveView: true,
    humanHandoff: true,
    videoFrames: true,
    publicVideo: true,
    videoArtifacts: true,
    expanded: { git: true, internetArchive: true, webMonitor: true, webResearch: true },
    youtube: { available: true },
    jevDecisionEngine: { available: true, model: "jev-latest" },
    layaDecisionProvider: { available: true, endpointHost: "api.impossibl.com" },
  },
  connections: [],
  endpoints: {},
};

/** Rendered text only: the inline <script> inside <body> is not part of the UI. */
function renderedText(doc: Document): string {
  const parts: string[] = [];
  for (const id of ["view", "foot", "header"]) {
    const node = doc.getElementById(id);
    if (node) parts.push(node.textContent ?? "");
  }
  return parts.join("\n");
}

async function bootUi(overrides: { signedIn?: boolean; statusResponse?: () => unknown } = {}) {
  const requests: string[] = [];
  const errors: string[] = [];
  const html = demoUiHtml("https://demo-mcp.amidevz.workers.dev/", {});
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://demo-mcp.amidevz.workers.dev/",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = ((input: RequestInfo | URL) => {
        const path = String(input).split("?")[0];
        requests.push(path);
        if (path === "/health") return Promise.resolve(jsonResponse(LIVE_HEALTH));
        if (path === "/platform/stats") return Promise.resolve(jsonResponse(LIVE_STATS));
        if (path === "/account/session") {
          return Promise.resolve(jsonResponse(overrides.signedIn
            ? { ok: true, signedIn: true, accountsAvailable: true, account: { id: "u1", email: "a@b.test", emailVerified: true } }
            : { ok: true, signedIn: false, accountsAvailable: true }));
        }
        if (path === "/oauth/roblox/status") {
          return Promise.resolve(overrides.statusResponse
            ? overrides.statusResponse()
            : jsonResponse({ error: "unauthenticated", message: "A signed-in DEMO identity is required for this Roblox route." }, 401));
        }
        return Promise.resolve(jsonResponse({}, 404));
      }) as unknown as typeof window.fetch;
      window.addEventListener("error", (event) => errors.push(String(event.message)));
    },
  });
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return { dom, doc: dom.window.document, win: dom.window, requests, errors };
}

describe("inspector UI status truth", () => {
  it("renders availability from the flat /health flags the Worker actually sends", async () => {
    const { doc, requests } = await bootUi();
    expect(requests).toContain("/health");
    const text = renderedText(doc);
    // Before the fix the Browser capability rendered "Unavailable" here even
    // though the live /health and /platform/stats both reported it available.
    expect(text).not.toContain("Unavailable");
    expect(text).toMatch(/Operational/);
    // The Browser capability card must be the good one, not merely absent.
    const cards = [...doc.querySelectorAll(".cat")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
    const browserCard = cards.find((entry) => entry.startsWith("Browser"));
    expect(browserCard, "the Browser capability card is rendered").toBeTruthy();
    expect(browserCard ?? "").toMatch(/Operational/);
  });

  it("does not request any private account or OAuth status route on boot", async () => {
    const { requests, doc } = await bootUi();
    expect(requests).toEqual(["/health", "/platform/stats"]);
    expect(renderedText(doc)).toContain("Public tools · no login");
  });
});

/* ---------------------------------------------------- 5. decision thresholds */

describe("Jev threshold parsing", () => {
  it("keeps fractional thresholds instead of flooring them to 0", () => {
    const config = resolveJevConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_REVIEW_THRESHOLD: "0.5", TYPESAFE_ACCEPT_THRESHOLD: "0.7" });
    expect(config.reviewThreshold).toBe(0.5);
    expect(config.acceptThreshold).toBe(0.7);
  });

  it("still clamps, defaults and orders the thresholds", () => {
    const clamped = resolveJevConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_REVIEW_THRESHOLD: "5", TYPESAFE_ACCEPT_THRESHOLD: "0.1" });
    expect(clamped.reviewThreshold).toBeLessThanOrEqual(0.99);
    expect(clamped.acceptThreshold).toBeGreaterThanOrEqual(clamped.reviewThreshold);
    const fallback = resolveJevConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_REVIEW_THRESHOLD: "not-a-number" });
    expect(fallback.reviewThreshold).toBe(0.5);
  });
});

/* ----------------------------------------------------------- 6/7. SSRF policy */

describe("self-origin and DNS fail-closed policy", () => {
  it("names DEMO's own public origin as unreachable from inside the Worker", () => {
    expect(selfOrigins({ MCP_PUBLIC_ORIGIN: "https://demo-mcp.amidevz.workers.dev" })).toEqual(["https://demo-mcp.amidevz.workers.dev"]);
    expect(selfOrigins({})).toEqual([]);
    expect(selfOrigins({ MCP_PUBLIC_ORIGIN: "not a url" })).toEqual([]);
  });

  it("denies a self-fetch with the 1042 explanation instead of an opaque edge error", () => {
    const verdict = checkUrlSync("https://demo-mcp.amidevz.workers.dev/health", { blockedOrigins: ["https://demo-mcp.amidevz.workers.dev"] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("blocked_url");
      expect(verdict.reason).toContain("1042");
      expect(verdict.reason).toContain("/health");
    }
    // A different host on the same platform is untouched.
    const other = checkUrlSync("https://example.com/health", { blockedOrigins: ["https://demo-mcp.amidevz.workers.dev"] });
    expect(other.ok).toBe(true);
    // Case/port normalisation cannot smuggle the origin past the check.
    const shouty = checkUrlSync("https://DEMO-MCP.AMIDEVZ.WORKERS.DEV/health", { blockedOrigins: ["https://demo-mcp.amidevz.workers.dev"] });
    expect(shouty.ok).toBe(false);
  });

  it("fails the DNS step closed by default and opens only on an explicit opt-in", async () => {
    const unreachable = { resolve: async () => { throw new Error("resolver unreachable"); } };
    const closed = await checkUrl("https://example.test/page", { dns: unreachable });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.reason).toContain("DNS lookup failed");

    const open = await checkUrl("https://example.test/page", { dns: unreachable, dnsFailOpen: true });
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.warnings).toContain("dns-unverified");

    // Deployment policy: absent or anything but `true` means fail closed.
    expect(dnsFailOpenFor({})).toBe(false);
    expect(dnsFailOpenFor({ SSRF_DNS_FAIL_OPEN: "false" })).toBe(false);
    expect(dnsFailOpenFor({ SSRF_DNS_FAIL_OPEN: "true" })).toBe(true);
  });

  it("applies both rules through the shared guard every capability uses", async () => {
    const guard = createSsrfGuard({ MCP_PUBLIC_ORIGIN: "https://demo-mcp.amidevz.workers.dev" });
    await expect(guard("https://demo-mcp.amidevz.workers.dev/tools")).rejects.toThrow(/1042/);
    await expect(guard("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private, loopback, link-local or reserved/);
    await expect(guard("http://localhost:8787/mcp")).rejects.toThrow(/internal or metadata/);
    // A public HTTPS target still passes when the DNS half is switched off for
    // the test (no resolver is reachable from unit tests), and the static rules
    // keep applying: this is the same guard, only the resolver is stubbed out.
    const noDns = createSsrfGuard({ MCP_PUBLIC_ORIGIN: "https://demo-mcp.amidevz.workers.dev", SSRF_DNS_CHECK: "false" });
    await expect(noDns("https://example.com/")).resolves.toBe("https://example.com/");
    await expect(noDns("http://169.254.169.254/")).rejects.toThrow(/reserved/);
  });
});
