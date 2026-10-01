/**
 * UI smoke tests: render the real single-page app (ui.ts + app-script.ts) in
 * jsdom with stubbed same-origin fetches, and verify the header, theme
 * toggle, and the Connect MCP platform grid. The app's CSP constraint is
 * exercised implicitly — jsdom runs the same inline scripts the browser would.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { demoUiHtml } from "../ui.js";

const NAV_PRIMARY = ["Overview", "Capabilities", "Status", "Browser", "Video", "Research", "Routing", "Skills", "About"];

function stubFetchScript() {
  return `<script>
    window.__fetchCalls = [];
    window.__requests = [];
    window.fetch = function (path, init) {
      var p = String(path);
      window.__fetchCalls.push(p);
      window.__requests.push({ path: p, method: (init && init.method) || "GET", body: (init && init.body) || null });
      var j = { ok: true };
      if (String(path).indexOf("/platform/stats") === 0) j = { status: "online", version: "9.9.9-test", toolCount: 90, generatedAt: "2026-09-28T00:00:00.000Z", uptimeSeconds: 42, requestCountSinceIsolateStart: 7, endpoints: { mcp: "/mcp" }, capabilities: {}, connections: [] };
      else if (String(path).indexOf("/health") === 0) j = { ok: true, status: "online", version: "9.9.9-test", browser: false, browserSessions: false, screenshots: false, liveView: false, videoFrames: false, videoBytesRetrieval: false, videoTranscription: false, videoVisionAnalysis: false, videoArtifacts: false, publicVideo: true, videoResolution: true, toolCount: 90 };
      else if (String(path).indexOf("/capabilities/") === 0) j = { ok: true, supportedPlatforms: [], providers: [], limits: {} };
      var body = JSON.stringify(j);
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: function (k) { return k === "content-type" ? "application/json" : null; } },
        text: function () { return Promise.resolve(body); },
        json: function () { return Promise.resolve(j); }
      });
    };
  </script>`;
}

async function buildApp(options: { hash?: string } = {}) {
  let html = demoUiHtml("https://demo-mcp.amidevz.workers.dev/", {});
  html = html.replace("</head>", stubFetchScript() + "</head>");
  const dom = new JSDOM(html, {
    url: "https://demo-mcp.amidevz.workers.dev/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  await until(() => !!win.document.querySelector("#theme-btn") && !!win.document.querySelector("#view"));
  if (options.hash) {
    win.location.hash = options.hash;
    await settle();
  }
  return { dom, win };
}

function until(fn: () => boolean, tries = 120): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      i++;
      if (fn() || i > tries) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function settle() {
  await new Promise((r) => setTimeout(r, 120));
}

describe("DEMO UI shell", () => {
  it("renders the header with all primary nav sections, theme toggle, and connect actions", async () => {
    const { win, dom } = await buildApp();
    const nav = win.document.querySelectorAll("nav.nav a");
    const labels = Array.from(nav).map((a) => a.textContent?.trim() ?? "");
    for (const wanted of NAV_PRIMARY) expect(labels).toContain(wanted);
    expect(labels).not.toContain("Roblox");
    expect(win.document.querySelector("#theme-btn")).toBeTruthy();
    expect(win.document.querySelector("#account-btn")).toBeNull();
    expect(win.document.querySelector('[data-act="connect-open"]')?.textContent).toContain("Connect MCP");
    dom.window.close();
  });

  it("cycles theme through system → light → dark and persists to storage + attribute", async () => {
    const { win, dom } = await buildApp();
    const root = win.document.documentElement;
    const btn = win.document.querySelector("#theme-btn") as HTMLButtonElement;
    expect(root.hasAttribute("data-theme")).toBe(false);
    btn.click();
    await settle();
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(win.localStorage.getItem("demo_theme_v1")).toBe("light");
    btn.click();
    await settle();
    expect(root.getAttribute("data-theme")).toBe("dark");
    btn.click();
    await settle();
    expect(root.hasAttribute("data-theme")).toBe(false);
    dom.window.close();
  });

  it("renders the Connect MCP modal with five platform cards and inline SVG logos", async () => {
    const { win, dom } = await buildApp();
    (win.document.querySelector('[data-act="connect-open"]') as HTMLButtonElement).click();
    await settle();
    const overlay = win.document.querySelector("#connect-overlay") as HTMLElement;
    expect(overlay.hidden).toBe(false);
    const cards = overlay.querySelectorAll(".plat-grid .plat-card");
    expect(cards.length).toBe(5);
    const names = Array.from(cards).map((c) => c.querySelector(".plat-name")?.textContent ?? "");
    expect(names.join(" ")).toContain("ChatGPT");
    expect(names.join(" ")).toContain("Claude");
    expect(names.join(" ")).toContain("Cursor");
    expect(names.join(" ")).toContain("Claude Code");
    expect(Array.from(cards).some((c) => c.querySelector(".plat-logo svg"))).toBe(true);
    (cards[0] as HTMLButtonElement).click();
    await settle();
    expect(overlay.querySelector(".plat-detail-head")).toBeTruthy();
    expect(overlay.textContent).toContain("DEMO MCP endpoint");
    dom.window.close();
  });
});
