/**
 * TypeSafe / Jev decision-engine configuration.
 *
 * TypeSafe is the provider; **Jev** is its flagship System One model. A System One
 * model does not generate text: it takes `state` plus a map of typed questions
 * (`noul` / `choice` / `score`) and returns typed answers with probabilities, which
 * is why this integration can consume them without parsing prose.
 *
 * Contract used here (read from the live docs on 2026-09-17, docs.typesafe.ai/api):
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <TYPESAFE_API_KEY>
 *   { "state": …, "model": "jev-latest", "questions": { "<id>": { … } } }
 *   → { "model": "jev-1.13.0", "answers": { "<id>": { … } }, "usage": {…} }
 *
 * The endpoint is pinned like the Roblox endpoints are: a misconfigured variable must
 * never be able to point the API key at a different host. Only the model id, the
 * timeout and the review threshold are configurable, and none of them is a secret.
 */

/** Documented model alias resolving to the latest stable release (`jev-1.13.0`). */
export const JEV_DEFAULT_MODEL = "jev-latest";
export const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai";
export const JEV_EVALUATE_PATH = "/v1/systemone";
export const JEV_MODELS_PATH = "/v1/models";

/**
 * Size and shape caps this integration imposes on itself. The API's own documented
 * limits are looser (a Choice accepts up to 255 options); these exist because a
 * decision runs inside an MCP tool call and a Cloudflare Worker request.
 */
export const JEV_LIMITS = {
  /** Characters of `state` sent in one request. Longer input is truncated and reported. */
  maxStateChars: 8_000,
  /** Questions per request. TypeSafe evaluates them in parallel in one call. */
  maxQuestions: 16,
  /** Options in a Choice. Kept small so the distribution stays meaningful. */
  maxChoiceOptions: 32,
  minChoiceOptions: 2,
  /** Levels in a Score rubric. Must be ordered and ≥ 2 per the docs. */
  maxScoreLevels: 10,
  minScoreLevels: 2,
  /** Instructions/criteria text length caps (input is untrusted in `jev_decide`). */
  maxInstructionChars: 1_200,
  maxCriterionChars: 600,
  /** Request timeout. Jev is documented as a fast decision model; a slow call is
   * abandoned rather than stalling the workflow that asked for it. */
  defaultTimeoutMs: 2_500,
  minTimeoutMs: 250,
  maxTimeoutMs: 15_000,
  /** One retry, only for 429/5xx/529, honouring `retry-after` up to this delay. */
  maxRetryDelayMs: 1_500,
  /** Confidence floor below which a decision is not acted on. */
  defaultReviewThreshold: 0.5,
  minReviewThreshold: 0,
  maxReviewThreshold: 0.99,
  /** Confidence at which a decision is trusted for a low-stakes routing change. */
  defaultAcceptThreshold: 0.7,
} as const;

export interface JevEnv {
  /** Worker secret. Never a `vars` entry, never returned by any endpoint. */
  TYPESAFE_API_KEY?: string;
  /** Master switch. Any form of false/0/off/no disables the engine. */
  TYPESAFE_ENABLED?: string | boolean;
  /** Model id or alias. Default `jev-latest`; pin a version if you tune thresholds. */
  TYPESAFE_MODEL?: string;
  TYPESAFE_DECISION_TIMEOUT_MS?: string | number;
  /** Below this, a decision is reported and ignored rather than acted on. */
  TYPESAFE_REVIEW_THRESHOLD?: string | number;
  /** At or above this, a low-stakes decision is applied without a review flag. */
  TYPESAFE_ACCEPT_THRESHOLD?: string | number;
}

export interface JevConfig {
  /** Ready to call: enabled and holding an API key. */
  available: boolean;
  /** `TYPESAFE_ENABLED` resolved (default: on when a key exists). */
  enabled: boolean;
  /** Why it is off/unusable, in user-facing terms. Never mentions the key value. */
  disabledReason: string | null;
  /** Presence only — the key itself is read at call time from `env`. */
  apiKeyPresent: boolean;
  model: string;
  timeoutMs: number;
  /** Confidence floor for acting on a Choice/Score answer. */
  reviewThreshold: number;
  /** Confidence at which a low-stakes routing change is applied automatically. */
  acceptThreshold: number;
  endpoint: string;
  modelsEndpoint: string;
  limits: typeof JEV_LIMITS;
}

const FALSY = new Set(["false", "0", "off", "no", "disable", "disabled", ""]);

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

/**
 * Resolve the deployment's decision-engine settings.
 *
 * Deliberately synchronous and allocation-free: `demo_ping`, `/health` and the
 * capability report call it on every request, and `/health` must answer even when
 * nothing is configured.
 */
export function resolveJevConfig(env: Record<string, unknown> | undefined): JevConfig {
  const values = (env ?? {}) as JevEnv;
  const apiKey = typeof values.TYPESAFE_API_KEY === "string" ? values.TYPESAFE_API_KEY.trim() : "";
  const wantsEnabled = flag(values.TYPESAFE_ENABLED, true);
  const enabled = wantsEnabled && apiKey.length > 0;

  let disabledReason: string | null = null;
  if (!apiKey) {
    disabledReason = "Set the TYPESAFE_API_KEY secret on this Worker to enable it.";
  } else if (!wantsEnabled) {
    disabledReason = "TYPESAFE_ENABLED is false, so DEMO uses its own deterministic rules.";
  }

  const reviewThreshold = number(values.TYPESAFE_REVIEW_THRESHOLD, JEV_LIMITS.defaultReviewThreshold, JEV_LIMITS.minReviewThreshold, JEV_LIMITS.maxReviewThreshold);
  const configuredAccept = number(values.TYPESAFE_ACCEPT_THRESHOLD as string | number | undefined, JEV_LIMITS.defaultAcceptThreshold, 0, 0.99);

  return {
    available: enabled,
    enabled,
    disabledReason,
    apiKeyPresent: apiKey.length > 0,
    model: typeof values.TYPESAFE_MODEL === "string" && values.TYPESAFE_MODEL.trim() ? values.TYPESAFE_MODEL.trim().slice(0, 80) : JEV_DEFAULT_MODEL,
    timeoutMs: number(values.TYPESAFE_DECISION_TIMEOUT_MS, JEV_LIMITS.defaultTimeoutMs, JEV_LIMITS.minTimeoutMs, JEV_LIMITS.maxTimeoutMs),
    reviewThreshold,
    // A floor above the review threshold would make the engine unusable, so the
    // accept bar can never sit below it.
    acceptThreshold: Math.max(reviewThreshold, configuredAccept),
    endpoint: `${TYPESAFE_API_ORIGIN}${JEV_EVALUATE_PATH}`,
    modelsEndpoint: `${TYPESAFE_API_ORIGIN}${JEV_MODELS_PATH}`,
    limits: JEV_LIMITS,
  };
}

/** Presence-only flags for `demo_ping`, `/health` and `/platform/stats`. */
export function jevFlags(env: Record<string, unknown> | undefined): Record<string, boolean | string> {
  const config = resolveJevConfig(env);
  return {
    jevDecisionEngine: config.available,
    jevApiKeyConfigured: config.apiKeyPresent,
    jevModel: config.model,
  };
}
