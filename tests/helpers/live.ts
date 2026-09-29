/**
 * Live test helpers for the Cloudflare Browser Rendering integration.
 *
 * These tests hit the real Browser Run service, so they are opt-in. See
 * `tests/live.test.ts` for the required environment variables.
 */
import { spawn } from "node:child_process";
import path from "node:path";

export const LIVE_SKIP_REASON: string | null = (() => {
  if (process.env.DEMO_MCP_LIVE !== "1") return "set DEMO_MCP_LIVE=1 to run live browser tests";
  const remote = process.env.LIVE_WORKER_URL;
  if (remote) return null;
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if (!process.env[key]) return `missing ${key} (or set LIVE_WORKER_URL to a deployed worker)`;
  }
  return null;
})();

export interface LiveConfig {
  enabled: boolean;
  baseUrl: string;
  tiktokUrl: string;
  /** Stable public MP4 (small, short, no DRM, no auth) used by the direct-MP4
   * acceptance tests (video_ingest, inspect_video, video_resolve, video_fetch).
   * Override with LIVE_PUBLIC_VIDEO_URL; the deploy workflow points it at a
   * copy of `tests/fixtures/live-public-video.mp4` published to R2. */
  publicVideoUrl: string;
  local: boolean;
}

/**
 * Local-development default when LIVE_PUBLIC_VIDEO_URL is unset: a 10 s,
 * ~1 MB Big Buck Bunny clip from a long-lived public test-video host. CI does
 * not depend on it — `.github/workflows/live-deploy.yml` uploads the tracked
 * fixture to R2 and exports its public URL instead. The previous default
 * (`commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4`)
 * now answers 403 AccessDenied from every network, not only from the Worker.
 */
export const DEFAULT_PUBLIC_VIDEO_URL = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";

export function liveEnv(): LiveConfig {
  const remote = process.env.LIVE_WORKER_URL;
  const publicVideoOverride = process.env.LIVE_PUBLIC_VIDEO_URL?.trim();
  return {
    enabled: LIVE_SKIP_REASON === null,
    baseUrl: (remote ?? process.env.LIVE_BASE_URL ?? "http://127.0.0.1:8799").replace(/\/$/, ""),
    tiktokUrl: process.env.LIVE_TIKTOK_URL ?? "https://www.tiktok.com/@tiktok/video/7106594312292453675",
    publicVideoUrl: publicVideoOverride || DEFAULT_PUBLIC_VIDEO_URL,
    local: !remote,
  };
}

/**
 * Thrown when the *test host* cannot reach the worker (sandbox egress
 * restriction), in contrast to a failure the worker itself reported. The
 * message must tell the operator exactly which environment constraint hit.
 */
export class TestEnvironmentError extends Error {}

const EGRESS_HINTS =
  /fetch failed|econnrefused|econnreset|enotfound|enetunreach|ehostunreach|ehostdown|socket hang up|network|unreachable|dns|getaddrinfo|tls|certificate|ssl|handshake|aborted|timed? ?out|timeout|proxy/i;

/** True when an error looks like a test-host network restriction, not an app bug. */
export function isEgressError(error: unknown): boolean {
  return EGRESS_HINTS.test(String(error ?? ""));
}

/**
 * Upstream services (Cloudflare Browser Rendering in particular) answer with a
 * capacity refusal rather than a bug: `429 Rate limit exceeded`, or a 503-style
 * "temporarily unavailable". A live suite that treats those as a product failure
 * reports a red run for someone else's throttling, so the client retries them a
 * bounded number of times and still asserts the final result.
 */
const TRANSIENT_HINTS =
  /(?:\b429\b|\b503\b|rate ?limit|too many requests|temporarily unavailable|service unavailable|try again later|capacity|overloaded)/i;

export interface TransientSignals {
  text: string;
  parsed: unknown;
  isError?: boolean;
}

/** True when a tool result is an upstream rate-limit/capacity refusal worth retrying. */
export function isTransientRateLimit({ text, parsed, isError }: TransientSignals): boolean {
  const payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const failed = isError === true || payload?.success === false;
  if (!failed) return false;
  const detail = [text.slice(0, 2_000), String(payload?.message ?? ""), String(payload?.error ?? "")].join(" ");
  return TRANSIENT_HINTS.test(detail);
}

/** Retry policy for transient upstream refusals (`LIVE_RETRY_ATTEMPTS`, `LIVE_RETRY_DELAY_MS`). */
export function transientRetry(): { attempts: number; delayMs: number } {
  const attempts = Number.parseInt(process.env.LIVE_RETRY_ATTEMPTS ?? "3", 10);
  const delayMs = Number.parseInt(process.env.LIVE_RETRY_DELAY_MS ?? "20000", 10);
  return {
    attempts: Number.isFinite(attempts) && attempts > 0 && attempts <= 10 ? attempts : 3,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 120_000 ? delayMs : 20_000,
  };
}

/**
 * Preflight: the worker must answer /health. If the test host cannot reach it
 * (typical in a restricted sandbox), fail fast with an unambiguous message
 * instead of producing misleading per-test failures.
 */
export async function assertWorkerReachable(baseUrl: string): Promise<void> {
  const origin = baseUrl.replace(/\/$/, "");
  try {
    const response = await fetch(`${origin}/health`);
    if (!response.ok) throw new Error(`/health returned HTTP ${response.status}`);
  } catch (error) {
    const detail = String(error);
    throw new TestEnvironmentError(
      isEgressError(error)
        ? `The test host could not reach the worker at ${origin}/health (${detail}). This is an outbound network restriction of the sandbox/test environment — NOT a failure of the deployed pipeline. Run the live tests from a host with internet egress (or set LIVE_WORKER_URL to a deployed worker reachable from this host).`
        : `The worker at ${origin} did not pass the /health preflight: ${detail}`,
    );
  }
}

/**
 * Classify a tool result that failed because the *worker* could not reach the
 * public source from its own network (restricted test host running
 * `wrangler dev`). Returns a skip note, or null when the failure is a real
 * pipeline/platform result that the test must assert on.
 */
export function workerEgressSkipNote(result: CallResult, target: string): string | null {
  const payload = result.parsed as Record<string, any> | null;
  if (!payload || payload.success === true) return null;
  const message = String(payload.message ?? payload.error ?? "");
  if (!/fetch failed|network|unreachable|enotfound|econnrefused|econnreset|dns|getaddrinfo|tls|certificate|ssl|handshake|aborted/i.test(message)) return null;
  return `Worker egress to ${target} failed (${message}). The deployed worker has normal outbound access; this failure comes from the restricted network of the environment running the test. Re-run from a host with internet egress, or against LIVE_WORKER_URL.`;
}

/**
 * Classify a tool result in which the *fixture host itself* refused the
 * Worker (HTTP 403 / bot challenge / access denied) — an environment problem
 * of the test fixture, not of the pipeline under test. Returns an explicit,
 * labelled skip note, or null when the test must assert on the result.
 *
 * Deliberately narrow: it applies only to the configured public fixture URL
 * (`liveEnv().publicVideoUrl`), never to a user-supplied or platform URL, and
 * only to the access-denied classification. Any other failure — a wrong
 * payload shape, a pipeline error, a successful result — still reaches the
 * assertions, so this can never turn a real regression into a pass.
 */
export function fixtureAccessSkipNote(result: CallResult, target: string): string | null {
  if (target !== liveEnv().publicVideoUrl) return null;
  const payload = result.parsed as Record<string, any> | null;
  if (!payload) return null;
  if (payload.success === true || payload.access_status === "public" || payload.visualEvidenceDelivered === true) return null;
  const challenge = payload.challenge && typeof payload.challenge === "object" ? (payload.challenge as Record<string, any>) : null;
  const message = String(payload.message ?? "");
  const denied =
    challenge?.kind === "bot_challenge_or_access_denied" ||
    payload.access_status === "challenge_required" ||
    (payload.error === "PLATFORM_BLOCKED" && /\b403\b|access denied|challenge/i.test(message));
  if (!denied) return null;
  const status = typeof payload.http_status === "number" ? ` HTTP ${payload.http_status}` : "";
  return (
    `ENVIRONMENT SKIP (fixture host denied the Worker): ${target} answered${status} ` +
    `${challenge?.kind ?? payload.access_status ?? payload.error} to the Worker's egress` +
    `${message ? ` (${message})` : ""}. The tool classified it honestly; the test cannot exercise the ` +
    `pipeline without a reachable fixture. Point LIVE_PUBLIC_VIDEO_URL at a small public MP4 the Worker can ` +
    `fetch (the deploy workflow publishes tests/fixtures/live-public-video.mp4 to R2 for this).`
  );
}

/**
 * Skip a live test for an environment reason, printing the reason so a skip is
 * never silent in CI logs, then delegating to vitest's `skip(note)`.
 */
export function skipForEnvironment(skip: (note?: string) => never, note: string): never {
  console.warn(`[live] ${note}`);
  return skip(note);
}

export interface CallResult {
  isError: boolean;
  text: string;
  parsed: any;
  imageCount: number;
  imageMimeTypes: string[];
  /** Raw MCP image content blocks (base64 data + MIME) for byte-level checks. */
  imageBlocks: Array<{ data: string; mimeType: string }>;
}

interface JsonRpc {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

function parseSse(text: string): JsonRpc | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpc;
  const lines = trimmed.split("\n").filter((line) => line.startsWith("data:"));
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1].slice(5).trim()) as JsonRpc;
}

export interface LiveClient {
  call(name: string, args: Record<string, unknown>): Promise<CallResult>;
  /** Any JSON-RPC method (used for `resources/list` and `resources/read`). */
  rpc(method: string, params: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export function connectLive(baseUrl?: string): LiveClient {
  const config = liveEnv();
  const origin = (baseUrl ?? config.baseUrl).replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  let id = 0;

  return {
    async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
      const callOnce = async (): Promise<CallResult> => {
        const response = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${origin}/mcp: ${await response.text()}`);
        const body = await response.text();
        const message = parseSse(body);
        if (!message) throw new Error(`Unparseable MCP response: ${body.slice(0, 400)}`);
        if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
        const result = message.result ?? {};
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content.map((entry: { text?: string }) => entry.text ?? "").join("\n");
        const imageEntries = content.filter((entry: { type?: string }) => entry.type === "image");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        return {
          isError: Boolean(result.isError),
          text,
          parsed,
          imageCount: imageEntries.length,
          imageMimeTypes: imageEntries.map((entry: { mimeType?: string }) => String(entry.mimeType ?? "")),
          imageBlocks: imageEntries.map((entry: { data?: string; mimeType?: string }) => ({
            data: String(entry.data ?? ""),
            mimeType: String(entry.mimeType ?? ""),
          })),
        };
      };

      const { attempts, delayMs } = transientRetry();
      let last = await callOnce();
      for (let attempt = 2; attempt <= attempts && isTransientRateLimit(last); attempt += 1) {
        console.warn(
          `[live] ${name} was refused by an upstream rate limit; retry ${attempt}/${attempts} in ${delayMs} ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        last = await callOnce();
      }
      return last;
    },
    async rpc(method: string, params: Record<string, unknown>): Promise<any> {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${origin}/mcp: ${await response.text()}`);
      const message = parseSse(await response.text());
      if (!message) throw new Error(`Unparseable MCP response for ${method}`);
      if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
      return message.result ?? {};
    },
    async close(): Promise<void> {
      /* HTTP transport is stateless per request */
    },
  };
}

/** Skips the running test when a capability the suite cannot provide is missing. */
export function skipIfUnavailable(result: CallResult, tool: string, skip: (note?: string) => never): void {
  const code = result.parsed?.error;
  if (result.isError && (code === "capability_unavailable" || code === "rate_limited")) {
    skip(`${tool} unavailable in this environment: ${result.parsed?.message ?? code}`);
  }
}

export const SKIPPABLE = ["capability_unavailable", "rate_limited"];

export function assertSkippable(result: CallResult): CallResult {
  if (result.isError && SKIPPABLE.includes(String(result.parsed?.error))) {
    const error = new Error(`SKIPPED: ${result.parsed?.message}`) as Error & { skipped?: boolean };
    error.skipped = true;
    throw error;
  }
  return result;
}

/**
 * Starts `wrangler dev` for the Worker so the live test can talk to the real
 * Browser Run binding. Returns a stop function.
 */
export async function startDevWorker(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = Number(process.env.LIVE_PORT ?? 8799);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"], {
    cwd: path.resolve(__dirname, "..", ".."),
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return { url, stop: async () => { child.kill("SIGTERM"); } };
    } catch {
      /* not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  child.kill("SIGTERM");
  throw new Error(`wrangler dev did not start:\n${log.slice(-4000)}`);
}
