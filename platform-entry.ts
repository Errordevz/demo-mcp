import demoWorker from "./index";
import { demoUi } from "./ui";

type Env = {
  DEMO_PLATFORM_ORIGIN?: string;
  DEMO_API_KEY?: string;
  BROWSER?: unknown;
  COMPOSIO_API_KEY?: string;
};

const VERSION = "0.4.0";
const DEFAULT_PLATFORM_ORIGIN = "https://demo-platform.pages.dev";
const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";
const LOCAL_ORIGINS = new Set(["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]);
const startedAt = Date.now();
let requestCount = 0;

function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  const configured = (env.DEMO_PLATFORM_ORIGIN || DEFAULT_PLATFORM_ORIGIN).split(",").map((value) => value.trim()).filter(Boolean);
  if (configured.includes(origin) || LOCAL_ORIGINS.has(origin)) return origin;
  return null;
}

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = allowedOrigin(origin, env);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (allowed) headers["Access-Control-Allow-Origin"] = allowed;
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  const extra = corsHeaders(request.headers.get("Origin"), env);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function unauthorized(request: Request, env: Env): Response | null {
  if (!env.DEMO_API_KEY) return null;
  const provided = request.headers.get("Authorization") || "";
  if (provided === `Bearer ${env.DEMO_API_KEY}`) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

async function composio(env: Env, path: string, init: RequestInit = {}) {
  if (!env.COMPOSIO_API_KEY) throw new Error("COMPOSIO_API_KEY is not configured");
  const headers = new Headers(init.headers);
  headers.set("x-api-key", env.COMPOSIO_API_KEY);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${COMPOSIO_API}${path}`, { ...init, headers });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`Composio ${response.status}: ${typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data).slice(0, 1600)}`);
  return data;
}

function stats(env: Env) {
  return {
    ok: true,
    name: "DEMO",
    version: VERSION,
    status: "online",
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestCountSinceIsolateStart: requestCount,
    architecture: { surface: "DEMO", router: "Composio", credentials: "server-only" },
    capabilities: { mcp: true, browser: Boolean(env.BROWSER), composio: Boolean(env.COMPOSIO_API_KEY), screenshots: Boolean(env.BROWSER), gatewayUi: true },
    endpoints: { ui: "/", mcp: "/mcp", health: "/health", gateway: "/gateway", tools: "/gateway/tools", toolkits: "/gateway/toolkits", telemetry: "/platform/stats" },
    telemetry: { scope: "worker-isolate", containsSecrets: false, containsUserContent: false },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    requestCount++;
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && !allowedOrigin(origin, env)) return new Response("Forbidden origin", { status: 403, headers: { "Vary": "Origin" } });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, env) });

    if (url.pathname === "/") return demoUi();

    if (url.pathname === "/gateway") {
      const authError = unauthorized(request, env);
      if (authError) return withCors(authError, request, env);
      return withCors(Response.json({ ...stats(env), message: "DEMO is the gateway. Composio is an internal routing provider." }, { headers: { "Cache-Control": "no-store" } }), request, env);
    }

    if (url.pathname === "/gateway/toolkits") {
      const authError = unauthorized(request, env);
      if (authError) return withCors(authError, request, env);
      try { return withCors(Response.json(await composio(env, `/toolkits?sort_by=usage&include_deprecated=false`)), request, env); }
      catch (e) { return withCors(Response.json({ error: String(e) }, { status: 502 }), request, env); }
    }

    if (url.pathname === "/gateway/tools") {
      const authError = unauthorized(request, env);
      if (authError) return withCors(authError, request, env);
      try {
        const q = url.searchParams.get("query")?.trim();
        const toolkit = url.searchParams.get("toolkit")?.trim();
        const params = new URLSearchParams();
        params.set("limit", "60");
        if (q) params.set("query", q);
        if (toolkit) params.set("toolkit_slug", toolkit);
        return withCors(Response.json(await composio(env, `/tools?${params.toString()}`)), request, env);
      } catch (e) { return withCors(Response.json({ error: String(e) }, { status: 502 }), request, env); }
    }

    if (url.pathname === "/platform/stats") {
      const authError = unauthorized(request, env);
      if (authError) return withCors(authError, request, env);
      return withCors(Response.json(stats(env), { headers: { "Cache-Control": "no-store" } }), request, env);
    }

    const forwardedHeaders = new Headers(request.headers);
    if (origin) forwardedHeaders.delete("Origin");
    const forwarded = new Request(request, { headers: forwardedHeaders });
    const response = await demoWorker.fetch(forwarded, env as any, ctx);
    return withCors(response, request, env);
  },
};
