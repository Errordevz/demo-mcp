/**
 * TypeSafe HTTP client for Jev (System One decisions).
 *
 * This is the only place in the repository that holds a TypeSafe API key: it is read
 * from the Worker secret at call time, placed in exactly one `Authorization` header,
 * and never written into a URL, a log line, an error message or a tool result. The
 * key is deliberately *not* stored on the config object.
 *
 * Deliberately raw `fetch` rather than `@typesafe-ai/sdk`: this bundle must run on
 * the Workers runtime (the build gate asserts no Node-only code is pulled in), and the
 * documented contract is a single JSON POST. The SDK's conveniences — retry policy and
 * env-var key discovery — are reproduced here explicitly, because a tool call inside
 * an MCP request needs a bounded retry, not an open-ended one.
 */

import { BrowserError } from "../core/errors.js";
import { redactText } from "../core/redact.js";
import { JEV_LIMITS, type JevConfig } from "./config.js";

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** The request shape we accept, mirrored on the documented `Question` union. */
export type JevQuestionSpec =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface JevState {
  /** Anything JSON-serialisable. Truncated to {@link JEV_LIMITS.maxStateChars}. */
  value: unknown;
}

export interface JevAskInput {
  config: JevConfig;
  /** Passed in from `env` by the caller; never read from `config`. */
  apiKey: string;
  state: unknown;
  questions: Record<string, JevQuestionSpec>;
  fetchImpl?: FetchLike;
  /** Overrides the config timeout for one call (used by workflow hooks). */
  timeoutMs?: number;
}

export interface JevAskResult {
  /** The versioned model id that answered, e.g. `jev-1.13.0`. */
  model: string | null;
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** HTTP requests actually made (1, or 2 when a documented retry fired). */
  attempts: number;
  stateChars: number;
  stateTruncated: boolean;
}

const QUESTION_ID = /^[a-z][a-z0-9_]{0,39}$/;

function detail(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  // Provider text is untrusted input: cap it, strip anything credential-shaped, and
  // never let a newline smuggle a second log line.
  return redactText(text, 240) || fallback;
}

/** Validate + serialise the request. Throws `invalid_input` rather than sending junk. */
function buildRequestBody(input: JevAskInput): { body: string; chars: number; truncated: boolean } {
  const entries = Object.entries(input.questions ?? {});
  if (!entries.length || entries.length > JEV_LIMITS.maxQuestions) {
    throw new BrowserError("invalid_input", `A decision request holds 1-${JEV_LIMITS.maxQuestions} questions.`, {
      hint: "Ask narrow questions in one request: TypeSafe evaluates them in parallel and answers them independently.",
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
      if (spec.criteria?.true) criteria.true = spec.criteria.true.slice(0, JEV_LIMITS.maxCriterionChars);
      if (spec.criteria?.false) criteria.false = spec.criteria.false.slice(0, JEV_LIMITS.maxCriterionChars);
      questions[id] = { type: "noul", instructions: instructions.slice(0, JEV_LIMITS.maxInstructionChars), ...(Object.keys(criteria).length ? { criteria } : {}) };
      continue;
    }

    if (spec.type === "choice") {
      const options = Object.entries(spec.criteria ?? {});
      if (options.length < JEV_LIMITS.minChoiceOptions || options.length > JEV_LIMITS.maxChoiceOptions) {
        throw new BrowserError("invalid_input", `Choice question "${id}" needs ${JEV_LIMITS.minChoiceOptions}-${JEV_LIMITS.maxChoiceOptions} options.`, {
          hint: "Define every allowed answer in code, including a no-match option when nothing else may fit.",
        });
      }
      const criteria: Record<string, string | null> = {};
      for (const [option, description] of options) {
        criteria[option] = typeof description === "string" ? redactText(description, JEV_LIMITS.maxCriterionChars) : null;
      }
      questions[id] = { type: "choice", instructions: instructions.slice(0, JEV_LIMITS.maxInstructionChars), criteria };
      continue;
    }

    if (spec.type === "score") {
      const levels = (Array.isArray(spec.criteria) ? spec.criteria : []).map((level) => redactText(String(level), JEV_LIMITS.maxCriterionChars)).filter(Boolean);
      if (levels.length < JEV_LIMITS.minScoreLevels || levels.length > JEV_LIMITS.maxScoreLevels) {
        throw new BrowserError("invalid_input", `Score question "${id}" needs ${JEV_LIMITS.minScoreLevels}-${JEV_LIMITS.maxScoreLevels} ordered levels.`, {
          hint: "Each level must describe a concrete situation on its own; the API requires at least two.",
        });
      }
      questions[id] = { type: "score", instructions: instructions.slice(0, JEV_LIMITS.maxInstructionChars), criteria: levels };
      continue;
    }

    throw new BrowserError("invalid_input", `Question "${id}" has an unsupported type "${redactText(String((spec as { type?: unknown }).type), 32)}".`, {
      hint: "TypeSafe's documented question types are noul, choice and score.",
    });
  }

  const serialized = (() => {
    try {
      return typeof input.state === "string" ? input.state : JSON.stringify(input.state ?? null) ?? "";
    } catch {
      return String(input.state ?? "");
    }
  })();
  const truncated = serialized.length > JEV_LIMITS.maxStateChars;
  const state = truncated ? `${serialized.slice(0, JEV_LIMITS.maxStateChars)}\n[truncated by DEMO]` : serialized;

  return {
    body: JSON.stringify({ state, model: input.config.model, questions }),
    chars: state.length,
    truncated,
  };
}

/** Validate one answer against the question we asked. Anything else is a hard failure. */
function validateAnswer(id: string, spec: JevQuestionSpec, raw: unknown): JevAnswer {
  if (!raw || typeof raw !== "object") throw new BrowserError("validation_failed", `TypeSafe returned no answer for "${id}".`, { data: { question: id } });
  const answer = raw as Record<string, unknown>;
  const type = answer.type;

  const probability = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

  if (spec.type === "noul") {
    if (type !== "noul") throw new BrowserError("validation_failed", `TypeSafe answered "${id}" as ${redactText(String(type), 24)} instead of noul.`, { data: { question: id } });
    const noul = probability(answer.noul);
    if (noul === null) throw new BrowserError("validation_failed", `TypeSafe returned an out-of-range noul for "${id}".`, { data: { question: id } });
    return { type: "noul", noul };
  }

  const confidence = probability(answer.confidence);
  if (confidence === null) {
    throw new BrowserError("validation_failed", `TypeSafe returned no usable confidence for "${id}".`, {
      hint: "Confidence is documented on every Choice and Score answer; without it DEMO cannot decide whether to act.",
      data: { question: id },
    });
  }

  if (spec.type === "choice") {
    if (type !== "choice") throw new BrowserError("validation_failed", `TypeSafe answered "${id}" as ${redactText(String(type), 24)} instead of choice.`, { data: { question: id } });
    const allowed = Object.keys(spec.criteria ?? {});
    const choice = typeof answer.choice === "string" ? answer.choice : "";
    if (!allowed.includes(choice)) {
      throw new BrowserError("validation_failed", `TypeSafe selected an option this decision does not allow.`, {
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
        throw new BrowserError("validation_failed", `TypeSafe returned an invalid probability for option "${redactText(option, 40)}" of "${id}".`, { data: { question: id } });
      }
      probabilities[option] = value;
    }
    return { type: "choice", choice, probabilities, confidence };
  }

  if (type !== "score") throw new BrowserError("validation_failed", `TypeSafe answered "${id}" as ${redactText(String(type), 24)} instead of score.`, { data: { question: id } });
  const score = typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : null;
  if (score === null) throw new BrowserError("validation_failed", `TypeSafe returned a non-numeric score for "${id}".`, { data: { question: id } });
  const legendSource = (answer.legend ?? {}) as Record<string, unknown>;
  const legend: Record<string, string> = {};
  for (const [level, description] of Object.entries(legendSource)) {
    if (/^\d+$/.test(level) && typeof description === "string") legend[level] = redactText(description, JEV_LIMITS.maxCriterionChars);
  }
  const probabilities: Record<string, number> = {};
  for (const [level, value] of Object.entries((answer.probabilities ?? {}) as Record<string, unknown>)) {
    const probabilityValue = probability(value);
    if (probabilityValue !== null) probabilities[level] = probabilityValue;
  }
  return { type: "score", score, legend, probabilities, confidence };
}

function retryDelayMs(response: Response, attempt: number): number | null {
  if (response.status !== 429 && response.status !== 529 && response.status < 500) return null;
  const header = Number(response.headers.get("retry-after"));
  // One bounded backoff, per the documented guidance to retry 429/529 with a delay
  // rather than immediately. A caller-supplied delay is clamped so a decision can
  // never hold a tool request open for minutes.
  const wait = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, JEV_LIMITS.maxRetryDelayMs) : Math.min(200 * 2 ** attempt, JEV_LIMITS.maxRetryDelayMs);
  return Math.max(50, wait);
}

/**
 * Ask a set of typed questions in a single request.
 *
 * Failures are always a `BrowserError` with a stable code so the caller can fall back
 * without inspecting text: `capability_unavailable` (no key / rejected key),
 * `invalid_input` (our own validation), `validation_failed` (a malformed or
 * out-of-contract answer), `rate_limited` (429 after one retry), `timeout` and
 * `PROVIDER_UNAVAILABLE` (5xx/529/network). Nothing here ever throws a raw error.
 */
export async function askJev(input: JevAskInput): Promise<JevAskResult> {
  const { config } = input;
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey) {
    throw new BrowserError("capability_unavailable", "The TypeSafe API key is not configured on this Worker.", {
      hint: "Set it as a secret (`wrangler secret put TYPESAFE_API_KEY`) — never as a variable, and never in a URL.",
      capability: "jev_decisions",
      retryable: false,
    });
  }
  if (!config.enabled) {
    throw new BrowserError("capability_unavailable", "The Jev decision engine is disabled in this deployment.", {
      hint: config.disabledReason ?? "Remove TYPESAFE_ENABLED=false to enable it.",
      capability: "jev_decisions",
    });
  }

  const request = buildRequestBody(input);
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init as never));
  const timeoutMs = input.timeoutMs ?? config.timeoutMs;
  const attempts = JEV_LIMITS.maxRetryDelayMs > 0 ? 2 : 1;

  let lastError: BrowserError | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "FetchFailure";
      if (name === "TimeoutError") {
        throw new BrowserError("timeout", `TypeSafe did not answer within ${timeoutMs}ms.`, {
          retryable: true,
          hint: "A decision is optional in every DEMO workflow: the deterministic result stands. Raise TYPESAFE_DECISION_TIMEOUT_MS if your traffic needs it.",
          data: { timeoutMs },
        });
      }
      throw new BrowserError("PROVIDER_UNAVAILABLE", `Could not reach ${new URL(config.endpoint).host}.`, {
        retryable: true,
        hint: "TypeSafe may be unavailable. DEMO continues with its own deterministic logic.",
        data: { cause: name },
      });
    }

    if (response.ok) {
      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new BrowserError("validation_failed", "TypeSafe returned a non-JSON response.", { retryable: true, data: { status: response.status } });
      }
      const answers = (payload?.answers ?? {}) as Record<string, unknown>;
      const validated: Record<string, JevAnswer> = {};
      for (const [id, spec] of Object.entries(input.questions)) {
        validated[id] = validateAnswer(id, spec, answers[id]);
      }
      const usage = (payload?.usage ?? {}) as Record<string, unknown>;
      const token = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
      return {
        // The response reports the versioned id behind an alias, which is what makes a
        // tuned threshold reproducible: log it, and pin TYPESAFE_MODEL if you depend on it.
        model: typeof payload?.model === "string" ? payload.model.slice(0, 80) : null,
        answers: validated,
        usage: { inputTokens: token(usage.input_tokens), outputTokens: token(usage.output_tokens) },
        attempts: attempt + 1,
        stateChars: request.chars,
        stateTruncated: request.truncated,
      };
    }

    const body = await response.text().catch(() => "");
    const waitMs = retryDelayMs(response, attempt);
    const error = classifyFailure(response.status, body, waitMs !== null && attempt + 1 < attempts);
    if (waitMs === null || attempt + 1 >= attempts) throw error;
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw lastError ?? new BrowserError("PROVIDER_UNAVAILABLE", "TypeSafe did not return a decision.", { retryable: true });
}

function classifyFailure(status: number, body: string, willRetry: boolean): BrowserError {
  let providerDetail = "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const raw = parsed?.detail ?? parsed?.error ?? parsed?.message ?? parsed;
    providerDetail = detail(raw, "");
  } catch {
    providerDetail = "";
  }

  if (status === 401 || status === 403) {
    return new BrowserError("capability_unavailable", "TypeSafe rejected this Worker's API key.", {
      hint: `Check the TYPESAFE_API_KEY secret against the key at console.typesafe.ai/keys.${providerDetail ? ` TypeSafe said: ${providerDetail}` : ""} The key is only ever sent as an Authorization header.`,
      capability: "jev_decisions",
      data: { httpStatus: status },
    });
  }
  if (status === 422) {
    return new BrowserError("validation_failed", "TypeSafe rejected the question set.", {
      hint: `This is a bug in the question definition, not in your input.${providerDetail ? ` TypeSafe said: ${providerDetail}` : ""}`,
      data: { httpStatus: status, detail: providerDetail || undefined },
    });
  }
  if (status === 429) {
    return new BrowserError("rate_limited", "TypeSafe rate limited this decision.", {
      retryable: true,
      hint: willRetry ? "Retrying once after a short backoff." : "DEMO self-limits decisions; the workflow continued on its deterministic path.",
      data: { httpStatus: status, detail: providerDetail || undefined },
    });
  }
  if (status === 529 || status >= 500) {
    return new BrowserError("PROVIDER_UNAVAILABLE", `TypeSafe returned HTTP ${status}.`, {
      retryable: true,
      hint: willRetry ? "Retrying once after a short backoff." : "TypeSafe reports overload; DEMO keeps its deterministic result rather than blocking the request.",
      data: { httpStatus: status, detail: providerDetail || undefined },
    });
  }
  return new BrowserError("internal", `TypeSafe returned HTTP ${status}.`, {
    data: { httpStatus: status, detail: providerDetail || undefined },
    hint: "Unexpected status for the documented contract (200, 401, 422, 429, 529).",
  });
}

/** `GET /v1/models` — used only by the capability report, never for a decision. */
export async function listJevModels(config: JevConfig, apiKey: string, fetchImpl?: FetchLike): Promise<Array<{ name: string; description: string; releaseDate: string }> | null> {
  if (!apiKey) return null;
  const run: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init as never));
  try {
    const response = await run(config.modelsEndpoint, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { models?: unknown };
    const list = Array.isArray(payload?.models) ? payload.models : [];
    return list
      .map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        return {
          name: typeof item.name === "string" ? item.name.slice(0, 80) : "",
          description: typeof item.description === "string" ? redactText(item.description, 240) : "",
          releaseDate: typeof item.release_date === "string" ? item.release_date.slice(0, 40) : "",
        };
      })
      .filter((entry) => entry.name);
  } catch {
    // Model listing is diagnostic only: an unreachable list must never fail a report.
    return null;
  }
}
