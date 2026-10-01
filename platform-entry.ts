import demoWorker, { TOOL_COUNT } from "./index";
import { resolveJevConfig } from "./src/jev/config.js";
import { resolveLayaConfig } from "./src/laya/config.js";
import { resolveDecisionRoutingMode } from "./src/decisions/provider.js";
import { demoUi } from "./ui";
import { handleMcpOAuthRoute, isMcpOAuthPath } from "./src/auth/oauth-routes.js";
import { handleCollabRoute, isCollabPath } from "./src/collab/routes.js";
import { handleByoxRoute, isByoxPath } from "./src/byox/routes.js";
import { resolveCollabStore } from "./src/collab/store.js";
import { MCP_OAUTH_SCOPES, mcpOAuthReady, resolveMcpOAuthConfig } from "./src/auth/oauth-config.js";
import { SessionManager } from "./src/session/manager.js";
import { VideoArtifactStore, artifactBaseUrl, parseRangeHeader } from "./src/video/store.js";
import { LIMITS } from "./src/core/limits.js";
import { oversizedBody, securityHeaders } from "./src/core/headers.js";
import { iconRoute } from "./src/ui/icons.js";

// Re-exported so Wrangler can bind the Durable Object classes
// (`durable_objects.bindings[].class_name`).
export { BrowserSession } from "./src/session/durable-object.js";
export { McpAuth } from "./src/auth/oauth-store.js";
export { DemoAccounts } from "./src/collab/store.js";

type Env = {
  DEMO_PLATFORM_ORIGIN?: string;
  MCP_PUBLIC_ORIGIN?: string;
  MCP_AUTH_ACCESS_TEAM_DOMAIN?: string;
  MCP_AUTH_ACCESS_AUD?: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string | number;
  MCP_AUTH_RATE_LIMIT_PER_MINUTE?: string | number;
  MCP_AUTH?: unknown;
  DEMO_ACCOUNTS?: unknown;
  BROWSER?: unknown;
  SCREENSHOTS?: R2Bucket;
  VIDEO_ARTIFACTS?: R2Bucket;
  /** Optional separate R2 bucket for web snapshots/monitors (falls back to SCREENSHOTS). */
  WEB_SNAPSHOTS?: R2Bucket;
  /** Workers AI binding (vision/OCR/transcription). Presence checked only. */
  AI?: { run?: unknown };
  BROWSER_SESSIONS?: unknown;
  VIDEO_ARTIFACT_TTL_SECONDS?: string | number;
  /** TypeSafe / Jev decision engine: the credential is a secret, never a var. */
  TYPESAFE_API_KEY?: string;
  YOUTUBE_API_KEY?: string;
  TYPESAFE_ENABLED?: string;
  TYPESAFE_MODEL?: string;
  TYPESAFE_DECISION_TIMEOUT_MS?: string | number;
  TYPESAFE_REVIEW_THRESHOLD?: string | number;
  TYPESAFE_ACCEPT_THRESHOLD?: string | number;
  /** Laya decision provider: external server; optional credential is a secret, never a var. */
  LAYA_ENABLED?: string;
  LAYA_BASE_URL?: string;
  LAYA_API_KEY?: string;
  LAYA_TIMEOUT_MS?: string | number;
  LAYA_MODEL?: string;
  DECISION_PROVIDER_MODE?: string;
  /** DEMO 0.9 expanded capability policy (non-secret). */
  GIT_MAX_PACK_MB?: string;
  GIT_REQUEST_TIMEOUT_MS?: string;
  GIT_RATE_LIMIT_PER_MINUTE?: string;
  GIT_MAX_DEPTH?: string;
  GIT_MEMORY_MAX_MB?: string;
  GIT_TEMP_REPO_TTL_MS?: string;
  TOOL_RATE_LIMIT_PER_MINUTE?: string;
  SNAPSHOT_RETENTION_SECONDS?: string;
  WEB_MONITOR_SCHEDULED_CHECKS?: string;
  PDF_MAX_MB?: string;
  IMAGE_MAX_MB?: string;
};

/** Kept equal to the Worker's own version in index.ts so both surfaces agree. */
const VERSION = "1.1.0";
const DEFAULT_PLATFORM_ORIGIN = "https://demo-platform.pages.dev";
const LOCAL_ORIGINS = new Set(["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]);
const CHATGPT_ORIGINS = new Set(["https://chatgpt.com"]);
/**
 * Isolate start time for `/platform/stats`.
 *
 * `Date.now()` at module scope is NOT a usable timestamp: workerd evaluates the
 * module graph while the runtime clock is still zero, so the deployed Worker
 * reported `uptimeSeconds` around 1_790_703_000 (~57 years) and the UI printed
 * it as the isolate age. Verified locally against `wrangler dev` — the first
 * request of a fresh isolate already reported the same epoch-based value.
 *
 * The clock is therefore only trusted when it looks like a real wall-clock
 * reading; otherwise it is anchored on the first request this isolate serves.
 */
const MODULE_STARTED_AT = Date.now();
/** Below this, the timestamp cannot be a real reading (DEMO 1.0 shipped in 2026). */
const PLAUSIBLE_START_MS = Date.UTC(2025, 0, 1);
let anchoredStartedAt: number | null = MODULE_STARTED_AT >= PLAUSIBLE_START_MS ? MODULE_STARTED_AT : null;
let requestCount = 0;

/** Start time of this isolate, anchored on its first request when the clock was unusable at load. */
function isolateStartedAt(now: number): number {
  if (anchoredStartedAt === null) anchoredStartedAt = now;
  return anchoredStartedAt;
}

function configuredOrigins(env: Env) {
  return (env.DEMO_PLATFORM_ORIGIN || DEFAULT_PLATFORM_ORIGIN)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  if (configuredOrigins(env).includes(origin) || LOCAL_ORIGINS.has(origin) || CHATGPT_ORIGINS.has(origin)) return origin;
  return null;
}

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = allowedOrigin(origin, env);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    // Static hardening on every platform response (no request data involved).
    ...securityHeaders(),
  };
  if (allowed) headers["Access-Control-Allow-Origin"] = allowed;
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request.headers.get("Origin"), env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Non-secret Roblox surface summary for telemetry.
 *
 * Deliberately synchronous and deliberately blind to values: it reports whether
 * the client id/secret and the encryption key are *present*, never what they are,
 * and it never reads an account record (a linked account is only reported as
 * "a session may exist", because "is this browser connected" is per-browser).
 */
/** Decision-engine surface for telemetry: presence and policy only, never the credential. */
function jevSurface(env: Env) {
  const config = resolveJevConfig(env as unknown as Record<string, unknown>);
  return {
    available: config.available,
    enabled: config.enabled,
    credentialConfigured: config.apiKeyPresent,
    model: config.model,
    reviewThreshold: config.reviewThreshold,
    acceptThreshold: config.acceptThreshold,
    // Public telemetry must not carry a string that looks like a credential name
    // (tests/mcp-tools.test.ts asserts that on the whole payload), so when the key is
    // missing we point at the route that documents it instead of quoting the variable.
    reason: config.available
      ? null
      : !config.apiKeyPresent
        ? "No TypeSafe credential is configured on this Worker. See GET /capabilities/jev for the secret name and how to set it; DEMO's own rules decide until then."
        : config.disabledReason,
  };
}

/**
 * Laya decision-provider surface for telemetry: presence and policy only. The
 * endpoint is reported as a hostname, the optional credential as a boolean — never
 * a value, and never a credential-shaped string in this payload.
 */
function layaSurface(env: Env) {
  const config = resolveLayaConfig(env as unknown as Record<string, unknown>);
  return {
    available: config.available,
    enabled: config.enabled,
    configured: config.configured,
    credentialConfigured: config.credentialConfigured,
    model: config.model,
    endpointHost: config.endpointHost,
    httpsOnly: true,
    routingMode: resolveDecisionRoutingMode(env as unknown as Record<string, unknown>),
    reason: config.available ? null : (config.disabledReason ?? "Laya is not configured on this Worker."),
  };
}

function mcpOAuthSurface(env: Env) {
  const config = resolveMcpOAuthConfig(env);
  return {
    configured: mcpOAuthReady(env),
    identityProvider: "Cloudflare Access; signed user subject verified by the Worker",
    identityOptions: { cloudflareAccess: Boolean(config?.accessConfigured) },
    publicToolsUnauthenticated: true,
    protectedScopes: [...MCP_OAUTH_SCOPES],
    accessTokenTtlSeconds: config?.accessTokenTtlSeconds ?? null,
    refreshTokensIssued: false,
    authorizationCodePkce: "S256",
    clientRegistration: "ChatGPT CIMD allowlist; dynamic client registration disabled",
  };
}

/** YouTube surface for telemetry: presence only, never the credential. */
function youtubeSurface(env: Env) {
  const apiKey = String(env.YOUTUBE_API_KEY ?? "").trim();
  return {
    available: apiKey.length > 0,
    tools: ["youtube_search", "youtube_video", "youtube_channel", "youtube_playlist"],
    scope: "public_only",
    noOAuth: true,
  };
}

function telemetry(env: Env) {
  const capabilities = new SessionManager(env as never).capabilities();
  const collabAvailable = Boolean(resolveCollabStore(env as unknown as Record<string, unknown>));
  return {
    ok: true,
    name: "DEMO",
    version: VERSION,
    status: "online",
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - isolateStartedAt(Date.now())) / 1000)),
    requestCountSinceIsolateStart: requestCount,
    toolCount: TOOL_COUNT,
    skillCount: 9,
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
      mcpOAuth: mcpOAuthSurface(env),
      jevDecisionEngine: jevSurface(env),
      layaDecisionProvider: layaSurface(env),
      typedDecisions: jevSurface(env).available || layaSurface(env).available,
      youtube: youtubeSurface(env),
      byox: { available: true, source: "codecrafters-io/build-your-own-x", refreshRequiresAdmin: true },
      collaboration: { workspaceStorage: collabAvailable, applyEnabled: String((env as unknown as Record<string, unknown>).COLLAB_ALLOW_APPLY ?? "true").toLowerCase() !== "false", scopes: ["collab:write", "collab:admin"] },
      expanded: {
        git: true,
        gitPublicOnly: true,
        internetArchive: true,
        feeds: true,
        pdf: true,
        images: true,
        webExtract: true,
        webDiff: true,
        webMonitor: Boolean(env.SCREENSHOTS || env.WEB_SNAPSHOTS),
        openapi: true,
        networkDiagnostics: true,
        localUtilities: true,
        webResearch: true,
        urlSafety: true,
      },
    },
    connections: [
      { name: "DEMO MCP", type: "Execution Worker", connected: true },
      { name: "Skills.sh", type: "Skill discovery", connected: true },
      { name: "Browser", type: "Cloudflare Browser Run", connected: capabilities.browserAvailable },
      { name: "Browser sessions", type: "Durable Object", connected: capabilities.sessionStorage === "durable-object" },
      { name: "Screenshot storage", type: "Cloudflare R2", connected: capabilities.screenshots },
      { name: "DEMO OAuth", type: "OAuth 2.1 + PKCE (Cloudflare Access identity, per-tool grants)", connected: mcpOAuthSurface(env).configured },
      { name: "TypeSafe Jev", type: "Structured decision engine (HTTP API)", connected: jevSurface(env).available },
      { name: "Laya", type: "External typed-decision provider (HTTP API)", connected: layaSurface(env).available },
      { name: "YouTube Data API", type: "Public metadata (Data API v3)", connected: youtubeSurface(env).available },
      { name: "Git (smart HTTP)", type: "Public repositories, no API key", connected: true },
      { name: "Build Your Own X catalog", type: "R2-backed reference index (metadata only)", connected: true },
      { name: "Collaboration workspace", type: "Durable Object (DemoAccounts, collab: keys)", connected: collabAvailable },
      { name: "Internet Archive", type: "Wayback + archive.org public APIs", connected: true },
      { name: "Workers AI vision", type: "Image/PDF OCR + description", connected: Boolean(env.AI && typeof (env.AI as { run?: unknown }).run === "function") },
      { name: "Web snapshots", type: "R2 (expiring objects)", connected: Boolean(env.SCREENSHOTS || env.WEB_SNAPSHOTS) },
    ],
    endpoints: {
      ui: "/",
      mcp: "/mcp",
      health: "/health",
      tools: "/tools",
      telemetry: "/platform/stats",
      screenshots: "/screenshots/:id",
      mcpOAuth: "/.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server, /oauth/{authorize,token,revoke}",
      jevCapabilities: "/capabilities/jev",
      layaCapabilities: "/capabilities/laya",
      youtubeCapabilities: "/capabilities/youtube",
      expandedCapabilities: "/capabilities/expanded",
      byoxCapabilities: "/capabilities/byox",
      collabCapabilities: "/capabilities/collab",
      collab: "/collab",
      byox: "/byox",
      byoxSearch: "/byox/search?q=",
    },
    telemetry: { scope: "worker-isolate", containsSecrets: false, containsUserContent: false },
  };
}

/**
 * Brand/asset routes the browser requests on its own.
 *
 * Verified live: `GET /favicon.ico` and `GET /apple-touch-icon.png` answered
 * `404 Not Found`, so every page view logged a failed request. The page now
 * declares the icons and these routes serve them; `/favicon.ico` is a real PNG
 * (clients that ask for the conventional path get an image, not HTML).
 */
function iconResponse(pathname: string): Response | null {
  const icon = iconRoute(pathname);
  if (!icon) return null;
  const headers = new Headers(icon.headers);
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  return new Response(icon.body, { status: icon.status, headers });
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
    // Artifact TTL sweep (existing behaviour) + DEMO 0.9 snapshot/monitor objects,
    // which follow the same expiresAt customMetadata convention as screenshots.
    const cleanup = cleanupExpiredObjects(env.VIDEO_ARTIFACTS ?? env.SCREENSHOTS, ["video-artifacts/"])
      .then((removed) => cleanupExpiredObjects(env.SCREENSHOTS, ["screenshots/"]).then((frames) => ({ removed, frames })))
      .then((counts) => cleanupExpiredObjects(env.SCREENSHOTS, ["web-snap/", "web-mon/"]).then((snapshots) => ({ ...counts, snapshots })))
      .catch(() => ({ removed: 0, frames: 0, snapshots: 0 }));
    ctx.waitUntil(cleanup.then(() => undefined));
    // Website monitoring sweep is OPT-IN: a registered URL must never silently
    // become an unbounded recurring job, so the existing hourly cron only runs
    // due monitor checks when WEB_MONITOR_SCHEDULED_CHECKS=true.
    if (String(env.WEB_MONITOR_SCHEDULED_CHECKS ?? "false").toLowerCase() === "true") {
      ctx.waitUntil(
        import("./src/web/monitor.js")
          .then((module) => module.checkDueMonitors(env as unknown as Record<string, unknown>, { maxChecks: 5 }))
          .then(() => undefined)
          .catch(() => undefined),
      );
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    requestCount++;
    // Anchor the isolate clock on the FIRST request, not on the first request
    // that happens to read /platform/stats. Without this, an isolate that had
    // already served requests reported `uptimeSeconds: 0` until something asked
    // for stats — under-reporting its own age (observed on the deployment after
    // the first fix: 10 requests served, age still 0).
    isolateStartedAt(Date.now());
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // OAuth metadata and protocol routes own their CORS/CSRF policies. They are
    // dispatched before the generic origin allowlist and never reach /mcp.
    if (isMcpOAuthPath(url.pathname)) {
      return (await handleMcpOAuthRoute(request, env as unknown as Record<string, unknown>)) ?? new Response("Not Found", { status: 404 });
    }

    if (origin && !allowedOrigin(origin, env)) return new Response("Forbidden origin", { status: 403, headers: { "Vary": "Origin" } });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, env) });

    if (isByoxPath(url.pathname)) {
      // Public, metadata-only catalog API. The refresh sub-route is
      // administrator-gated inside the handler, not here.
      const byox = await handleByoxRoute(request, env as unknown as Record<string, unknown>);
      if (byox) return withCors(byox, request, env);
      return new Response("Not Found", { status: 404, headers: { Vary: "Origin" } });
    }

    if (isCollabPath(url.pathname)) {
      // The workspace JSON API. Same origin policy as /mcp: the dashboard is
      // same-origin, and every write additionally needs a collab:write grant.
      const collab = await handleCollabRoute(request, env as unknown as Record<string, unknown>);
      if (collab) return withCors(collab, request, env);
      return new Response("Not Found", { status: 404, headers: { Vary: "Origin" } });
    }

    if (url.pathname === "/") return demoUi(request.url, env);

    if (url.pathname === "/platform/stats") {
      // Safe public telemetry: deliberately excludes credentials, tokens and user content.
      return withCors(Response.json(telemetry(env), { headers: { "Cache-Control": "no-store" } }), request, env);
    }

    const icon = iconResponse(url.pathname);
  if (icon) return withCors(icon, request, env);

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

    // Oversized MCP bodies are rejected before the transport reads them.
    if (url.pathname === "/mcp") {
      const tooLarge = oversizedBody(request, LIMITS.maxMcpBodyBytes);
      if (tooLarge) return withCors(tooLarge, request, env);
    }
    const forwardedHeaders = new Headers(request.headers);
    if (origin) forwardedHeaders.delete("Origin");
    const forwarded = new Request(request, { headers: forwardedHeaders });
    const response = await demoWorker.fetch(forwarded, env as never, ctx);
    return withCors(response, request, env);
  },
};
