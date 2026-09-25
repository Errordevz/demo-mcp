/**
 * The DEMO MCP decision router.
 *
 * ChatGPT
 *    ↓
 * DEMO MCP decision router          (this module)
 *    ├── Laya        →  POST <LAYA_BASE_URL>/v1/systemone
 *    └── Jev / TypeSafe  →  POST https://api.typesafe.ai/v1/systemone  (existing)
 *    ↓ (every provider unavailable or failed)
 * DEMO's existing deterministic fallback rules   (unchanged)
 *
 * Modes (`DECISION_PROVIDER_MODE`, or a per-call override):
 *
 *  - `auto` — Laya first when enabled + configured (suitable: every DEMO decision
 *    template is a noul/choice/score set, which both providers answer), then Jev,
 *    then the deterministic fallback. With no Laya configured this is byte-for-byte
 *    the previous DEMO behaviour.
 *  - `laya` — Laya only. An unavailable Laya yields an honest report, never a
 *    fabricated decision and never a silent detour through Jev.
 *  - `jev`  — the existing Jev path, untouched.
 *
 * Hard bounds: each provider is asked at most once per decision (plus the single
 * retry the shared contract allows for 429/5xx), and a provider failure is recorded
 * and reported — never hidden, never retried forever, and never allowed to break
 * an unrelated DEMO tool.
 */

import { BrowserError } from "../core/errors.js";
import { redactText } from "../core/redact.js";
import { DECISION_PROVIDERS, type DecisionProvider, type ProviderAskInput } from "./provider.js";
import type { DecisionProviderName, DecisionRoutingMode } from "./types.js";

/** One provider's failure (or skip reason), sanitized and safe to report. */
export interface ProviderMiss {
  provider: DecisionProviderName;
  label: string;
  /** BrowserError code of the failure, or "not_configured" when skipped. */
  code: string;
  message: string;
}

export type RoutedAsk =
  | { kind: "answered"; provider: DecisionProviderName; label: string; result: import("./systemone.js").SystemOneAskResult; failovers: ProviderMiss[]; skipped: ProviderMiss[] }
  | { kind: "exhausted"; mode: DecisionRoutingMode; failures: ProviderMiss[]; skipped: ProviderMiss[] }
  | { kind: "unavailable"; mode: DecisionRoutingMode; skipped: ProviderMiss[] };

/** The providers a mode will consult, in order. Unavailable ones are skipped with a reason. */
export function providerChainFor(mode: DecisionRoutingMode): DecisionProvider[] {
  switch (mode) {
    case "laya":
      return DECISION_PROVIDERS.filter((provider) => provider.name === "laya");
    case "jev":
      return DECISION_PROVIDERS.filter((provider) => provider.name === "jev");
    default:
      return [...DECISION_PROVIDERS];
  }
}

/** Whether at least one provider in the mode's chain is usable right now. */
export function anyProviderAvailable(env: Record<string, unknown> | undefined, mode: DecisionRoutingMode): boolean {
  return providerChainFor(mode).some((provider) => provider.status(env).available);
}

function missFor(provider: DecisionProvider, reason: string | null, code = "not_configured"): ProviderMiss {
  return {
    provider: provider.name,
    label: provider.label,
    code,
    message: redactText(reason ?? "Provider is not available on this deployment.", 240),
  };
}

/**
 * Ask one question set through the routing chain. Never throws for provider
 * problems: everything is reported in the returned union, so the engine can turn
 * it into a fallback decision with an honest note. Only our own input-validation
 * errors (invalid_input) propagate, exactly as before.
 */
export async function askRoutedDecision(
  env: Record<string, unknown> | undefined,
  mode: DecisionRoutingMode,
  input: ProviderAskInput,
): Promise<RoutedAsk> {
  const chain = providerChainFor(mode);
  const failures: ProviderMiss[] = [];
  const skipped: ProviderMiss[] = [];

  for (const provider of chain) {
    const status = provider.status(env);
    if (!status.available) {
      skipped.push(missFor(provider, status.reason));
      continue;
    }
    try {
      const result = await provider.ask(env, input);
      return { kind: "answered", provider: provider.name, label: provider.label, result, failovers: [...failures], skipped: [...skipped] };
    } catch (error) {
      if (error instanceof BrowserError && error.code === "invalid_input") {
        // Our own request shape is wrong: retrying it against another provider (or
        // on a fallback) changes nothing. Surface it exactly like before.
        throw error;
      }
      failures.push(
        error instanceof BrowserError
          ? missFor(provider, `${error.code}: ${error.message}`, error.code)
          : missFor(provider, String(error), "internal"),
      );
    }
  }

  if (failures.length === 0) {
    return { kind: "unavailable", mode, skipped };
  }
  return { kind: "exhausted", mode, failures, skipped };
}

/**
 * Compose the human-readable note a fallback decision carries when no provider
 * answered. Mentions every provider that was consulted or skipped, so a reviewer
 * can always tell what happened. Already-redacted components, one final cap.
 */
export function describeRoutedMiss(routed: Exclude<RoutedAsk, { kind: "answered" }>): string {
  const parts: string[] = [];
  if (routed.kind === "unavailable") {
    parts.push(
      routed.mode === "laya"
        ? "Laya was explicitly selected, but it is not available on this deployment."
        : routed.mode === "jev"
          ? "TypeSafe/Jev was explicitly selected, but it is not available on this deployment."
          : "No typed-decision provider is available on this deployment.",
    );
  } else {
    parts.push(
      routed.mode === "laya"
        ? "Laya was explicitly selected and failed."
        : routed.mode === "jev"
          ? "TypeSafe/Jev was explicitly selected and failed."
          : "Every available typed-decision provider failed.",
    );
    const failures = routed.kind === "exhausted" ? routed.failures : [];
    for (const failure of failures) parts.push(`${failure.label}: ${failure.message}`);
  }
  for (const skipped of routed.skipped) parts.push(`${skipped.label} not configured: ${skipped.message}`);
  parts.push("DEMO kept its deterministic result.");
  return redactText(parts.join(" "), 480);
}

/** A one-line note for a decision that *did* run, after a failover happened. */
export function describeFailover(routed: Extract<RoutedAsk, { kind: "answered" }>): string | null {
  if (routed.failovers.length === 0) return null;
  const failed = routed.failovers.map((failure) => `${failure.label} failed (${failure.message})`).join("; ");
  return redactText(`${failed}; ${routed.label} answered instead.`, 480);
}
