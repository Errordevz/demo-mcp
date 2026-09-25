/**
 * The shared System One HTTP contract used by every typed-decision provider.
 *
 * Both providers speak the same Jev-compatible API:
 *
 *   POST <endpoint>            (TypeSafe: pinned https://api.typesafe.ai/v1/systemone,
 *                               Laya: `${LAYA_BASE_URL}/v1/systemone`, SSRF-guarded)
 *   Authorization: Bearer <key> (TypeSafe: required secret; Laya: only when configured)
 *   { "state": …, "model": …, "questions": { "<id>": { … } } }
 *   → { "model": …, "answers": { "<id>": { … } }, "usage": {…} }
 *
 * This module is the single implementation of that contract: request building,
 * answer validation, the bounded retry loop and failure classification. Providers
 * differ only in the {@link SystemOneProviderDescriptor} they pass in — endpoint,
 * credential, label and the wording of operator-facing hints — so fixing the
 * contract once fixes it for every provider, and no provider re-implements (or
 * weakens) validation.
 *
 * The TypeSafe/Jev adapter (`src/jev/client.ts`) passes the exact strings the
 * original bespoke client produced; the Laya adapter (`src/laya/client.ts`)
 * passes its own. Everything a provider says is untrusted input: free text is
 * capped and run through the descriptor's sanitizer before it can reach a DEMO
 * result, and an answer outside the asked option set is a hard failure, never a
 * guess.
 */

import { BrowserError } from "../core/errors.js";
import { redactText } from "../core/redact.js";
import type { DecisionAnswer, DecisionProviderName, DecisionQuestionSpec } from "./types.js";

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/**
 * Size and shape caps a provider call imposes on itself. Numerically identical for
 * both providers today (JEV_LIMITS / LAYA_LIMITS): the budget exists because a
 * decision runs inside an MCP tool call and a Cloudflare Worker request, which is
 * provider-independent DEMO policy.
 */
export interface SystemOneLimits {
  /** Characters of `state` sent in one request. Longer input is truncated and reported. */
  maxStateChars: number;
  /** Questions per request. Providers evaluate them in parallel in one call. */
  maxQuestions: number;
  /** Options in a Choice. Kept small so the distribution stays meaningful. */
  maxChoiceOptions: number;
  minChoiceOptions: number;
  /** Levels in a Score rubric. Must be ordered and ≥ 2 per the docs. */
  maxScoreLevels: number;
  minScoreLevels: number;
  /** Instructions/criteria text length caps (input is untrusted in the decide tool). */
  maxInstructionChars: number;
  maxCriterionChars: number;
  /** Request timeout defaults and bounds. */
  defaultTimeoutMs: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  /** One retry, only for 429/5xx/529, honouring `retry-after` up to this delay. */
  maxRetryDelayMs: number;
  /** Confidence floor below which a decision is not acted on (DEMO policy). */
  defaultReviewThreshold: number;
  minReviewThreshold: number;
  maxReviewThreshold: number;
  /** Confidence at which a decision is trusted for a low-stakes routing change. */
  defaultAcceptThreshold: number;
}

/**
 * Everything about one concrete provider that the generic contract needs.
 * Contains the credential *header value* (or null) but never stores anything else
 * credential-shaped; the descriptor is built per call and not retained.
 */
export interface SystemOneProviderDescriptor {
  provider: DecisionProviderName;
  /** Human label used in error text: "TypeSafe" / "Laya". */
  label: string;
  /** Stable capability id for `capability_unavailable` errors. */
  capability: string;
  /** Absolute request URL, already SSRF-checked by the provider adapter. */
  endpoint: string;
  /** Full Authorization header value (`Bearer …`) or null for an unauthenticated server. */
  authorization: string | null;
  model: string;
  timeoutMs: number;
  limits: SystemOneLimits;
  /**
   * Sanitizer for provider-controlled text before it can appear in a DEMO result
   * (error details, the echoed model id). TypeSafe uses the standard redactor;
   * Laya — an arbitrary externally hosted server — uses the stricter
   * `sanitizeUntrustedProviderText`.
   */
  sanitize: (text: string, max: number) => string;
  /** Provider-specific wording for operator-facing messages. */
  messages: {
    /** Timeout hint (names the matching timeout variable). */
    timeout: (timeoutMs: number) => string;
    /** Hint when the host cannot be reached at all. */
    unreachable: string;
    /** Message + hint for HTTP 401/403. */
    rejection: { message: string; hint: (providerDetail: string) => string };
    /** Final no-retry hint for 5xx/529. */
    overloadedNoRetry: string;
  };
}

export interface SystemOneAskInput {
  state: unknown;
  questions: Record<string, DecisionQuestionSpec>;
  fetchImpl?: FetchLike;
  /** Overrides the descriptor timeout for one call (used by workflow hooks). */
  timeoutMs?: number;
}

export interface SystemOneAskResult {
  provider: DecisionProviderName;
  /** The versioned model id that answered, e.g. `jev-1.13.0`. */
  model: string | null;
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** HTTP requests actually made (1, or 2 when a documented retry fired). */
  attempts: number;
  stateChars: number;
  stateTruncated: boolean;
}

const QUESTION_ID = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Provider text is untrusted input: cap it and strip anything credential-shaped,
 * and never let a newline smuggle a second log line. The descriptor's sanitizer
 * decides how strict "credential-shaped" is for the provider in question.
 */
function detail(descriptor: SystemOneProviderDescriptor, value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return descriptor.sanitize(text, 240) || fallback;
}

/** Validate + serialise the request. Throws `invalid_input` rather than sending junk. */
export function buildSystemOneRequest(
  descriptor: Pick<SystemOneProviderDescriptor, "label" | "limits" | "model">,
  input: Pick<SystemOneAskInput, "state" | "questions">,
): { body: string; chars: number; truncated: boolean } {
  const { limits } = descriptor;
  const entries = Object.entries(input.questions ?? {});
  if (!entries.length || entries.length > limits.maxQuestions) {
    throw new BrowserError("invalid_input", `A decision request holds 1-${limits.maxQuestions} questions.`, {
      hint: `Ask narrow questions in one request: ${descriptor.label} evaluates them in parallel and answers them independently.`,
    });
  }

  const questions: Record<string, Record<string, unknown>> = {};
  for (const [id, spec] of entries) {
    if (!QUESTION_ID.test(id)) {
      throw new BrowserError("invalid_input", `Question id "${redactText(id, 48)}" must match ${QUESTION_ID}.`, {
        hint: "Question ids are keys for your code; the documented shape is lowercase letters, digits and underscores.",
      });
    }
    const instructions = typeof spec.instructions === "string" ? spec.instructions.trim() : "";
    if (!instructions) throw new BrowserError("invalid_input", `Question "${id}" needs instructions.`);

    if (spec.type === "noul") {
      const criteria: Record<string, string> = {};
      if (spec.criteria?.true) criteria.true = spec.criteria.true.slice(0, limits.maxCriterionChars);
      if (spec.criteria?.false) criteria.false = spec.criteria.false.slice(0, limits.maxCriterionChars);
      questions[id] = { type: "noul", instructions: instructions.slice(0, limits.maxInstructionChars), ...(Object.keys(criteria).length ? { criteria } : {}) };
      continue;
    }

    if (spec.type === "choice") {
      const options = Object.entries(spec.criteria ?? {});
      if (options.length < limits.minChoiceOptions || options.length > limits.maxChoiceOptions) {
        throw new BrowserError("invalid_input", `Choice question "${id}" needs ${limits.minChoiceOptions}-${limits.maxChoiceOptions} options.`, {
          hint: "Define every allowed answer in code, including a no-match option when nothing else may fit.",
        });
      }
      const criteria: Record<string, string | null> = {};
      for (const [option, description] of options) {
        criteria[option] = typeof description === "string" ? redactText(description, limits.maxCriterionChars) : null;
      }
      questions[id] = { type: "choice", instructions: instructions.slice(0, limits.maxInstructionChars), criteria };
      continue;
    }

    if (spec.type === "score") {
      const levels = (Array.isArray(spec.criteria) ? spec.criteria : []).map((level) => redactText(String(level), limits.maxCriterionChars)).filter(Boolean);
      if (levels.length < limits.minScoreLevels || levels.length > limits.maxScoreLevels) {
        throw new BrowserError("invalid_input", `Score question "${id}" needs ${limits.minScoreLevels}-${limits.maxScoreLevels} ordered levels.`, {
          hint: "Each level must describe a concrete situation on its own; the API requires at least two.",
        });
      }
      questions[id] = { type: "score", instructions: instructions.slice(0, limits.maxInstructionChars), criteria: levels };
      continue;
    }

    throw new BrowserError("invalid_input", `Question "${id}" has an unsupported type "${redactText(String((spec as { type?: unknown }).type), 32)}".`, {
      hint: `${descriptor.label}'s documented question types are noul, choice and score.`,
    });
  }

  const serialized = (() => {
    try {
      return typeof input.state === "string" ? input.state : JSON.stringify(input.state ?? null) ?? "";
    } catch {
      return String(input.state ?? "");
    }
  })();
  const truncated = serialized.length > limits.maxStateChars;
  const state = truncated ? `${serialized.slice(0, limits.maxStateChars)}\n[truncated by DEMO]` : serialized;

  return {
    body: JSON.stringify({ state, model: descriptor.model, questions }),
    chars: state.length,
    truncated,
  };
}

/** Validate one answer against the question we asked. Anything else is a hard failure. */
export function validateSystemOneAnswer(
  descriptor: Pick<SystemOneProviderDescriptor, "label" | "limits">,
  id: string,
  spec: DecisionQuestionSpec,
  raw: unknown,
): DecisionAnswer {
  const { label } = descriptor;
  if (!raw || typeof raw !== "object") throw new BrowserError("validation_failed", `${label} returned no answer for "${id}".`, { data: { question: id } });
  const answer = raw as Record<string, unknown>;
  const type = answer.type;

  const probability = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

  if (spec.type === "noul") {
    if (type !== "noul") throw new BrowserError("validation_failed", `${label} answered "${id}" as ${redactText(String(type), 24)} instead of noul.`, { data: { question: id } });
    const noul = probability(answer.noul);
    if (noul === null) throw new BrowserError("validation_failed", `${label} returned an out-of-range noul for "${id}".`, { data: { question: id } });
    return { type: "noul", noul };
  }

  const confidence = probability(answer.confidence);
  if (confidence === null) {
    throw new BrowserError("validation_failed", `${label} returned no usable confidence for "${id}".`, {
      hint: "Confidence is documented on every Choice and Score answer; without it DEMO cannot decide whether to act.",
      data: { question: id },
    });
  }

  if (spec.type === "choice") {
    if (type !== "choice") throw new BrowserError("validation_failed", `${label} answered "${id}" as ${redactText(String(type), 24)} instead of choice.`, { data: { question: id } });
    const allowed = Object.keys(spec.criteria ?? {});
    const choice = typeof answer.choice === "string" ? answer.choice : "";
    if (!allowed.includes(choice)) {
      throw new BrowserError("validation_failed", `${label} selected an option this decision does not allow.`, {
        hint: `Allowed options are ${allowed.join(", ")}. An unexpected answer is treated as no answer: DEMO keeps its own deterministic result.`,
        data: { question: id, received: redactText(choice, 48) },
      });
    }
    const source = (answer.probabilities ?? {}) as Record<string, unknown>;
    const probabilities: Record<string, number> = {};
    for (const option of allowed) {
      const value = probability(source[option]);
      // An omitted option is read as 0 rather than treated as a failure: `choice` and
      // `confidence` are what this code acts on, and the distribution is auxiliary
      // evidence. An out-of-range or non-numeric value, though, is a real violation.
      if (source[option] === undefined || source[option] === null) {
        probabilities[option] = 0;
        continue;
      }
      if (value === null) {
        throw new BrowserError("validation_failed", `${label} returned an invalid probability for option "${redactText(option, 40)}" of "${id}".`, { data: { question: id } });
      }
      probabilities[option] = value;
    }
    return { type: "choice", choice, probabilities, confidence };
  }

  if (type !== "score") throw new BrowserError("validation_failed", `${label} answered "${id}" as ${redactText(String(type), 24)} instead of score.`, { data: { question: id } });
  const score = typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : null;
  if (score === null) throw new BrowserError("validation_failed", `${label} returned a non-numeric score for "${id}".`, { data: { question: id } });
  const legendSource = (answer.legend ?? {}) as Record<string, unknown>;
  const legend: Record<string, string> = {};
  for (const [level, description] of Object.entries(legendSource)) {
    if (/^\d+$/.test(level) && typeof description === "string") legend[level] = redactText(description, descriptor.limits.maxCriterionChars);
  }
  const probabilities: Record<string, number> = {};
  for (const [level, value] of Object.entries((answer.probabilities ?? {}) as Record<string, unknown>)) {
    const probabilityValue = probability(value);
    if (probabilityValue !== null) probabilities[level] = probabilityValue;
  }
  return { type: "score", score, legend, probabilities, confidence };
}

function retryDelayMs(limits: SystemOneLimits, response: Response, attempt: number): number | null {
  if (response.status !== 429 && response.status !== 529 && response.status < 500) return null;
  const header = Number(response.headers.get("retry-after"));
  // One bounded backoff, per the documented guidance to retry 429/529 with a delay
  // rather than immediately. A caller-supplied delay is clamped so a decision can
  // never hold a tool request open for minutes.
  const wait = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, limits.maxRetryDelayMs) : Math.min(200 * 2 ** attempt, limits.maxRetryDelayMs);
  return Math.max(50, wait);
}

function classifyFailure(descriptor: SystemOneProviderDescriptor, status: number, body: string, willRetry: boolean): BrowserError {
  let providerDetail = "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const raw = parsed?.detail ?? parsed?.error ?? parsed?.message ?? parsed;
    providerDetail = detail(descriptor, raw, "");
  } catch {
    providerDetail = "";
  }

  const { label } = descriptor;
  if (status === 401 || status === 403) {
    return new BrowserError("capability_unavailable", descriptor.messages.rejection.message, {
      hint: descriptor.messages.rejection.hint(providerDetail),
      capability: descriptor.capability,
      data: { httpStatus: status },
    });
  }
  if (status === 422) {
    return new BrowserError("validation_failed", `${label} rejected the question set.`, {
      hint: `This is a bug in the question definition, not in your input.${providerDetail ? ` ${label} said: ${providerDetail}` : ""}`,
      data: { httpStatus: status, detail: providerDetail || undefined },
    });
  }
  if (status === 429) {
    return new BrowserError("rate_limited", `${label} rate limited this decision.`, {
      retryable: true,
      hint: willRetry ? "Retrying once after a short backoff." : "DEMO self-limits decisions; the workflow continued on its deterministic path.",
      data: { httpStatus: status, detail: providerDetail || undefined },
    });
  }
  if (status === 529 || status >= 500) {
    return new BrowserError("PROVIDER_UNAVAILABLE", `${label} returned HTTP ${status}.`, {
      retryable: true,
      hint: willRetry ? "Retrying once after a short backoff." : descriptor.messages.overloadedNoRetry,
      data: { httpStatus: status, detail: providerDetail || undefined },
    });
  }
  return new BrowserError("internal", `${label} returned HTTP ${status}.`, {
    data: { httpStatus: status, detail: providerDetail || undefined },
    hint: "Unexpected status for the documented contract (200, 401, 422, 429, 529).",
  });
}

/**
 * Ask a set of typed questions in a single request against one provider.
 *
 * Failures are always a `BrowserError` with a stable code so the router can fall
 * back without inspecting text: `capability_unavailable` (rejected credential),
 * `invalid_input` (our own validation), `validation_failed` (a malformed or
 * out-of-contract answer), `rate_limited` (429 after one retry), `timeout` and
 * `PROVIDER_UNAVAILABLE` (5xx/529/network). Availability prechecks ("is this
 * provider even configured?") live in the provider adapters, which know each
 * provider's own configuration story. Nothing here ever throws a raw error.
 */
export async function askSystemOne(descriptor: SystemOneProviderDescriptor, input: SystemOneAskInput): Promise<SystemOneAskResult> {
  const { limits } = descriptor;
  const request = buildSystemOneRequest(descriptor, input);
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init as never));
  const timeoutMs = input.timeoutMs ?? descriptor.timeoutMs;
  const attempts = limits.maxRetryDelayMs > 0 ? 2 : 1;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (descriptor.authorization) headers.authorization = descriptor.authorization;

  let lastError: BrowserError | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(descriptor.endpoint, {
        method: "POST",
        headers,
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "FetchFailure";
      if (name === "TimeoutError") {
        throw new BrowserError("timeout", `${descriptor.label} did not answer within ${timeoutMs}ms.`, {
          retryable: true,
          hint: descriptor.messages.timeout(timeoutMs),
          data: { timeoutMs },
        });
      }
      throw new BrowserError("PROVIDER_UNAVAILABLE", `Could not reach ${new URL(descriptor.endpoint).host}.`, {
        retryable: true,
        hint: descriptor.messages.unreachable,
        data: { cause: name },
      });
    }

    if (response.ok) {
      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new BrowserError("validation_failed", `${descriptor.label} returned a non-JSON response.`, { retryable: true, data: { status: response.status } });
      }
      const answers = (payload?.answers ?? {}) as Record<string, unknown>;
      const validated: Record<string, DecisionAnswer> = {};
      for (const [id, spec] of Object.entries(input.questions)) {
        validated[id] = validateSystemOneAnswer(descriptor, id, spec, answers[id]);
      }
      const usage = (payload?.usage ?? {}) as Record<string, unknown>;
      const token = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
      return {
        provider: descriptor.provider,
        // The response reports the versioned id behind an alias, which is what makes a
        // tuned threshold reproducible. Provider-controlled text, so it is sanitized.
        model: typeof payload?.model === "string" ? descriptor.sanitize(payload.model, 80) : null,
        answers: validated,
        usage: { inputTokens: token(usage.input_tokens), outputTokens: token(usage.output_tokens) },
        attempts: attempt + 1,
        stateChars: request.chars,
        stateTruncated: request.truncated,
      };
    }

    const body = await response.text().catch(() => "");
    const waitMs = retryDelayMs(limits, response, attempt);
    const error = classifyFailure(descriptor, response.status, body, waitMs !== null && attempt + 1 < attempts);
    if (waitMs === null || attempt + 1 >= attempts) throw error;
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw lastError ?? new BrowserError("PROVIDER_UNAVAILABLE", `${descriptor.label} did not return a decision.`, { retryable: true });
}
