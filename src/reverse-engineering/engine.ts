/**
 * Optional external analysis service client.
 *
 * Heavy reverse-engineering tooling (Ghidra headless, binutils, radare2, Frida,
 * Jadx…) cannot run inside a Cloudflare Worker. Rather than pretend otherwise,
 * DEMO can delegate those steps to a *separate* service the operator runs
 * themselves, and this module is the only door to it.
 *
 * The contract is deliberately tiny and closed:
 *
 *   - the service is reached only through DEMO's existing SSRF guard;
 *   - only the operations in `ANALYZER_OPERATIONS` may be requested — a caller
 *     can never pass a command line, a script path or a target path;
 *   - the target is sent as raw bytes with a hard size cap, never as a path;
 *   - every request carries the resource limits the sandbox must enforce;
 *   - a timeout is always set, and a failure is reported as a failure.
 *
 * With no `RE_ANALYZER_URL` configured the client reports unavailable and the
 * capability degrades to its deterministic Worker engines. `RE_ANALYZER_KEY` is
 * a Worker secret and is never echoed, logged or returned.
 */

export const ANALYZER_OPERATIONS = [
  "tool-inventory",
  "identify",
  "sections",
  "symbols",
  "strings",
  "disassemble",
  "decompile",
  "unpack",
  "instrument",
  "network-trace",
] as const;

export type AnalyzerOperation = (typeof ANALYZER_OPERATIONS)[number];

export function isAnalyzerOperation(value: unknown): value is AnalyzerOperation {
  return typeof value === "string" && (ANALYZER_OPERATIONS as readonly string[]).includes(value);
}

export interface AnalyzerRequest {
  operation: AnalyzerOperation;
  /** Target bytes. Sent as a body, never as a path. */
  bytes: Uint8Array;
  targetName: string;
  /** Optional region selector, e.g. a symbol name or an address range. */
  selector?: string | null;
  /** Limits the service must enforce. */
  limits: {
    cpuMs: number;
    wallMs: number;
    memoryMb: number;
    network: "none" | "loopback-only" | "consented";
    maxProcesses: number;
  };
  /** Present only for dynamic operations, and only when authorized. */
  authorization?: { scope: string; statement: string } | null;
}

export interface AnalyzerResponse {
  ok: boolean;
  operation: AnalyzerOperation;
  /** Structured evidence from the service, exactly as it answered. */
  result: Record<string, unknown> | null;
  /** The service's own tool inventory (tool-inventory only). */
  tools: Array<{ id: string; title: string }> | null;
  durationMs: number;
  truncated: boolean;
  error: string | null;
}

export interface AnalyzerClientConfig {
  url: string;
  timeoutMs: number;
  apiKey: string | null;
  /** DEMO's SSRF guard; the service URL is validated on every call. */
  guard: (url: string) => Promise<string>;
}

const MAX_ANALYZER_RESPONSE_BYTES = 512 * 1024;
const MAX_ANALYZER_TARGET_BYTES = 32 * 1024 * 1024;

export class AnalyzerUnavailableError extends Error {
  readonly code = "capability_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "AnalyzerUnavailableError";
  }
}

/**
 * Run one allow-listed operation against the configured analysis service.
 *
 * Never throws for a service-side failure: an analysis service is optional work
 * and must not turn a successful static analysis into an error result.
 */
export async function runAnalyzerOperation(config: AnalyzerClientConfig, request: AnalyzerRequest): Promise<AnalyzerResponse> {
  const started = Date.now();
  const finish = (partial: Partial<AnalyzerResponse>): AnalyzerResponse => ({
    ok: false,
    operation: request.operation,
    result: null,
    tools: null,
    durationMs: Date.now() - started,
    truncated: false,
    error: null,
    ...partial,
  });

  if (!isAnalyzerOperation(request.operation)) {
    return finish({ error: `Refused: "${String(request.operation)}" is not an allow-listed analysis operation.` });
  }
  if (request.bytes.byteLength > MAX_ANALYZER_TARGET_BYTES) {
    return finish({ error: `The target is ${request.bytes.byteLength} bytes, above the ${MAX_ANALYZER_TARGET_BYTES}-byte analysis-service limit.` });
  }

  let endpoint: string;
  try {
    endpoint = await config.guard(`${config.url}/v1/analyze`);
  } catch (error) {
    return finish({ error: `The analysis service endpoint was refused by DEMO's SSRF guard: ${error instanceof Error ? error.message : String(error)}` });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        operation: request.operation,
        target: {
          name: request.targetName,
          // Base64 keeps the JSON body binary-safe for any transport.
          data_base64: bytesToBase64(request.bytes),
        },
        ...(request.selector ? { selector: request.selector } : {}),
        limits: request.limits,
        ...(request.authorization ? { authorization: request.authorization } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return finish({ error: `The analysis service answered HTTP ${response.status}: ${text.slice(0, 200)}` });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      return finish({ error: `The analysis service answered with an unexpected content type (${contentType || "none"}).` });
    }
    const raw = await response.text();
    if (raw.length > MAX_ANALYZER_RESPONSE_BYTES) {
      return finish({ error: `The analysis service response is ${raw.length} bytes, above the ${MAX_ANALYZER_RESPONSE_BYTES}-byte read cap.`, truncated: true });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return finish({ error: "The analysis service response was not valid JSON." });
    }
    const tools = Array.isArray(parsed.tools)
      ? (parsed.tools as Array<{ id?: unknown; title?: unknown }>)
          .filter((tool) => typeof tool?.id === "string")
          .map((tool) => ({ id: String(tool.id), title: String(tool.title ?? tool.id) }))
      : null;
    return {
      ok: parsed.ok !== false,
      operation: request.operation,
      result: (parsed.result && typeof parsed.result === "object" ? (parsed.result as Record<string, unknown>) : null),
      tools,
      durationMs: Date.now() - started,
      truncated: Boolean(parsed.truncated),
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ error: controller.signal.aborted ? `The analysis service did not answer within ${config.timeoutMs} ms.` : `The analysis service request failed: ${message}` });
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the service which tools it actually has. Never blocks the analysis. */
export async function fetchServiceInventory(config: AnalyzerClientConfig): Promise<Array<{ id: string; title: string }> | null> {
  const response = await runAnalyzerOperation(config, {
    operation: "tool-inventory",
    bytes: new Uint8Array(),
    targetName: "inventory",
    limits: { cpuMs: 0, wallMs: Math.min(config.timeoutMs, 5_000), memoryMb: 0, network: "none", maxProcesses: 0 },
  });
  return response.tools ?? null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
