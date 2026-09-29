/**
 * Inspector UI contract tests.
 *
 * Two layers:
 *  1. the served HTML must keep the pinned affordances (Roblox connect via a
 *     plain navigation, the Connect MCP dialog with the exact endpoint) while
 *     honouring user-credential guarantees: no token values, password inputs
 *     only for the DEMO account flows and only with hardened autocomplete;
 *  2. a jsdom smoke run boots the inline app against stubbed same-origin
 *     routes and verifies the shell renders live data, that navigation and
 *     the tool explorer work, and that the modal opens / copies / closes.
 */
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { demoUi, demoUiHtml } from "../ui.js";
import { MCP_ENDPOINT, SECTIONS } from "../src/ui/content.js";
import { TOOL_CATALOG } from "../src/ui/tool-catalog.js";

function jsonRoute(payload: unknown, ok = true, status = 200): unknown {
  return { ok, status, headers: { get: () => "application/json" }, text: async () => JSON.stringify(payload) };
}

const HEALTH = {
  ok: true,
  name: "DEMO",
  version: "9.9.9-test",
  status: "online",
  mcp: "/mcp",
  browser: true,
  browserSessions: true,
  screenshots: true,
  liveView: true,
  publicVideo: true,
  videoResolution: true,
  videoBytesRetrieval: true,
  videoFrames: true,
  videoArtifacts: true,
  decisionRoutingMode: "auto",
  // Deliberately the shape the Worker really sends: the flags are TOP-level.
  // (A nested `capabilities` object here is what let the UI render "Unavailable"
  // for a browser that /platform/stats reported as connected; see the
  // regression test in tests/audit-regressions.test.ts.)
  videoAudioExtraction: true,
  videoTranscription: true,
  videoVisionAnalysis: true,
  robloxOAuthConfigured: true,
};

const STATS = {
  ok: true,
  name: "DEMO",
  version: "9.9.9-test",
  status: "online",
  generatedAt: "2026-09-25T12:00:00.000Z",
  uptimeSeconds: 95,
  requestCountSinceIsolateStart: 3,
  toolCount: TOOL_CATALOG.length,
  capabilities: {
    browser: true,
    browserSessions: true,
    screenshots: true,
    liveView: true,
    humanHandoff: true,
    videoFrames: true,
    publicVideo: true,
    expanded: { git: true, internetArchive: true, webMonitor: true, webResearch: true },
    youtube: { available: false, tools: [], scope: "public_only", noOAuth: true },
    robloxOAuth: { configured: false, storage: "memory", tokenEncryption: "none" },
    jevDecisionEngine: { available: true, enabled: true, credentialConfigured: true, model: "jev-latest", reviewThreshold: 0.5, acceptThreshold: 0.7 },
    layaDecisionProvider: { available: false, enabled: false, configured: false, credentialConfigured: false, model: "laya-latest", endpointHost: null, routingMode: "auto", reason: "Laya is not configured on this Worker." },
  },
  connections: [
    { name: "DEMO MCP", type: "Execution Worker", connected: true },
    { name: "Browser", type: "Cloudflare Browser Run", connected: true },
  ],
  endpoints: { mcp: "/mcp", health: "/health", tools: "/tools" },
  telemetry: { scope: "worker-isolate", containsSecrets: false, containsUserContent: false },
};

const VIDEO_REPORT = {
  schema: "demo.video-capabilities/1",
  supportedPlatforms: [
    { platform: "generic", shortLinks: false, directStreamDiscovery: true, frameDecoding: true, notes: "Direct .mp4/.webm URLs are probed with HEAD and fetched with verified content-type and magic bytes." },
  ],
  providers: [{ id: "cloudflare-r2", configured: true, enables: "Temporary expiring storage.", configureWith: "r2_buckets" }],
  limits: { maxDownloadMb: 50, maxDurationSeconds: 600, maxFrames: 8, audioMaxSeconds: 300, rateLimitPerMinute: 12, artifactTtlSeconds: 3600 },
};

const EXPANDED_REPORT = {
  schema: 1,
  version: "9.9.9-test",
  git: { publicOnly: true, requiresApiKey: false, supportedHosts: "any", modes: ["info"], maxPackMb: 20, rateLimitPerMinute: 6 },
  internetArchive: { available: true, apiKeyRequired: false, endpoints: ["a", "b"] },
  feeds: { available: true, formats: ["RSS 2.x", "Atom 1.0"], apiKeyRequired: false },
  pdf: { available: true, ocr: false, ocrProvider: null, scannedDetection: true, tables: "heuristic" },
  images: { available: true, vision: false, visionProvider: null, modes: ["info"] },
  web: { extract: true, diff: true, monitor: true, snapshots: true, snapshotStorage: "r2", scheduledChecks: false, screenshotDiff: true },
  openapi: { available: true, formats: ["OpenAPI 3.x"], callsDiscoveredApis: false },
  network: { dns: true, http: true, tls: "handshake info", scanner: false },
  utilities: { jsonSchema: true, jwt: "decode", cron: true, textDiff: true, externalCalls: false },
  research: { available: true, provenance: "source URL + retrieval time per finding", humanHandoff: "pause via browser tools" },
  urlSafety: { available: true, usesSharedSsrfGuard: true },
  limits: {},
  security: ["ssrf"],
};

function routes(): Record<string, () => unknown> {
  return {
    "/health": () => jsonRoute(HEALTH),
    "/platform/stats": () => jsonRoute(STATS),
    "/oauth/roblox/status": () => jsonRoute({ error: "not_configured", message: "Roblox OAuth is not configured on this Worker.", hint: "Add ROBLOX_CLIENT_ID and the ROBLOX_CLIENT_SECRET secret." }, false, 503),
    "/oauth/roblox/logout": () => jsonRoute({ ok: true }),
    "/capabilities/video": () => jsonRoute(VIDEO_REPORT),
    "/capabilities/expanded": () => jsonRoute(EXPANDED_REPORT),
  };
}

function bootDom(map: Record<string, () => unknown>): JSDOM {
  const html = demoUiHtml();
  return new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://demo.test/",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = ((input: RequestInfo | URL) => {
        const path = String(input).split("?")[0];
        const factory = map[path];
        return Promise.resolve(factory ? factory() : jsonRoute({ error: "nope" }, false, 404));
      }) as unknown as typeof window.fetch;
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    },
  });
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("inspector UI — served document contract", () => {
  const html = demoUiHtml();

  it("keeps the pinned Roblox affordances and user-credential guarantees", () => {
    expect(html).toContain("Connect Roblox account");
    expect(html).toContain("/oauth/roblox/link");
    expect(html).toContain("/oauth/roblox/status");
    expect(html).toContain("/oauth/roblox/logout");
    expect(html).toContain("Disconnect");
    // No OAuth/OIDC token material is ever rendered into the page.
    expect(html).not.toMatch(/(access|refresh)[_-]?token\s*[:=]/i);
    // DEMO account password inputs exist (account system) but always carry
    // hardened autocomplete semantics — never a bare password autofill.
    expect(html).not.toMatch(/autocomplete=["']?password/i);
    for (const input of html.match(/<input[^>]*type="password"[^>]*>/g) ?? []) {
      expect(input).toMatch(/autocomplete="(current|new)-password"/);
    }
  });

  it("surfaces the Connect MCP dialog with the exact public endpoint and no login", () => {
    expect(MCP_ENDPOINT).toBe("demo-mcp.amidevz.workers.dev/mcp");
    expect(html).toContain(MCP_ENDPOINT);
    expect(html).toContain(`https://${MCP_ENDPOINT}`);
    expect(html).toContain("Connect MCP");
    expect(html).toContain("Connect DEMO");
    expect(html).toContain("Public tools stay login-free; protected tools use OAuth when supported.");
    expect(html).toContain("Public tools need no login.");
    expect(html).toContain("Mixed Authentication · per-tool OAuth");
    expect(html).toContain("No live ChatGPT connection was exercised");
    expect(html).toContain("Copied!");
    expect(html).toContain("It does not connect automatically or prefill this server.");
    // No invented client URL schemes, and no fabricated connection praise.
    expect(html).not.toContain('href="chatgpt://');
    expect(html).not.toContain('href="claude://');
    expect(html).not.toContain('href="claude-cli://');
    expect(html).not.toMatch(/connected successfully|connection succeeded|installation complete/i);
  });

  it("advertises the no-login stance and the full navigation", () => {
    for (const section of SECTIONS) {
      expect(html, `nav section ${section.id}`).toContain(`"${section.id}"`);
    }
    expect(html).toContain("Public tools · no login");
  });

  it("serves safe headers on the UI response", async () => {
    const response = demoUi();
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("https:");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("contains no secret values or env-var assignments", () => {
    expect(html).not.toMatch(/(ROBLOX_CLIENT_SECRET|ROBLOX_TOKEN_KEY|TYPESAFE_API_KEY|LAYA_API_KEY|YOUTUBE_API_KEY)\s*[:=]\s*["'][^"']{8,}/);
    expect(html).not.toContain("DEMO_API_KEY");
  });
});

describe("inspector UI — rendered against stub routes", () => {
  it("boots, renders live data and wires the primary interactions", async () => {
    const dom = bootDom(routes());
    await flush();
    const doc = dom.window.document;

    // Shell + live overview data.
    expect(doc.querySelector(".nav a[aria-current=\"page\"]")?.textContent).toContain("Overview");
    expect(doc.querySelector(".hero h1")?.textContent).toContain("Execution infrastructure for AI agents");
    expect(doc.getElementById("view")?.textContent).toContain("Public tools · no login");
    expect(doc.getElementById("view")?.textContent).toContain("9.9.9-test");
    expect(doc.querySelector(".foot")?.textContent).toContain(`${TOOL_CATALOG.length} tools`);

    // Connect MCP: picker → verified handoff → manual fallback → copy → Esc.
    (doc.querySelector('[data-act="connect-open"]') as HTMLElement | null)?.click();
    await flush();
    const overlay = doc.getElementById("connect-overlay") as (HTMLElement & { hidden: boolean }) | null;
    expect(overlay && !overlay.hidden).toBe(true);
    expect(doc.getElementById("connect-title")?.textContent).toBe("Connect DEMO");
    expect(doc.getElementById("connect-sub")?.textContent).toBe("Choose a client. Public tools stay login-free; protected tools use OAuth when supported.");
    expect(doc.querySelectorAll(".prov").length).toBe(6);
    const providers = [...doc.querySelectorAll(".prov")] as HTMLElement[];
    expect(doc.activeElement).toBe(providers[0]);
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(doc.activeElement).toBe(providers[1]);
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(doc.activeElement).toBe(providers[0]);
    expect(doc.getElementById("mcp-endpoint")?.textContent).toBe("https://demo-mcp.amidevz.workers.dev/mcp");
    (doc.getElementById("copy-endpoint") as HTMLElement | null)?.click();
    await flush();
    expect(doc.getElementById("copy-endpoint")?.textContent).toContain("Copied!");

    const pick = (id: string) => {
      (doc.querySelector(`.prov[data-client="${id}"]`) as HTMLElement).click();
    };
    pick("chatgpt");
    expect(doc.getElementById("connect-title")?.textContent).toBe("Connect DEMO to ChatGPT?");
    expect(doc.getElementById("connect-sub")?.textContent).toBe("You're about to connect DEMO as a remote MCP server in ChatGPT.");
    const chatgpt = doc.getElementById("connect-primary");
    expect(chatgpt?.getAttribute("href")).toBe("https://chatgpt.com/plugins");
    expect(chatgpt?.getAttribute("target")).toBe("_blank");
    expect(chatgpt?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(doc.getElementById("connect-overlay")?.textContent).not.toMatch(/confirmation dialog will appear/i);
    (doc.querySelector('[data-act="connect-back"]') as HTMLElement).click();
    expect(doc.getElementById("connect-title")?.textContent).toBe("Connect DEMO");

    pick("claude");
    const claudeHref = doc.getElementById("connect-primary")?.getAttribute("href") ?? "";
    expect(claudeHref).toContain("https://claude.ai/customize/connectors?");
    expect(claudeHref).toContain("modal=add-custom-connector");
    expect(claudeHref).toContain("connectorUrl=https%3A%2F%2Fdemo-mcp.amidevz.workers.dev%2Fmcp");
    expect(doc.getElementById("connect-primary")?.getAttribute("target")).toBe("_blank");
    (doc.querySelector('[data-act="connect-back"]') as HTMLElement).click();

    pick("cursor");
    const cursor = doc.getElementById("connect-primary");
    expect(cursor?.getAttribute("href")).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?/);
    expect(cursor?.hasAttribute("target")).toBe(false);
    expect(cursor?.hasAttribute("rel")).toBe(false);
    (doc.querySelector('[data-act="connect-back"]') as HTMLElement).click();

    pick("vscode");
    const vscode = doc.getElementById("connect-primary");
    expect(vscode?.getAttribute("href")).toMatch(/^vscode:mcp\/install\?/);
    expect(vscode?.hasAttribute("target")).toBe(false);
    const insiders = [...doc.querySelectorAll("a")].find((a) => (a.getAttribute("href") ?? "").startsWith("vscode-insiders:"));
    expect(insiders?.hasAttribute("target")).toBe(false);
    (doc.querySelector('[data-act="connect-back"]') as HTMLElement).click();

    pick("other");
    expect(doc.getElementById("connect-title")?.textContent).toBe("Connect DEMO to your MCP-compatible client.");
    expect(doc.getElementById("mcp-endpoint")?.textContent).toBe("https://demo-mcp.amidevz.workers.dev/mcp");
    expect(doc.getElementById("copy-endpoint")?.textContent).toContain("Copy endpoint");
    expect(doc.getElementById("connect-overlay")?.textContent).not.toMatch(/connected successfully|connection succeeded/i);

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(overlay?.hidden).toBe(true);

    // Tools explorer: rows for every catalog entry, then a live search filter.
    dom.window.location.hash = "#/tools";
    await flush();
    expect(doc.querySelectorAll("#view .trow").length).toBe(TOOL_CATALOG.length);
    const search = doc.getElementById("tool-search") as HTMLInputElement | null;
    expect(search).toBeTruthy();
    search!.value = "browser_open";
    search!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flush();
    expect(doc.querySelectorAll("#view .trow").length).toBe(1);
    // Expand the single tool — its real description must be visible.
    (doc.querySelector("#view .trow") as HTMLElement).click();
    await flush();
    expect(doc.querySelector(".tdetail")?.textContent).toContain("Open a URL in DEMO's Cloudflare browser session");

    // Capabilities route renders the same explorer with live availability.
    dom.window.location.hash = "#/capabilities";
    await flush();
    // Clear the persisted search to see the full explorer again.
    const search2 = doc.getElementById("tool-search") as HTMLInputElement | null;
    if (search2 && search2.value) {
      search2.value = "";
      search2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    }
    expect(doc.querySelectorAll("#view .trow").length).toBe(TOOL_CATALOG.length);
    expect(doc.querySelector(".nav a[aria-current=\"page\"]")?.textContent).toContain("Capabilities");

    // Status route shows live deployment state honestly.
    dom.window.location.hash = "#/status";
    await flush();
    const statusText = doc.getElementById("view")?.textContent ?? "";
    expect(statusText).toContain("System status");
    expect(statusText).toContain("9.9.9-test");
    expect(statusText).toContain("/mcp");

    // Unknown routes get a polished 404, not a blank page.
    dom.window.location.hash = "#/does-not-exist";
    await flush();
    const missing = doc.getElementById("view")?.textContent ?? "";
    expect(missing).toContain("Page not found");
    expect(missing).toContain("That route doesn't exist.");
    expect(missing).toContain("Back to DEMO");

    // Roblox state degrades safely and never shows a login form. An anonymous
    // visitor is told to sign in: the Roblox status route is private and answers
    // 401 by design, so the page reports the local fact instead of firing a
    // request that can only fail (and logging a console error).
    dom.window.location.hash = "#/roblox";
    await flush();
    const robloxText = doc.getElementById("view")?.textContent ?? "";
    expect(robloxText).toContain("DEMO sign-in required");
    expect(robloxText).toContain("Separate approvals");
    expect(robloxText).toContain("Sign in to your DEMO account (Account section)");
    expect(doc.querySelector("#view form")).toBeNull();

    // Enabled-but-unlinked: the connect affordance appears as a button.
    const linked = { ...routes(), "/account/session": () => jsonRoute({
      ok: true, signedIn: true, accountsAvailable: true,
      account: { id: "usr_test", email: "stub@demo.test", displayName: "Stub", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" },
    }), "/oauth/roblox/status": () => jsonRoute({
      connected: false,
      configuration: { enabled: true, clientIdConfigured: true, clientSecretConfigured: true, redirectUri: "https://demo.test/oauth/roblox/callback", requestedScopes: ["openid", "profile"], storage: "durable-object", tokenEncryption: "aes-gcm-256", pkce: "S256" },
      endpoints: { start: "/oauth/roblox/start", callback: "/oauth/roblox/callback", logout: "/oauth/roblox/logout" },
      security: { stateValidation: "single-use, expiring, browser-bound", cookieFlags: "HttpOnly; Secure; SameSite=Lax" },
    }) };
    const dom2 = bootDom(linked);
    await flush();
    dom2.window.location.hash = "#/roblox";
    await flush();
    const robloxText2 = dom2.window.document.getElementById("view")?.textContent ?? "";
    expect(robloxText2).toContain("Not connected");
    expect(robloxText2).toContain("Connect Roblox account");
    dom2.window.close();

    // Routing page reports presence-only configuration.
    dom.window.location.hash = "#/routing";
    await flush();
    expect(doc.getElementById("view")?.textContent).toContain("secret value hidden");

    // Video and research lazy-loads come from the stubbed capability routes.
    dom.window.location.hash = "#/video";
    await flush();
    expect(doc.getElementById("view")?.textContent).toContain("demo.video-capabilities/1");
    dom.window.location.hash = "#/research";
    await flush();
    expect(doc.getElementById("view")?.textContent).toContain("source URL + retrieval time per finding");

    // A command-palette search finds a real section.
    (doc.querySelector('[data-act="palette-open"]') as HTMLElement).click();
    await flush();
    const palette = doc.getElementById("palette-input") as HTMLInputElement;
    palette.value = "skills";
    palette.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flush();
    expect(doc.querySelector(".p-item .p-lbl")?.textContent).toBe("Skills");
    dom.window.close();
  });

  it("degrades to an honest error state when telemetry is unreachable", async () => {
    const dom = bootDom({});
    await flush();
    const view = dom.window.document.getElementById("view")?.textContent ?? "";
    expect(view).toContain("telemetry unavailable");
    expect(view).toContain("Try again or inspect deployment status");
    expect(view).toContain("GET /platform/stats");
    dom.window.close();
  });
});
