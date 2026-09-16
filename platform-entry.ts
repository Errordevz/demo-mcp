import demoWorker, { TOOL_COUNT } from "./index";
import { demoUi } from "./ui";
import { SessionManager } from "./src/session/manager.js";
import { VideoArtifactStore, artifactBaseUrl, parseRangeHeader } from "./src/video/store.js";
import { LIMITS } from "./src/core/limits.js";

// Re-exported so Wrangler can bind the Durable Object class
// (`durable_objects.bindings[].class_name = "BrowserSession"`).
export { BrowserSession } from "./src/session/durable-object.js";

type Env = {
  DEMO_PLATFORM_ORIGIN?: string;
  DEMO_API_KEY?: string;
  BROWSER?: unknown;
  SCREENSHOTS?: R2Bucket;
  VIDEO_ARTIFACTS?: R2Bucket;
  BROWSER_SESSIONS?: unknown;
  VIDEO_ARTIFACT_TTL_SECONDS?: string | number;
};

// Kept in lockstep with the `index.ts` VERSION so /platform/stats, /health and
// the MCP `serverInfo` all report the same deployed version.
const VERSION = "0.7.1.5";
const DEFAULT_PLATFORM_ORIGIN = "https://demo-platform.pages.dev";
const LOCAL_ORIGINS = new Set(["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]);
const startedAt = Date.now();
let requestCount = 0;

function configuredOrigins(env: Env) {
  return (env.DEMO_PLATFORM_ORIGIN || DEFAULT_PLATFORM_ORIGIN)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
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
  const capabilities = new SessionManager(env as never).capabilities();
  return {
    ok: true,
    name: "DEMO",
    version: VERSION,
    status: "online",
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestCountSinceIsolateStart: requestCount,
    toolCount: TOOL_COUNT,
    skillCount: 8,
    architecture: { surface: "DEMO Platform", execution: "DEMO MCP", credentials: "server-only" },
    capabilities: {
      mcp: true,
      browser: capabilities.browserAvailable,
      browserWatching: capabilities.browserAvailable,
      browserSessions: capabilities.sessionStorage === "durable-object",
      screenshots: capabilities.screenshots,
      screenshotLinks: capabilities.screenshots,
      liveView: capabilities.liveView,
      humanHandoff: capabilities.handoff,
      videoFrames: capabilities.videoFrames,
      publicVideo: true,
      automaticVideoInspection: true,
      videoArtifacts: Boolean(env.SCREENSHOTS),
      accessibilitySnapshot: capabilities.accessibilitySnapshot,
      skills: true,
      skillsSh: true,
      composio: false,
    },
    connections: [
      { name: "DEMO MCP", type: "Execution Worker", connected: true },
      { name: "Skills.sh", type: "Skill discovery", connected: true },
      { name: "Browser", type: "Cloudflare Browser Run", connected: capabilities.browserAvailable },
      { name: "Browser sessions", type: "Durable Object", connected: capabilities.sessionStorage === "durable-object" },
      { name: "Screenshot storage", type: "Cloudflare R2", connected: capabilities.screenshots },
    ],
    endpoints: { ui: "/", mcp: "/mcp", health: "/health", tools: "/tools", telemetry: "/platform/stats", screenshots: "/screenshots/:id" },
    telemetry: { scope: "worker-isolate", containsSecrets: false, containsUserContent: false },
  };
}

async function screenshotObject(request: Request, env: Env, id: string): Promise<Response> {
  void request;
  if (!env.SCREENSHOTS) return new Response("Screenshot storage is not configured", { status: 503 });
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return new Response("Invalid screenshot id", { status: 400 });
  const key = `screenshots/${id}`;
  const object = await env.SCREENSHOTS.get(key);
  if (!object) return new Response("Screenshot not found", { status: 404 });
  const expiresAt = object.customMetadata?.expiresAt ? Date.parse(object.customMetadata.expiresAt) : 0;
  if (expiresAt && expiresAt <= Date.now()) {
    await env.SCREENSHOTS.delete(key);
    return new Response("Screenshot expired", { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

async function videoObject(request: Request, env: Env): Promise<Response> {
  const reference = new URL(request.url).pathname.slice("/video-assets/".length);
  if (!/^(?:video|audio)_[a-f0-9]{64}$/.test(reference)) return new Response("Invalid video artifact reference", { status: 400 });
  const bucket = env.VIDEO_ARTIFACTS ?? env.SCREENSHOTS;
  if (!bucket) return new Response("Video artifact storage is not configured", { status: 503 });
  const store = new VideoArtifactStore(
    bucket as never,
    artifactBaseUrl(request.url),
    Number(env.VIDEO_ARTIFACT_TTL_SECONDS ?? LIMITS.videoArtifactTtlSeconds),
  );
  // Report an elapsed TTL as 410 Gone rather than a generic 404: an expired
  // temporary artifact is a different, actionable fact for a client.
  const routeStatus = await store.routeStatus(reference);
  if (routeStatus === "expired") {
    return Response.json({ error: "ARTIFACT_EXPIRED", reference, message: "This temporary video artifact passed its retention window and was deleted. Re-fetch the original public URL to mint a new one." }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }
  if (routeStatus === "missing") return new Response("Video artifact not found", { status: 404 });
  if (routeStatus === "storage_unavailable") return new Response("Video artifact storage is not configured", { status: 503 });

  const object = await store.objectForRoute(reference);
  if (!object) return new Response("Video artifact not found or expired", { status: 404 });
  const size = Number(object.size ?? 0);

  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");

  // Honour Range requests so a stored artifact can be seeked by an <video>
  // element without DEMO buffering the whole file.
  const range = parseRangeHeader(request.headers.get("Range"), Number.isFinite(size) && size > 0 ? size : null);
  if (range) {
    const ranged = await store.objectForRoute(reference, range);
    if (ranged) {
      const rangedHeaders = new Headers(headers);
      const start = range.suffix !== undefined ? Math.max(0, size - range.suffix) : (range.offset ?? 0);
      const length = range.suffix !== undefined ? Math.min(range.suffix, size) : (range.length ?? size - start);
      rangedHeaders.set("Content-Range", `bytes ${start}-${start + length - 1}/${size || "*"}`);
      rangedHeaders.set("Content-Length", String(length));
      return new Response(ranged.body, { status: 206, headers: rangedHeaders });
    }
  }
  if (Number.isFinite(size) && size > 0) headers.set("Content-Length", String(size));
  return new Response(object.body, { headers });
}

async function cleanupExpiredObjects(bucket: R2Bucket | undefined, prefixes: string[]): Promise<number> {
  if (!bucket) return 0;
  let removed = 0;
  // Cleanup is deliberately bounded. R2 lifecycle rules should be configured
  // as a second line of defence; the Worker only scans a small page per tick.
  const listed = await bucket.list({ limit: 1_000 });
  for (const object of listed.objects as Array<{ key: string; customMetadata?: Record<string, string> }>) {
    if (!prefixes.some((prefix) => object.key.startsWith(prefix))) continue;
    const expiresAt = object.customMetadata?.expiresAt ? Date.parse(object.customMetadata.expiresAt) : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      await bucket.delete(object.key);
      removed++;
    }
  }
  return removed;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cleanup = cleanupExpiredObjects(env.VIDEO_ARTIFACTS ?? env.SCREENSHOTS, ["video-artifacts/"])
      .then((removed) => cleanupExpiredObjects(env.SCREENSHOTS, ["screenshots/"]).then((frames) => ({ removed, frames })))
      .catch(() => ({ removed: 0, frames: 0 }));
    ctx.waitUntil(cleanup.then(() => undefined));
  },

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

    if (url.pathname.startsWith("/video-assets/")) {
      return withCors(await videoObject(request, env), request, env);
    }

    if (url.pathname === "/screenshots/" || url.pathname.startsWith("/screenshots/")) {
      const id = url.pathname.slice("/screenshots/".length);
      return withCors(await screenshotObject(request, env, id), request, env);
    }

    // Video frames and screenshots live under the same /screenshots/:id namespace.
    if (url.pathname.startsWith("/frames/")) {
      const id = url.pathname.slice("/frames/".length).replace(/^.*\//, "");
      return withCors(await screenshotObject(request, env, id), request, env);
    }

    const authError = unauthorized(request, env);
    if (authError && url.pathname === "/mcp") return withCors(authError, request, env);

    const forwardedHeaders = new Headers(request.headers);
    if (origin) forwardedHeaders.delete("Origin");
    const forwarded = new Request(request, { headers: forwardedHeaders });
    const response = await demoWorker.fetch(forwarded, env as never, ctx);
    return withCors(response, request, env);
  },
};
