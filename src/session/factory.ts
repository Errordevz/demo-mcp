/**
 * Wiring for the browser subsystem: provider, managers, URL guard and the
 * runtime factory. Shared by the Durable Object and by the in-process fallback
 * so both behave identically.
 */

import { ChallengeManager } from "../browser/challenge.js";
import { MediaInspector } from "../browser/media.js";
import type { ManagerContext } from "../browser/ops.js";
import { createProvider, type ProviderEnv } from "../browser/providers/index.js";
import { ScreenshotManager, type ObjectStore } from "../browser/screenshot.js";
import { BrowserRuntime, createSessionState, type RuntimeHooks, type SessionState } from "../browser/runtime.js";
import { assertNavigableUrl, buildGuardrailDomains, createDohResolver } from "../core/url-guard.js";
import { LIMITS, clampKeepAlive } from "../core/limits.js";
import type { BrowserProvider, ProviderName } from "../browser/types.js";

export interface BrowserEnv extends ProviderEnv {
  SCREENSHOTS?: unknown;
  SCREENSHOT_BASE_URL?: string;
  BROWSER_KEEPALIVE_MS?: string | number;
  BROWSER_ALLOWED_DOMAINS?: string;
  BROWSER_BLOCKED_HOSTNAMES?: string;
  BROWSER_ALLOW_INSECURE_HTTP?: string;
  BROWSER_BLOCK_IDN?: string;
  SSRF_DNS_CHECK?: string;
  SSRF_DNS_FAIL_OPEN?: string;
}

export interface BrowserDependencies {
  provider: BrowserProvider;
  managers: ManagerContext;
  validateUrl: (url: string) => Promise<string>;
  guardrails: { allowedDomains?: string[]; allowedDomainSets?: string[] } | null;
  keepAliveMs: number;
  screenshotBaseUrl: string;
}

export function createBrowserDependencies(env: BrowserEnv, screenshotBaseUrl: string): BrowserDependencies {
  const provider = createProvider(env);
  const screenshots = new ScreenshotManager(env.SCREENSHOTS as ObjectStore | undefined, screenshotBaseUrl);
  const challenge = new ChallengeManager(provider);
  const media = new MediaInspector(screenshots);
  const managers: ManagerContext = { screenshots, challenge, media };

  const blockedHostnames = (env.BROWSER_BLOCKED_HOSTNAMES ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const dnsEnabled = String(env.SSRF_DNS_CHECK ?? "true").toLowerCase() !== "false";
  const dns = dnsEnabled ? createDohResolver() : null;
  const options = {
    allowInsecureHttp: String(env.BROWSER_ALLOW_INSECURE_HTTP ?? "true").toLowerCase() === "true",
    dns,
    // Default is fail-open for the *DNS* step only: the static checks above are
    // always enforced, and blocking every navigation whenever the resolver is
    // unreachable would be a self-inflicted outage. Set SSRF_DNS_FAIL_OPEN=false
    // to deny navigation when a hostname cannot be verified.
    dnsFailOpen: String(env.SSRF_DNS_FAIL_OPEN ?? "true").toLowerCase() === "true",
    blockedHostnames,
    blockIdn: String(env.BROWSER_BLOCK_IDN ?? "false").toLowerCase() === "true",
  };

  const validateUrl = async (url: string): Promise<string> => {
    const verdict = await assertNavigableUrl(url, options);
    return verdict.url;
  };

  return {
    provider,
    managers,
    validateUrl,
    guardrails: (() => {
      const domains = buildGuardrailDomains((env.BROWSER_ALLOWED_DOMAINS ?? "").split(","));
      return domains ? { allowedDomains: domains } : null;
    })(),
    keepAliveMs: clampKeepAlive(Number(env.BROWSER_KEEPALIVE_MS ?? LIMITS.keepAliveDefaultMs)),
    screenshotBaseUrl,
  };
}

export function providerName(env: BrowserEnv): ProviderName {
  return String(env.BROWSER_PROVIDER ?? "cloudflare").toLowerCase() === "node" ? "node" : "cloudflare";
}

export function createRuntime(
  state: SessionState,
  deps: BrowserDependencies,
  hooks: Omit<RuntimeHooks, "validateUrl">,
): BrowserRuntime {
  if (deps.guardrails && !state.guardrails) state.guardrails = deps.guardrails;
  return new BrowserRuntime(deps.provider, state, deps.managers, {
    validateUrl: deps.validateUrl,
    ...hooks,
  });
}

export function newSessionState(sessionId: string, env: BrowserEnv): SessionState {
  return createSessionState(sessionId, providerName(env), clampKeepAlive(Number(env.BROWSER_KEEPALIVE_MS ?? LIMITS.keepAliveDefaultMs)));
}

export type { BrowserProvider };

/**
 * Public base URL used for screenshot links.
 *
 * The deployed Worker serves `/screenshots/:id`, so links are built from the
 * incoming request origin when available and fall back to the configured
 * deployment URL. `SCREENSHOT_BASE_URL` overrides both.
 */
export const DEFAULT_SCREENSHOT_BASE = "https://demo-mcp.www-notamirrblx.workers.dev/screenshots";

export function resolveScreenshotBase(env: BrowserEnv, requestUrl?: string | null): string {
  const configured = (env.SCREENSHOT_BASE_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (requestUrl) {
    try {
      return `${new URL(requestUrl).origin}/screenshots`;
    } catch {
      /* ignore and fall through */
    }
  }
  return DEFAULT_SCREENSHOT_BASE;
}
