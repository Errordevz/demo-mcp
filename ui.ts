/**
 * DEMO inspector UI — served at "/" by the platform entrypoint.
 *
 * One self-contained HTML document: no external requests, no cookies, no
 * telemetry, no login. The page fetches only same-origin Worker routes
 * (/health, /platform/stats, /capabilities/*, /oauth/roblox/*) and renders
 * what is genuinely available. The tool catalog inlined below is generated
 * from the real MCP tool registrations (scripts/generate-tool-catalog.mjs)
 * and pinned against DEMO_TOOL_NAMES by tests/tool-catalog.test.ts.
 *
 * The CSP (see uiSecurityHeaders) intentionally locks the page to inline
 * styles/scripts + same-origin connections; everything here is built for
 * that constraint — icons are inline SVG, fonts are system stacks, and the
 * "app" is a tiny vanilla-JS hash router, not a framework bundle.
 */

import { uiSecurityHeaders } from "./src/core/headers.js";
import { TOOL_CATALOG, TOOL_GROUPS } from "./src/ui/tool-catalog.js";
import { UI_CSS } from "./src/ui/styles.js";
import { APP_SCRIPT } from "./src/ui/app-script.js";
import {
  MCP_ENDPOINT,
  PROJECT,
  SECTIONS,
  CAPABILITY_CATEGORIES,
  MCP_COMMANDS,
  BROWSER_FLOW,
  VIDEO_STAGES,
  HONESTY_RULES,
  BUILTIN_SKILLS,
  SKILLS_TOOLS,
  API_ROUTES,
  PRIVACY_FACTS,
  ARCHITECTURE_TEXT,
  AVAILABILITY_HINTS,
} from "./src/ui/content.js";
import { CONNECT_PICKER, MCP_SERVER_URL, connectClientPayload } from "./src/ui/mcp-clients.js";

/** UI build stamp — safe to expose; contains no secret values. */
const VERSION = "0.9.0";

/**
 * Boot payload. All strings are escaped for embedding inside <script>: "<"
 * becomes \u003c so nothing can ever close the tag or start markup from data.
 */
function bootPayload(): string {
  const json = JSON.stringify({
    version: VERSION,
    endpoint: MCP_ENDPOINT,
    serverUrl: MCP_SERVER_URL,
    connect: CONNECT_PICKER,
    clients: connectClientPayload(),
    catalog: TOOL_CATALOG,
    groups: TOOL_GROUPS,
    data: {
      PROJECT,
      SECTIONS: [...SECTIONS],
      CAPABILITY_CATEGORIES: [...CAPABILITY_CATEGORIES],
      MCP_COMMANDS,
      BROWSER_FLOW,
      VIDEO_STAGES,
      HONESTY_RULES,
      BUILTIN_SKILLS,
      SKILLS_TOOLS,
      API_ROUTES,
      PRIVACY_FACTS,
      ARCHITECTURE_TEXT,
      AVAILABILITY_HINTS,
    },
  });
  return json.replace(/</gu, "\\u003c");
}

function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f7f8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0b0e">
<meta name="description" content="DEMO — execution infrastructure for AI agents. Browser, video, web, Roblox, skills and decision routing over MCP. No account required.">
<title>DEMO — Execution infrastructure for AI agents</title>
<style>${UI_CSS}</style>
</head>
<body>
<div id="app"><noscript><main style="max-width:640px;margin:80px auto;padding:0 20px;font-family:ui-sans-serif,system-ui,sans-serif;color:#e7ebf1;background:#0a0b0e">
<h1 style="font-size:20px">DEMO — Execution infrastructure for AI agents</h1>
<p style="color:#98a2b0;line-height:1.6">This page renders live deployment status with a small inline script. JavaScript is disabled, so the status view cannot load — the Worker itself needs nothing from you: the MCP endpoint at <code>/mcp</code> works without a login or account.</p>
</main></noscript></div>
<script>window.__DEMO_BOOT__=${bootPayload()};</script>
<script>${APP_SCRIPT}</script>
</body>
</html>`;
}

export function demoUiHtml(): string {
  return page();
}

export function demoUi(): Response {
  return new Response(page(), {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      ...uiSecurityHeaders(),
    },
  });
}
