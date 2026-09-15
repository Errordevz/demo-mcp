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
  apiKey: string | null;
  tiktokUrl: string;
  local: boolean;
}

export function liveEnv(): LiveConfig {
  const remote = process.env.LIVE_WORKER_URL;
  return {
    enabled: LIVE_SKIP_REASON === null,
    baseUrl: (remote ?? process.env.LIVE_BASE_URL ?? "http://127.0.0.1:8799").replace(/\/$/, ""),
    apiKey: process.env.LIVE_API_KEY ?? process.env.DEMO_API_KEY ?? null,
    tiktokUrl: process.env.LIVE_TIKTOK_URL ?? "https://www.tiktok.com/@tiktok/video/7106594312292453675",
    local: !remote,
  };
}

export interface CallResult {
  isError: boolean;
  text: string;
  parsed: any;
  imageCount: number;
  imageMimeTypes: string[];
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
  close(): Promise<void>;
}

export function connectLive(baseUrl?: string, apiKey?: string): LiveClient {
  const config = liveEnv();
  const origin = (baseUrl ?? config.baseUrl).replace(/\/$/, "");
  const token = apiKey ?? config.apiKey;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let id = 0;

  return {
    async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
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
      };
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
