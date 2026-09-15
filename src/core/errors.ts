/**
 * Error taxonomy shared by the browser subsystem.
 *
 * Tools convert every failure into a `BrowserError` so the MCP layer can
 * return a stable, machine readable shape instead of leaking raw stack traces,
 * cookies or headers to the model.
 */

export type BrowserErrorCode =
  | "invalid_input"
  | "validation_failed"
  | "blocked_url"
  | "capability_unavailable"
  | "browser_unavailable"
  | "session_not_found"
  | "session_expired"
  | "session_busy"
  | "page_not_found"
  | "navigation_failed"
  | "element_not_found"
  | "timeout"
  | "challenge_required"
  | "size_limit_exceeded"
  | "rate_limited"
  | "unsupported"
  | "internal";

export interface BrowserErrorDetails {
  code: BrowserErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  capability?: string;
  data?: Record<string, unknown>;
}

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly capability?: string;
  readonly data?: Record<string, unknown>;

  constructor(
    code: BrowserErrorCode,
    message: string,
    options: { hint?: string; retryable?: boolean; capability?: string; data?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.capability = options.capability;
    this.data = options.data;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toJSON(): BrowserErrorDetails {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      retryable: this.retryable,
      ...(this.capability ? { capability: this.capability } : {}),
      ...(this.data ? { data: this.data } : {}),
    };
  }
}

export function isBrowserError(error: unknown): error is BrowserError {
  return error instanceof BrowserError;
}

/**
 * Errors that cross a Durable Object RPC boundary lose their class, so the
 * details are encoded into the message and decoded again on the other side.
 */
const RPC_MARKER = "DEMO_BROWSER_ERROR:";

export function encodeForRpc(error: unknown): Error {
  const info = describeError(error);
  return new Error(`${RPC_MARKER}${JSON.stringify(info)}`);
}

function decodeRpcMessage(message: string): BrowserErrorDetails | null {
  if (!message.startsWith(RPC_MARKER)) return null;
  try {
    const parsed = JSON.parse(message.slice(RPC_MARKER.length)) as BrowserErrorDetails;
    return typeof parsed?.code === "string" && typeof parsed?.message === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Human readable, redaction-safe description of any thrown value. */
export function describeError(error: unknown): BrowserErrorDetails {
  if (isBrowserError(error)) return error.toJSON();
  const raw = error instanceof Error ? error.message : String(error);
  const decoded = decodeRpcMessage(raw);
  if (decoded) return decoded;
  const code = classifyMessage(raw);
  const hint = hintFor(code, raw);
  return { code, message: raw, retryable: code === "rate_limited", ...(hint ? { hint } : {}) };
}

const TIMEOUT_HINTS = /timeout|timed out|navigation timeout|waiting for .* failed/i;
const RATE_HINTS = /429|too many requests|rate limit|browser instance limit|allowedBrowserAcquisitions/i;
const SESSION_HINTS = /unable to connect to existing session|session .*(closed|expired|not found)|browser has been closed|target closed|most likely the page has been closed/i;
const NAV_HINTS = /net::ERR|navigation failed|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_ABORTED/i;
const ELEMENT_HINTS = /no (node|element) found for selector|waiting for selector|failed to find element|not clickable|node is either not clickable/i;
/**
 * Browser Rendering has no local emulation: `wrangler dev` without `--remote`
 * fails when the Worker tries to launch a browser. That is a deployment
 * problem, not a bug in the request, so it is reported as a capability.
 */
const LOCAL_DEV_HINTS = /miniflare loopback|failed to launch local browser|\/browser\/launch|no browser service|browser rendering is not available/i;

function classifyMessage(message: string): BrowserErrorCode {
  if (LOCAL_DEV_HINTS.test(message)) return "capability_unavailable";
  if (TIMEOUT_HINTS.test(message)) return "timeout";
  if (RATE_HINTS.test(message)) return "rate_limited";
  if (SESSION_HINTS.test(message)) return "session_expired";
  if (NAV_HINTS.test(message)) return "navigation_failed";
  if (ELEMENT_HINTS.test(message)) return "element_not_found";
  return "internal";
}

/** Actionable next step for a classified failure. */
function hintFor(code: BrowserErrorCode, message: string): string | undefined {
  switch (code) {
    case "capability_unavailable":
      if (LOCAL_DEV_HINTS.test(message)) {
        return "Cloudflare Browser Rendering cannot run in local `wrangler dev` mode. Use `wrangler dev --remote` (or deploy the Worker) so the real Browser Run binding is available.";
      }
      return undefined;
    case "rate_limited":
      return "Browser Run hit a concurrency or acquisition limit. Retry shortly; Workers Paid allows 200 concurrent sessions and 3 new sessions per second (Free: 3 concurrent, 1 per 20s, 10 browser-minutes per day).";
    case "session_expired":
      return "The browser session is gone. Call browser_open again to start a fresh session.";
    case "timeout":
      return "The operation exceeded its time budget. Increase the timeout, or wait for a specific selector with browser_wait before inspecting the page.";
    case "navigation_failed":
      return "The page could not be loaded. Some sites block Cloudflare Browser Run traffic, which is always identified as bot traffic.";
    default:
      return undefined;
  }
}

export function browserError(
  code: BrowserErrorCode,
  message: string,
  options?: { hint?: string; retryable?: boolean; capability?: string; data?: Record<string, unknown> },
): BrowserError {
  return new BrowserError(code, message, options);
}

/** Normalise any thrown value into a `BrowserError` with a stable code. */
export function asBrowserError(error: unknown): BrowserError {
  if (isBrowserError(error)) return error;
  const info = describeError(error);
  return new BrowserError(info.code, info.message, { retryable: info.retryable, hint: info.hint, cause: error });
}

/** Capability is missing (binding not configured, plan too low, unsupported platform). */
export function capabilityUnavailable(capability: string, message: string, hint?: string): BrowserError {
  return new BrowserError("capability_unavailable", message, { capability, hint, retryable: false });
}
