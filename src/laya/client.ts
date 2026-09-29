/**
 * HTTP client for a Laya decision server (Jev-compatible System One API).
 *
 * Laya is externally hosted — `LAYA_BASE_URL` may point anywhere — so this adapter
 * adds two things the pinned TypeSafe client does not need:
 *
 *  1. **The full DEMO URL guard on the configured endpoint, at call time.**
 *     `LAYA_BASE_URL` is operator-controlled configuration; a malicious or mistaken
 *     value must never turn the integration into an SSRF bypass. Every decision call
 *     first passes the endpoint through `assertNavigableUrl`: https only, no
 *     loopback/private/link-local/metadata targets, no infrastructure ports, no
 *     embedded credentials, and a DNS-over-HTTPS resolution under the deployment's
 *     `SSRF_DNS_*` policy. A blocked endpoint is a provider failure, so the router
 *     falls through the normal chain.
 *
 *  2. **A stricter sanitizer for provider-controlled text.**
 *     An external server can return arbitrary strings (error details, the echoed
 *     model id). Before any of it can land in a DEMO result or log line it goes
 *     through {@link sanitizeUntrustedProviderText}, which strips credential shapes,
 *     environment-variable dumps, filesystem paths and internal/private URLs on top
 *     of the standard redactor. Answer *values* are validated structurally by the
 *     shared contract: a choice outside the asked option set is a hard failure.
 *
 * Nothing here is authoritative for permissions or security: the client only ever
 * fetches typed answers for questions whose options DEMO enumerated in code.
 */

import { BrowserError } from "../core/errors.js";
import { redactText } from "../core/redact.js";
import { assertNavigableUrl, createDohResolver, isPrivateIp, type DnsResolver } from "../core/url-guard.js";
import { askSystemOne, type FetchLike, type SystemOneAskInput, type SystemOneAskResult, type SystemOneProviderDescriptor } from "../decisions/systemone.js";
import type { DecisionQuestionSpec } from "../decisions/types.js";
import { LAYA_LIMITS, type LayaConfig } from "./config.js";

export type { FetchLike };
export type LayaAskResult = SystemOneAskResult;

const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".cluster.local", ".svc"];

/**
 * Sanitize text controlled by an arbitrary external Laya server before it can reach
 * a DEMO result, log line or error. Builds on the standard redactor (credentials,
 * JWTs, bearer values, e-mails, signed URLs, opaque blobs) and additionally removes:
 *
 *  - URLs pointing at private/internal infrastructure (SSRF bounce material),
 *  - environment-variable dumps (`NAME=value`),
 *  - absolute filesystem paths (Unix and Windows).
 */
export function sanitizeUntrustedProviderText(text: string, maxLength = 2000): string {
  if (typeof text !== "string") return "";
  let out = redactText(text, Math.max(maxLength * 2, 1_000));

  out = out.replace(/https?:\/\/[^\s"'<>)\]},]+/gi, (match) => {
    try {
      const url = new URL(match);
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (isPrivateIp(host) || host === "localhost" || INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return "[internal-url-redacted]";
      }
      return url.username || url.password ? "[credential-url-redacted]" : match;
    } catch {
      return "[url-redacted]";
    }
  });

  // Environment-variable dumps: never forward `SOME_NAME=value` pairs.
  out = out.replace(/\b([A-Z][A-Z0-9_]{2,})=([^\s"',;}]{1,200})/g, "$1=[redacted]");

  // Absolute filesystem paths (server internals the caller should never see).
  out = out.replace(/(?:~|\/(?:home|Users|root|var|etc|opt|srv|tmp|private|usr))(?:\/[A-Za-z0-9._~+-]+)+\/?/g, "[path-redacted]");
  out = out.replace(/\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+/g, "[path-redacted]");

  return out.length > maxLength ? `${out.slice(0, maxLength)}…[truncated]` : out;
}

export interface LayaAskInput {
  config: LayaConfig;
  /** Passed in from `env` by the caller; empty when the server is unauthenticated. */
  apiKey: string;
  /** Source of the deployment's SSRF_DNS_* policy for the endpoint's DNS check. */
  env?: Record<string, unknown> | undefined;
  state: unknown;
  questions: Record<string, DecisionQuestionSpec>;
  fetchImpl?: FetchLike;
  /** Overrides the config timeout for one call. */
  timeoutMs?: number;
  /** DNS resolver for the endpoint's private-IP check: a resolver, or null to skip
   *  the DNS step. Default: built from `env` exactly like the other outbound tools. */
  dns?: DnsResolver | null;
}

/** Laya-specific wording for the shared contract, including the optional-credential story. */
function layaDescriptor(config: LayaConfig, apiKey: string): SystemOneProviderDescriptor {
  /**
   * Defense in depth beyond the generic sanitizer: if the Laya server echoes our
   * own credential back (a hostile or misconfigured endpoint), the exact secret
   * string is scrubbed before any provider-controlled text can reach DEMO errors,
   * logs or results. The key is the one value we can always recognize exactly.
   */
  const scrubEchoedCredential = (text: string): string => (apiKey ? text.split(apiKey).join("[credential-redacted]") : text);
  return {
    provider: "laya",
    label: "Laya",
    capability: "laya_decisions",
    endpoint: config.endpoint as string, // askLaya guarantees availability before building this
    authorization: apiKey ? `Bearer ${apiKey}` : null,
    model: config.model,
    timeoutMs: config.timeoutMs,
    limits: LAYA_LIMITS,
    sanitize: (text, max) => sanitizeUntrustedProviderText(scrubEchoedCredential(text), max),
    messages: {
      timeout: () =>
        "A decision is optional in every DEMO workflow: the deterministic result or another provider stands. Raise LAYA_TIMEOUT_MS if your Laya server needs it.",
      unreachable: "The Laya server may be unavailable. DEMO continues with its remaining decision providers and its own deterministic logic.",
      rejection: apiKey
        ? {
            message: "Laya rejected this Worker's API key.",
            hint: (providerDetail) =>
              `Check the Laya credential configured on this Worker against your Laya deployment.${providerDetail ? ` Laya said: ${providerDetail}` : ""} A key is only ever sent as an Authorization header; it never appears in a URL.`,
          }
        : {
            message: "This Laya server requires an API key, but none is configured on this Worker.",
            hint: (providerDetail) =>
              `Configure the Laya credential as a Worker secret, per docs/LAYA.md.${providerDetail ? ` Laya said: ${providerDetail}` : ""} It is only ever sent as an Authorization header.`,
          },
      overloadedNoRetry: "The Laya server reports an error; DEMO keeps its own deterministic result rather than blocking the request.",
    },
  };
}

/**
 * Ask a set of typed questions in a single request against the configured Laya server.
 *
 * Same failure taxonomy as the TypeSafe client (`capability_unavailable`,
 * `invalid_input`, `validation_failed`, `rate_limited`, `timeout`,
 * `PROVIDER_UNAVAILABLE`, plus `blocked_url` when the configured endpoint fails the
 * URL guard), so the decision router can treat both providers uniformly. The API
 * key, when configured, travels in exactly one Authorization header and nowhere
 * else; it is never in the URL, the body, a log line or an error. Nothing here
 * ever throws a raw error.
 */
export async function askLaya(input: LayaAskInput): Promise<LayaAskResult> {
  const { config } = input;
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!config.enabled) {
    throw new BrowserError("capability_unavailable", "The Laya decision provider is disabled in this deployment.", {
      hint: config.disabledReason ?? "Remove LAYA_ENABLED=false to enable it.",
      capability: "laya_decisions",
    });
  }
  if (!config.available || !config.endpoint) {
    throw new BrowserError("capability_unavailable", "The Laya server is not available on this Worker.", {
      hint: config.disabledReason ?? "Set LAYA_BASE_URL to the public https origin of your Laya server. DEMO never hard-codes a hosted Laya endpoint.",
      capability: "laya_decisions",
    });
  }

  // SSRF: the configured endpoint is operator input, so it goes through the same
  // URL guard as every outbound request in DEMO. Its fetch goes to the validated
  // URL only; a guard failure is a provider failure (the router falls back).
  const dnsCheck = String(input.env?.SSRF_DNS_CHECK ?? "true").toLowerCase() !== "false";
  const dns = input.dns !== undefined ? input.dns : dnsCheck ? createDohResolver() : null;
  try {
    await assertNavigableUrl(config.endpoint, {
      allowInsecureHttp: false,
      dns,
      dnsFailOpen: String(input.env?.SSRF_DNS_FAIL_OPEN ?? "false").toLowerCase() === "true",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BrowserError("blocked_url", "The configured Laya endpoint did not pass DEMO's URL safety policy.", {
      hint: `LAYA_BASE_URL must be a public https URL. Loopback, private networks, metadata endpoints, infrastructure ports, plain http and credential-bearing URLs are blocked. Guard said: ${sanitizeUntrustedProviderText(reason, 200)}`,
      capability: "laya_decisions",
    });
  }

  const ask: SystemOneAskInput = {
    state: input.state,
    questions: input.questions,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  return askSystemOne(layaDescriptor(config, apiKey), ask);
}

/**
 * One minimal round-trip used by the `/laya check` diagnostic. Sends a fixed tiny
 * noul question with no user data, and reports reachability plus usage. Never
 * throws: the outcome is a status report, not an error.
 */
export async function probeLaya(input: Pick<LayaAskInput, "config" | "apiKey" | "env" | "fetchImpl" | "dns">): Promise<{
  reachable: boolean;
  model: string | null;
  attempts: number;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  error: { code: string; message: string } | null;
}> {
  try {
    const result = await askLaya({
      ...input,
      state: { probe: "laya_status_check", note: "DEMO connectivity check only; it carries no request content." },
      questions: { probe: { type: "noul", instructions: "Is this a connectivity check? Answer true.", criteria: { true: "A connectivity check", false: "Not a connectivity check" } } },
    });
    return { reachable: true, model: result.model, attempts: result.attempts, usage: result.usage, error: null };
  } catch (error) {
    const code = error instanceof BrowserError ? error.code : "internal";
    const message = sanitizeUntrustedProviderText(error instanceof Error ? error.message : String(error), 240);
    return { reachable: false, model: null, attempts: 0, usage: null, error: { code, message } };
  }
}
