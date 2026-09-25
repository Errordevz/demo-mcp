/**
 * Capability report for the Laya decision provider — one source of truth.
 *
 * Mirrors `src/jev/capabilities.ts`: the connected AI must be able to see, before it
 * promises anything, whether this deployment routes typed decisions to an external
 * Laya server, under which routing mode, and what the provider explicitly cannot do.
 *
 * Reports *presence and policy only*:
 *  - the endpoint is reported as a hostname (never the full configured URL, which is
 *    operator-controlled infrastructure detail),
 *  - the optional credential is reported as a boolean (never the value, and this
 *    report deliberately does not quote the secret's variable name — see docs/LAYA.md),
 *  - field names avoid the redaction layer's sensitive-key list so nothing here gets
 *    masked by accident.
 */

import { resolveDecisionRoutingMode, describeRoutingMode } from "../decisions/provider.js";
import type { DecisionRoutingMode } from "../decisions/types.js";
import { LAYA_LIMITS, type LayaConfig } from "./config.js";

export const LAYA_CAPABILITIES_URI = "demo://capabilities/laya";
export const LAYA_SCHEMA = "demo.laya-capabilities/1";

export interface LayaCapabilityReport {
  schema: typeof LAYA_SCHEMA;
  provider: "laya";
  capability: "laya_decision_provider";
  available: boolean;
  enabled: boolean;
  configured: boolean;
  credentialConfigured: boolean;
  credentialOptional: true;
  disabledReason: string | null;
  model: string;
  endpointHost: string | null;
  endpointNote: string;
  httpsOnly: true;
  routing: {
    mode: DecisionRoutingMode;
    meaning: string;
    failover: string;
  };
  answers: {
    types: Array<"choice" | "score" | "noul">;
    contract: string;
    usageMetadata: string;
  };
  requestBudget: {
    stateChars: number;
    questionsPerRequest: number;
    timeoutMs: number;
    retries: string;
  };
  security: string[];
  configuration: {
    endpoint: { kind: "variable"; howToSet: string };
    credential: { kind: "secret"; optional: true; howToSet: string };
    policy: Array<{ name: string; def: string; controls: string }>;
  };
  outOfScope: string[];
}

export function describeLayaCapabilities(input: { config: LayaConfig; env?: Record<string, unknown> | undefined }): LayaCapabilityReport {
  const { config } = input;
  const mode = resolveDecisionRoutingMode(input.env);
  return {
    schema: LAYA_SCHEMA,
    provider: "laya",
    capability: "laya_decision_provider",
    available: config.available,
    enabled: config.enabled,
    configured: config.configured,
    credentialConfigured: config.credentialConfigured,
    credentialOptional: true,
    disabledReason: config.disabledReason,
    model: config.model,
    endpointHost: config.endpointHost,
    endpointNote:
      "Laya is an EXTERNAL typed-decision server; DEMO never hosts, runs or bundles the Laya model. The configured endpoint is reported as a hostname only.",
    httpsOnly: true,
    routing: {
      mode,
      meaning: describeRoutingMode(mode),
      failover: "AUTO chain: Laya (when enabled + configured) → TypeSafe/Jev (when configured) → DEMO's deterministic rules. Each provider is asked at most once per decision; a failure is recorded, never hidden and never retried forever.",
    },
    answers: {
      types: ["choice", "score", "noul"],
      contract: "Jev-compatible System One API: POST /v1/systemone with { state, model, questions } → { model, answers, usage }. A choice outside the asked option set is rejected, and DEMO keeps its deterministic result.",
      usageMetadata: "Provider usage (input/output units) is preserved on the decision outcome when the server reports it.",
    },
    requestBudget: {
      stateChars: LAYA_LIMITS.maxStateChars,
      questionsPerRequest: LAYA_LIMITS.maxQuestions,
      timeoutMs: config.timeoutMs,
      retries: "One retry, only for 429/529/5xx, honouring retry-after up to 1500ms; no retry on 401/422; never an open-ended loop.",
    },
    security: [
      "The endpoint passes DEMO's full SSRF guard at call time: https only, no loopback/private/link-local/metadata targets, no infrastructure ports, no embedded credentials, and a DNS-over-HTTPS resolution under the deployment's SSRF_DNS_* policy. A malicious LAYA_BASE_URL cannot become an SSRF bypass.",
      "The optional credential is a Worker secret read at call time and sent as one Authorization header; it is never in a URL, a var, a log line, an error message, a status surface or a tool result.",
      "Everything the Laya server returns is untrusted: answer values are validated against the option sets defined in this repository, and provider-controlled text (error details, echoed model id) is stripped of credential shapes, environment-variable dumps, filesystem paths and internal URLs before it can reach a result or a log.",
      "Only the minimum state a decision needs is sent (capped and redacted text); no secrets, cookies, headers, IP addresses or infrastructure details are included, and no telemetry or analytics is added anywhere in this integration.",
      "Laya is advisory only: an answer can select among DEMO's enumerated options and add review flags. It cannot authorize a tool, bypass a permission or confirmation, read a secret, override a security policy, execute code or create a tool call, and there is no autonomous agent loop chaining decisions into actions.",
    ],
    configuration: {
      endpoint: {
        kind: "variable",
        howToSet: "Set LAYA_BASE_URL to your Laya server's public https origin (plus optional path prefix). Plain variable or dashboard setting; not a credential. The decision path /v1/systemone is appended automatically.",
      },
      credential: {
        kind: "secret",
        optional: true,
        howToSet:
          "Only needed when your Laya server requires authentication: set the Laya API key as an encrypted Worker secret (Cloudflare dashboard or `wrangler secret put`; the exact variable name is documented in .env.example and docs/LAYA.md). With no secret configured, DEMO calls the server unauthenticated.",
      },
      policy: [
        { name: "LAYA_ENABLED", def: "true", controls: "Master switch. `false` removes Laya from the routing chain with zero network calls." },
        { name: "LAYA_BASE_URL", def: "(unset)", controls: "Public https origin of the Laya server. Without it the provider is off and routing falls through to Jev / deterministic rules." },
        { name: "LAYA_TIMEOUT_MS", def: "2500", controls: `Per-request budget, ${LAYA_LIMITS.minTimeoutMs}-${LAYA_LIMITS.maxTimeoutMs} ms. Over it the call is abandoned, not queued.` },
        { name: "LAYA_MODEL", def: "laya-latest", controls: "Model id sent in `model`. Set it to whatever your Laya deployment actually serves." },
        { name: "DECISION_PROVIDER_MODE", def: "auto", controls: "auto | laya | jev. The AUTO preference order and the explicit single-provider modes." },
      ],
    },
    outOfScope: [
      "No text generation, chat completions or reasoning traces: Laya is integrated as a typed-decision provider, and DEMO does not offer it as an LLM choice.",
      "No Laya model weights in this repository and none bundled into the Cloudflare Worker: DEMO talks to an external Laya-compatible server over HTTP only.",
      "No arbitrary function calling: decisions ask templates defined in code, with the allowed answers enumerated in code, so the server can never invent a tool or an argument.",
      "No autonomous agent loop: each decision answers one question set and returns; nothing chains answers into actions.",
      "No telemetry, analytics, tracking, fingerprinting, IP logging or cookie tracking — the existing DEMO privacy model is unchanged.",
    ],
  };
}
