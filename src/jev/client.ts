/**
 * TypeSafe HTTP client for Jev (System One decisions).
 *
 * This is the only place in the repository that holds a TypeSafe API key: it is read
 * from the Worker secret at call time, placed in exactly one `Authorization` header,
 * and never written into a URL, a log line, an error message or a tool result. The
 * key is deliberately *not* stored on the config object.
 *
 * The wire contract itself — request building, answer validation, the bounded retry
 * and failure classification — lives in `src/decisions/systemone.ts` and is shared
 * verbatim with the Laya provider, so the two can never drift apart. This file is
 * the TypeSafe adapter: the pinned endpoint, the required credential, and the
 * TypeSafe-specific operator guidance.
 *
 * Deliberately raw `fetch` rather than `@typesafe-ai/sdk`: this bundle must run on
 * the Workers runtime (the build gate asserts no Node-only code is pulled in), and the
 * documented contract is a single JSON POST. The SDK's conveniences — retry policy and
 * env-var key discovery — are reproduced in the shared contract explicitly, because a
 * tool call inside an MCP request needs a bounded retry, not an open-ended one.
 */

import { BrowserError } from "../core/errors.js";
import { redactText } from "../core/redact.js";
import { askSystemOne, type FetchLike, type SystemOneAskInput, type SystemOneAskResult, type SystemOneProviderDescriptor } from "../decisions/systemone.js";
import type { DecisionAnswer, DecisionQuestionSpec } from "../decisions/types.js";
import { JEV_LIMITS, type JevConfig } from "./config.js";

export type { FetchLike };

/** The request shape we accept, mirrored on the documented `Question` union. */
export type JevQuestionSpec = DecisionQuestionSpec;
export type JevAnswer = DecisionAnswer;

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

export type JevAskResult = SystemOneAskResult;

/** TypeSafe-specific wording for the shared contract. */
function typesafeDescriptor(config: JevConfig, apiKey: string): SystemOneProviderDescriptor {
  return {
    provider: "jev",
    label: "TypeSafe",
    capability: "jev_decisions",
    endpoint: config.endpoint,
    authorization: `Bearer ${apiKey}`,
    model: config.model,
    timeoutMs: config.timeoutMs,
    limits: JEV_LIMITS,
    sanitize: redactText,
    messages: {
      timeout: () =>
        "A decision is optional in every DEMO workflow: the deterministic result stands. Raise TYPESAFE_DECISION_TIMEOUT_MS if your traffic needs it.",
      unreachable: "TypeSafe may be unavailable. DEMO continues with its own deterministic logic.",
      rejection: {
        message: "TypeSafe rejected this Worker's API key.",
        hint: (providerDetail) =>
          `Check the TYPESAFE_API_KEY secret against the key at console.typesafe.ai/keys.${providerDetail ? ` TypeSafe said: ${providerDetail}` : ""} The key is only ever sent as an Authorization header.`,
      },
      overloadedNoRetry: "TypeSafe reports overload; DEMO keeps its deterministic result rather than blocking the request.",
    },
  };
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

  const ask: SystemOneAskInput = {
    state: input.state,
    questions: input.questions,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  return askSystemOne(typesafeDescriptor(config, apiKey), ask);
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
