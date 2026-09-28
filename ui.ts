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

type UiEnv = { MCP_PUBLIC_ORIGIN?: string };

/**
 * Boot payload. All strings are escaped for embedding inside <script>: "<"
 * becomes \u003c so nothing can ever close the tag or start markup from data.
 */
function canonicalUiEndpoint(requestUrl?: string, env?: UiEnv): { endpoint: string; serverUrl: string } {
  const configured = String(env?.MCP_PUBLIC_ORIGIN ?? "").trim();
  const requestOrigin = requestUrl ? (() => { try { return new URL(requestUrl).origin; } catch { return ""; } })() : "";
  let origin = "";
  for (const candidate of [configured, requestOrigin]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if ((parsed.protocol === "https:" || (local && parsed.protocol === "http:")) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && (!parsed.pathname || parsed.pathname === "/")) {
        origin = parsed.origin;
        break;
      }
    } catch {
      // A bad configured origin is not reflected into this page. Use the request origin if valid.
    }
  }
  if (!origin) origin = MCP_SERVER_URL.replace(/\/mcp$/, "");
  const serverUrl = `${origin}/mcp`;
  const host = new URL(serverUrl).host;
  return { endpoint: `${host}/mcp`, serverUrl };
}

function bootPayload(serverUrl: string, endpoint: string): string {
  const json = JSON.stringify({
    version: VERSION,
    endpoint,
    serverUrl,
    connect: CONNECT_PICKER,
    clients: connectClientPayload(serverUrl),

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

function page(serverUrl: string, endpoint: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f7f8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0b0e">
<meta name="description" content="DEMO — execution infrastructure for AI agents. Public MCP tools need no login; protected Roblox and decision tools use per-tool OAuth.">
<title>DEMO — Execution infrastructure for AI agents</title>
<style>${UI_CSS}</style>
</head>
<body>
<div id="app"><noscript><main style="max-width:640px;margin:80px auto;padding:0 20px;font-family:ui-sans-serif,system-ui,sans-serif;color:#e7ebf1;background:#0a0b0e">
<h1 style="font-size:20px">DEMO — Execution infrastructure for AI agents</h1>
<p style="color:#98a2b0;line-height:1.6">This page renders live deployment status with a small inline script. JavaScript is disabled, so the status view cannot load — the Worker itself needs nothing from you: public tools at <code>/mcp</code> work without a login; protected tools use OAuth.</p>
</main></noscript></div>
<script>window.__DEMO_BOOT__=${bootPayload(serverUrl, endpoint)};</script>
<script>${APP_SCRIPT}</script>
</body>
</html>`;
}

export function demoUiHtml(requestUrl?: string, env?: UiEnv): string {
  const { endpoint, serverUrl } = canonicalUiEndpoint(requestUrl, env);
  return page(serverUrl, endpoint);
}

export function demoUi(requestUrl?: string, env?: UiEnv): Response {
  const { endpoint, serverUrl } = canonicalUiEndpoint(requestUrl, env);
  return new Response(page(serverUrl, endpoint), {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      ...uiSecurityHeaders(),
    },
  });
}
