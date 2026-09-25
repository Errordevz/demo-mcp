/**
 * The typed-decision provider abstraction.
 *
 *   DecisionProvider
 *   ├── LayaProvider   — external Laya server, configured via LAYA_BASE_URL
 *   └── JevProvider    — TypeSafe/Jev at the pinned api.typesafe.ai endpoint
 *
 * Both providers answer the same normalized contract (`src/decisions/systemone.ts`)
 * and both are *advisory*: they can only select among options DEMO enumerated in
 * code. Neither can authorize an MCP tool, bypass a permission or confirmation,
 * read a secret, override a security policy, or create a tool call.
 *
 * The router (`src/decisions/router.ts`) consumes this interface; the decision
 * engine in `src/jev/decisions.ts` consumes the router. Nothing else needs to know
 * which provider answered.
 */

import { resolveJevConfig } from "../jev/config.js";
import { askJev } from "../jev/client.js";
import { resolveLayaConfig } from "../laya/config.js";
import { askLaya } from "../laya/client.js";
import type { FetchLike, SystemOneAskResult } from "./systemone.js";
import type { DecisionProviderName, DecisionQuestionSpec, DecisionRoutingMode } from "./types.js";

export interface ProviderAskInput {
  state: unknown;
  questions: Record<string, DecisionQuestionSpec>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Presence-and-policy snapshot of one provider. Never contains a credential value. */
export interface DecisionProviderStatus {
  name: DecisionProviderName;
  label: string;
  /** Ready to be asked right now (enabled + fully configured). */
  available: boolean;
  /** The operator's switch (LAYA_ENABLED / TYPESAFE_ENABLED). */
  enabled: boolean;
  /** The deployment-specific part is set (LAYA_BASE_URL / TYPESAFE_API_KEY). */
  configured: boolean;
  /** A credential is present (presence only, never the value). Laya's is optional. */
  credentialConfigured: boolean;
  /** Why the provider cannot be used, or null. Never credential-bearing. */
  reason: string | null;
  model: string;
  /** Hostname only; safe to display. Null for providers with a pinned or absent endpoint. */
  endpointHost: string | null;
  timeoutMs: number;
}

export interface DecisionProvider {
  name: DecisionProviderName;
  label: string;
  /** Synchronous presence/policy snapshot — safe on hot paths like `/health`. */
  status(env: Record<string, unknown> | undefined): DecisionProviderStatus;
  /** Ask one question set. Throws a BrowserError with a stable code on failure. */
  ask(env: Record<string, unknown> | undefined, input: ProviderAskInput): Promise<SystemOneAskResult>;
}

export const jevProvider: DecisionProvider = {
  name: "jev",
  label: "TypeSafe/Jev",
  status(env) {
    const config = resolveJevConfig(env);
    return {
      name: "jev",
      label: "TypeSafe/Jev",
      available: config.available,
      enabled: config.enabled,
      configured: config.apiKeyPresent,
      credentialConfigured: config.apiKeyPresent,
      reason: config.disabledReason,
      model: config.model,
      endpointHost: null, // pinned in code; see docs/JEV.md
      timeoutMs: config.timeoutMs,
    };
  },
  ask(env, input) {
    const config = resolveJevConfig(env);
    return askJev({
      config,
      apiKey: typeof env?.TYPESAFE_API_KEY === "string" ? env.TYPESAFE_API_KEY : "",
      state: input.state,
      questions: input.questions,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  },
};

export const layaProvider: DecisionProvider = {
  name: "laya",
  label: "Laya",
  status(env) {
    const config = resolveLayaConfig(env);
    return {
      name: "laya",
      label: "Laya",
      available: config.available,
      enabled: config.enabled,
      configured: config.configured,
      credentialConfigured: config.credentialConfigured,
      reason: config.disabledReason,
      model: config.model,
      endpointHost: config.endpointHost,
      timeoutMs: config.timeoutMs,
    };
  },
  ask(env, input) {
    const config = resolveLayaConfig(env);
    return askLaya({
      config,
      apiKey: typeof env?.LAYA_API_KEY === "string" ? env.LAYA_API_KEY : "",
      env,
      state: input.state,
      questions: input.questions,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  },
};

/** Both registered providers, in AUTO preference order. */
export const DECISION_PROVIDERS: readonly DecisionProvider[] = [layaProvider, jevProvider];

export const DECISION_ROUTING_MODES = ["auto", "laya", "jev"] as const satisfies readonly DecisionRoutingMode[];

/**
 * Resolve the effective routing mode: the per-call override when granted, else the
 * deployment's `DECISION_PROVIDER_MODE`, else `auto`. An unrecognised value falls
 * back to `auto` rather than failing — a mistyped var must not break decisions.
 */
export function resolveDecisionRoutingMode(env: Record<string, unknown> | undefined, override?: DecisionRoutingMode | null): DecisionRoutingMode {
  if (override && DECISION_ROUTING_MODES.includes(override)) return override;
  const raw = typeof env?.DECISION_PROVIDER_MODE === "string" ? env.DECISION_PROVIDER_MODE.trim().toLowerCase() : "";
  return (DECISION_ROUTING_MODES as readonly string[]).includes(raw) ? (raw as DecisionRoutingMode) : "auto";
}

/** Human-readable description of what a mode does, for status surfaces. */
export function describeRoutingMode(mode: DecisionRoutingMode): string {
  switch (mode) {
    case "laya":
      return "Only the external Laya server is asked. If it is unavailable or fails, DEMO reports that honestly and keeps its deterministic fallback; Jev is not consulted.";
    case "jev":
      return "Only the existing TypeSafe/Jev integration is asked (unchanged DEMO behaviour).";
    default:
      return "Laya is asked first when it is enabled, configured and reachable; on failure DEMO fails over to TypeSafe/Jev; if that also fails (or is not configured) DEMO's deterministic rules decide. No retry loops: each provider is asked at most once per decision, plus its own single bounded retry.";
  }
}
