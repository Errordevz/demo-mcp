/**
 * Laya decision-provider configuration.
 *
 * **Laya** is an external typed-decision server that speaks the same Jev-compatible
 * System One API as TypeSafe: `POST /v1/systemone` with `state` + typed questions
 * (`noul` / `choice` / `score`) → typed answers with probabilities. Like Jev, it is
 * a *decision provider*, not a chat model: DEMO only ever asks it to choose among
 * options enumerated in code.
 *
 * Unlike TypeSafe, the Laya endpoint is **externally configurable** — the server may
 * be hosted anywhere, and DEMO never ships, hard-codes or bundles a Laya endpoint,
 * credential or model. `LAYA_BASE_URL` is operator-supplied configuration, which
 * makes it exactly the kind of value that must not become an SSRF bypass: it is
 * validated here at resolution time (https-only, no embedded credentials, no
 * query/hash) and re-checked against DEMO's full URL guard at call time in
 * `src/laya/client.ts` (private/link-local/metadata ranges, blocked ports and a
 * DNS-over-HTTPS resolution under the deployment's SSRF_DNS_* policy).
 *
 * `LAYA_API_KEY` is optional (some Laya servers are unauthenticated): it is a Worker
 * secret, read from `env` at call time and sent as exactly one `Authorization:
 * Bearer …` header. It is never stored on the resolved config, never placed in a
 * URL, and never returned by any status surface — presence is reported as a boolean
 * only.
 */

import type { SystemOneLimits } from "../decisions/systemone.js";

/** Default model id sent to the Laya server; pin whatever your deployment serves. */
export const LAYA_DEFAULT_MODEL = "laya-latest";
/** The Jev-compatible decision path, appended to LAYA_BASE_URL. */
export const LAYA_SYSTEMONE_PATH = "/v1/systemone";

/**
 * Size and shape caps for a Laya decision. Numerically identical to the Jev policy
 * on purpose: the budget exists because a decision runs inside an MCP tool call and
 * a Cloudflare Worker request, which is provider-independent DEMO policy.
 */
export const LAYA_LIMITS: SystemOneLimits = {
  maxStateChars: 8_000,
  maxQuestions: 16,
  maxChoiceOptions: 32,
  minChoiceOptions: 2,
  maxScoreLevels: 10,
  minScoreLevels: 2,
  maxInstructionChars: 1_200,
  maxCriterionChars: 600,
  defaultTimeoutMs: 2_500,
  minTimeoutMs: 250,
  maxTimeoutMs: 15_000,
  maxRetryDelayMs: 1_500,
  defaultReviewThreshold: 0.5,
  minReviewThreshold: 0,
  maxReviewThreshold: 0.99,
  defaultAcceptThreshold: 0.7,
} as const;

export interface LayaEnv {
  /** Master switch. Any form of false/0/off/no disables the provider. */
  LAYA_ENABLED?: string | boolean;
  /** Public https origin (plus optional path prefix) of the Laya server. Not a secret. */
  LAYA_BASE_URL?: string;
  /** Optional Worker secret for servers that require a bearer credential. */
  LAYA_API_KEY?: string;
  LAYA_TIMEOUT_MS?: string | number;
  /** Model id sent in `model`. Default `laya-latest`. */
  LAYA_MODEL?: string;
}

export interface LayaConfig {
  /** Ready to call: enabled and holding a usable base URL. */
  available: boolean;
  /** `LAYA_ENABLED` resolved (default: on). */
  enabled: boolean;
  /** A base URL is set (it may still be unusable; see disabledReason). */
  configured: boolean;
  /** Why it is off/unusable, in user-facing terms. Never mentions the key value. */
  disabledReason: string | null;
  /** Presence only — the key itself is read at call time from `env`. */
  credentialConfigured: boolean;
  /** Normalised base URL (origin + optional path prefix, no trailing slash). */
  baseUrl: string | null;
  /** Full decision endpoint: `${baseUrl}/v1/systemone`. */
  endpoint: string | null;
  /** Hostname of the endpoint, for safe display. Never contains credentials. */
  endpointHost: string | null;
  model: string;
  timeoutMs: number;
  limits: SystemOneLimits;
}

const FALSY = new Set(["false", "0", "off", "no", "disable", "disabled", ""]);

/** Same flag/number parsing convention as src/jev/config.ts (deliberately permissive). */
function flag(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const text = value.trim().toLowerCase();
  if (!text) return fallback;
  if (FALSY.has(text)) return false;
  if (text === "true" || text === "1" || text === "on" || text === "yes" || text === "enabled" || text === "enable") return true;
  return fallback;
}

function number(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

interface ParsedBaseUrl {
  baseUrl: string | null;
  endpoint: string | null;
  endpointHost: string | null;
  problem: string | null;
}

/**
 * Shape checks only (no network): https, no embedded credentials, no query/hash.
 * The deeper SSRF checks (private ranges, blocked ports, DNS) run per call in the
 * client, because a hostname's resolution can change between deploy-time and use.
 */
function parseBaseUrl(raw: string): ParsedBaseUrl {
  if (!raw) return { baseUrl: null, endpoint: null, endpointHost: null, problem: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { baseUrl: null, endpoint: null, endpointHost: null, problem: "it is not a valid absolute URL" };
  }
  if (url.protocol !== "https:") {
    return { baseUrl: null, endpoint: null, endpointHost: null, problem: "it must use https:// so decision state never crosses the network unencrypted" };
  }
  if (url.username || url.password) {
    return { baseUrl: null, endpoint: null, endpointHost: null, problem: "it must not embed credentials (configure the Laya credential as a Worker secret instead)" };
  }
  if (url.search || url.hash) {
    return { baseUrl: null, endpoint: null, endpointHost: null, problem: "it must be an origin plus optional path prefix, with no query string or fragment" };
  }
  if (!url.hostname) {
    return { baseUrl: null, endpoint: null, endpointHost: null, problem: "it is missing a hostname" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  const baseUrl = `${url.origin}${path}`;
  return { baseUrl, endpoint: `${baseUrl}${LAYA_SYSTEMONE_PATH}`, endpointHost: url.hostname.toLowerCase(), problem: null };
}

/**
 * Resolve the deployment's Laya settings.
 *
 * Deliberately synchronous and allocation-light: `demo_ping`, `/health` and the
 * capability reports call it on every request, and `/health` must answer even when
 * nothing is configured.
 */
export function resolveLayaConfig(env: Record<string, unknown> | undefined): LayaConfig {
  const values = (env ?? {}) as LayaEnv;
  const apiKey = typeof values.LAYA_API_KEY === "string" ? values.LAYA_API_KEY.trim() : "";
  const wantsEnabled = flag(values.LAYA_ENABLED, true);
  const rawBase = typeof values.LAYA_BASE_URL === "string" ? values.LAYA_BASE_URL.trim() : "";
  const parsed = parseBaseUrl(rawBase);

  const usable = Boolean(parsed.endpoint);
  const available = wantsEnabled && usable;

  let disabledReason: string | null = null;
  if (!rawBase) {
    disabledReason = "Set LAYA_BASE_URL to the public https origin of your Laya server to enable it.";
  } else if (parsed.problem) {
    disabledReason = `LAYA_BASE_URL is not usable: ${parsed.problem}.`;
  } else if (!wantsEnabled) {
    disabledReason = "LAYA_ENABLED is false, so DEMO routes decisions elsewhere or uses its own deterministic rules.";
  }

  return {
    available,
    enabled: wantsEnabled,
    configured: Boolean(rawBase),
    disabledReason,
    credentialConfigured: apiKey.length > 0,
    baseUrl: parsed.baseUrl,
    endpoint: parsed.endpoint,
    endpointHost: parsed.endpointHost,
    model: typeof values.LAYA_MODEL === "string" && values.LAYA_MODEL.trim() ? values.LAYA_MODEL.trim().slice(0, 80) : LAYA_DEFAULT_MODEL,
    timeoutMs: number(values.LAYA_TIMEOUT_MS, LAYA_LIMITS.defaultTimeoutMs, LAYA_LIMITS.minTimeoutMs, LAYA_LIMITS.maxTimeoutMs),
    limits: LAYA_LIMITS,
  };
}

/**
 * Resolve the configured Laya endpoint host for safe display, or null.
 * A hostname is not a secret; the full URL is never reported because a configured
 * value is operator-controlled infrastructure detail.
 */
export function layaEndpointHost(env: Record<string, unknown> | undefined): string | null {
  return resolveLayaConfig(env).endpointHost;
}

/** Presence-only flags for `demo_ping`, `/health` and `/platform/stats`. */
export function layaFlags(env: Record<string, unknown> | undefined): Record<string, boolean | string> {
  const config = resolveLayaConfig(env);
  return {
    layaDecisionEngine: config.available,
    layaConfigured: config.configured,
    layaApiKeyConfigured: config.credentialConfigured,
    layaModel: config.model,
  };
}
