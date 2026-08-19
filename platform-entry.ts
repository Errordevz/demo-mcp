import demoWorker from "./index";
import { demoUi } from "./ui";

type Env = {
  DEMO_PLATFORM_ORIGIN?: string;
  DEMO_API_KEY?: string;
  BROWSER?: unknown;
  SCREENSHOTS?: R2Bucket;
};

const VERSION = "0.3.5";
const DEFAULT_PLATFORM_ORIGIN = "https://demo-platform.pages.dev";
const LOCAL_ORIGINS = new Set(["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]);
const startedAt = Date.now();
let requestCount = 0;

function configuredOrigins(env: Env) {
  return (env.DEMO_PLATFORM_ORIGIN || DEFAULT_PLATFORM_ORIGIN).split(",").map((v) => v.trim()).filter(Boolean);
}

function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  if (configuredOrigins(env).includes(origin) || LOCAL_ORIGINS.has(origin)) return origin;
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
  for (const [key, value] of Object.entries(corsHeaders(request.headers.get("Origin"), env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function unauthorized(request: Request, env: Env): Response | null {
  if (!env.DEMO_API_KEY) return null;
  const provided = request.headers.get("Authorization") || "";
  if (provided === `Bearer ${env.DEMO_API_KEY}`) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function telemetry(env: Env) {
  return {
    ok: true,
    name: "DEMO",
    version: VERSION,
    status: "online",
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestCountSinceIsolateStart: requestCount,
    toolCount: 29,
    skillCount: 8,
    architecture: { surface: "DEMO Platform", execution: "DEMO MCP", credentials: "server-only" },
    capabilities: {
      mcp: true,
      browser: Boolean(env.BROWSER),
      browserWatching: Boolean(env.BROWSER),
      screenshots: Boolean(env.BROWSER && env.SCREENSHOTS),
      screenshotLinks: Boolean(env.SCREENSHOTS),
      skills: true,
      skillsSh: true,
      composio: false,
    },
    connections: [
      { name: "DEMO MCP", type: "Execution Worker", connected: true },
      { name: "Skills.sh", type: "Skill discovery", connected: true },
      { name: "Browser", type: "Cloudflare Browser Run", connected: Boolean(env.BROWSER) },
      { name: "Screenshot storage", type: "Cloudflare R2", connected: Boolean(env.SCREENSHOTS) },
    ],
    endpoints: { ui: "/", mcp: "/mcp", health: "/health", telemetry: "/platform/stats", screenshots: "/screenshots/:id" },
    telemetry: { scope: "worker-isolate", containsSecrets: false, containsUserContent: false },
  };
}

async function screenshotObject(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.SCREENSHOTS) return new Response("Screenshot storage is not configured", { status: 503 });
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return new Response("Invalid screenshot id", { status: 400 });
  const object = await env.SCREENSHOTS.get(`screenshots/${id}`);
  if (!object) return new Response("Screenshot not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    requestCount++;
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && !allowedOrigin(origin, env)) return new Response("Forbidden origin", { status: 403, headers: { "Vary": "Origin" } });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, env) });

    if (url.pathname === "/") return demoUi();

    if (url.pathname === "/platform/stats") {
      // Safe public telemetry: deliberately excludes credentials, tokens and user content.
      return withCors(Response.json(telemetry(env), { headers: { "Cache-Control": "no-store" } }), request, env);
    }

    if (url.pathname === "/screenshots/" || url.pathname.startsWith("/screenshots/")) {
      const id = url.pathname.slice("/screenshots/".length);
      return withCors(await screenshotObject(request, env, id), request, env);
    }

    const authError = unauthorized(request, env);
    if (authError && url.pathname === "/mcp") return withCors(authError, request, env);

    const forwardedHeaders = new Headers(request.headers);
    if (origin) forwardedHeaders.delete("Origin");
    const forwarded = new Request(request, { headers: forwardedHeaders });
    const response = await demoWorker.fetch(forwarded, env as any, ctx);
    return withCors(response, request, env);
  },
};
