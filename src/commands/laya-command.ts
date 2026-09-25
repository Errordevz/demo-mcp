/**
 * /laya command — status and diagnostics for the Laya decision provider.
 *
 * Safe information only, ever:
 *   enabled · configured · reachable (only when asked) · routing mode ·
 *   endpoint hostname · timeout · model · credential presence (boolean)
 *
 * Never shown: the Laya credential value or its variable name, Authorization
 * headers, or the full configured URL (operator-controlled infrastructure detail;
 * the hostname is enough to confirm which server answers).
 *
 * Subcommands:
 *   /laya          — status snapshot (no network traffic)
 *   /laya check    — one minimal live round-trip to the Laya server (no user data)
 *   /laya mode     — explain the routing modes and the AUTO fallback chain
 */

import { textResult, type ToolResult } from "../mcp/results.js";
import { redactValue } from "../core/redact.js";
import { resolveLayaConfig, type LayaConfig } from "../laya/config.js";
import { probeLaya } from "../laya/client.js";
import { jevProvider, layaProvider, resolveDecisionRoutingMode, describeRoutingMode } from "../decisions/provider.js";
import type { CommandHandler } from "./router.js";

/** The status snapshot every /laya variant shares. Presence-only by construction. */
function statusPayload(config: LayaConfig, env: Record<string, unknown>) {
  const mode = resolveDecisionRoutingMode(env);
  return {
    enabled: config.enabled,
    configured: config.configured,
    available: config.available,
    credential_configured: config.credentialConfigured,
    reachable: "not probed (run /laya check for a live test)",
    routing_mode: mode,
    routing_chain: "auto: Laya → Jev → DEMO deterministic rules",
    endpoint_hostname: config.endpointHost,
    https_only: true,
    timeout_ms: config.timeoutMs,
    model: config.model,
    disabled_reason: config.disabledReason,
    jev_also_configured: jevProvider.status(env).available,
  };
}

const SAFETY_NOTE =
  "Laya is an advisory typed-decision provider, not a chat model and not an agent. Its answers can only select among options DEMO enumerated in code. It cannot authorize tools, bypass permissions or confirmations, read secrets, or override DEMO's security policy — those layers stay authoritative.";

export function createLayaCommand(): CommandHandler {
  return {
    name: "laya",
    description: "Show Laya decision-provider status (safe fields only), or run a minimal connectivity check.",
    execute: async (args, env) => {
      const config = resolveLayaConfig(env);
      const subcommand = args.trim().toLowerCase().split(/\s+/)[0] ?? "";

      if (subcommand === "mode") {
        const mode = resolveDecisionRoutingMode(env);
        return textResult({
          command: "/laya mode",
          routing_mode: mode,
          meaning: describeRoutingMode(mode),
          modes: {
            auto: describeRoutingMode("auto"),
            laya: describeRoutingMode("laya"),
            jev: describeRoutingMode("jev"),
          },
          configured_by: "DECISION_PROVIDER_MODE (deployment variable), or the per-call provider argument on jev_decide.",
          providers: {
            laya: presence(layaProvider.status(env)),
            jev: presence(jevProvider.status(env)),
          },
          safety: SAFETY_NOTE,
        });
      }

      if (subcommand === "check") {
        if (!config.available) {
          return textResult({
            command: "/laya check",
            reachable: false,
            probed: false,
            reason: config.disabledReason ?? "Laya is not available on this deployment.",
            hint: "Configure LAYA_BASE_URL (and the Laya credential secret when the server requires one), then re-run the check.",
            laya: statusPayload(config, env),
          });
        }
        // One minimal question, no user data, bounded by the configured timeout.
        const probe = await probeLaya({ config, apiKey: typeof env.LAYA_API_KEY === "string" ? env.LAYA_API_KEY : "", env });
        return textResult(
          redactValue({
            command: "/laya check",
            probed: true,
            reachable: probe.reachable,
            model_answered: probe.model,
            attempts: probe.attempts,
            usage: probe.usage,
            error: probe.error,
            note: probe.reachable
              ? "The Laya server answered a minimal typed question. No user data was sent."
              : "The probe failed; routing falls back through the normal chain (Jev, then DEMO's deterministic rules). The Laya credential was only ever sent as an Authorization header and is not shown here.",
            laya: statusPayload(config, env),
          }),
        );
      }

      if (subcommand && subcommand !== "status") {
        return textResult({
          command: "/laya",
          unknown_argument: redactValue(args.trim().slice(0, 80)),
          usage: ["/laya", "/laya check", "/laya mode"],
        });
      }

      return textResult({
        command: "/laya",
        laya: statusPayload(config, env),
        usage: ["/laya — this status", "/laya check — one live round-trip", "/laya mode — routing modes explained"],
        setup_hint: config.available
          ? null
          : "To enable: LAYA_ENABLED=true, LAYA_BASE_URL=https://your-laya-server.example, plus the Laya credential as a Worker secret when the server requires one. See docs/LAYA.md.",
        demo_note: "DEMO does not host or bundle the Laya model; it talks to an external Laya-compatible server over POST /v1/systemone.",
        safety: SAFETY_NOTE,
      });
    },
  };
}

function presence(status: { available: boolean; enabled: boolean; configured: boolean; credentialConfigured: boolean; model: string; endpointHost: string | null; timeoutMs: number }) {
  return {
    available: status.available,
    enabled: status.enabled,
    configured: status.configured,
    credential_configured: status.credentialConfigured,
    model: status.model,
    endpoint_hostname: status.endpointHost,
    timeout_ms: status.timeoutMs,
  };
}
