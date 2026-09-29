/**
 * URL safety inspector (DEMO 0.9) — a *report* over the existing SSRF stack.
 *
 * It never weakens `core/url-guard`; it exposes what that guard decides, plus
 * redirect-chain inspection (every hop validated like `http_fetch` does),
 * hostname resolution and classification, and a static suspicious-pattern
 * report (open-redirect parameters, credential tricks, alternate IP notations,
 * scheme oddities). The explicit block list — localhost, RFC1918, loopback,
 * link-local, metadata services, internal Cloudflare/DNS zones, unsafe schemes,
 * SSRF bypass shapes — is the one in `core/url-guard.ts`; this module adds
 * detection/reporting on top and never a bypass.
 */

import { checkUrl, checkUrlSync, createDohResolver, isPrivateIp, parseTargetUrl } from "../core/url-guard.js";
import { selfOrigins } from "../core/guarded-fetch.js";
import { clamp } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";

export interface SuspiciousFlag {
  flag: string;
  detail: string;
  severity: "info" | "warning" | "high";
}

export interface RedirectHopReport {
  url: string;
  status: number | null;
  location: string | null;
  target: string | null;
  verdict: "ok" | "blocked" | "unfollowed";
  reason: string | null;
}

export interface UrlSafetyReport {
  input: string;
  normalized: string | null;
  parsed: {
    scheme: string | null;
    hostname: string | null;
    port: number | null;
    path: string | null;
    query: Record<string, string>;
    hasUserInfo: boolean;
  };
  classification: {
    verdict: "public" | "blocked" | "invalid";
    publicOrPrivate: "public" | "private" | "unknown";
    resolvedIps: string[];
    reason: string | null;
  };
  suspicious: SuspiciousFlag[];
  redirectChain: RedirectHopReport[];
  finalUrl: string | null;
  finalVerdict: "public" | "blocked" | "not-checked" | null;
  response: { status: number | null; securityHeaders: Record<string, string | null> } | null;
  message: string;
}

const OPEN_REDIRECT_PARAMS = /^(next|url|redirect|redirect_uri|redirect_url|return|return_to|returnto|goto|target|dest|destination|continue|redir|rurl|forward|u|q|link|href|image_url|img|page|load|fetch)$/i;
const SUSPICIOUS_SCHEMES = new Set(["javascript", "data", "file", "vbscript", "blob", "about", "chrome", "jar", "gopher", "dict", "sftp", "ldap"]);

/** Static analysis of a URL string — no network, safe for preflight checks. */
export function inspectUrlStatic(input: string): UrlSafetyReport {
  const suspicious: SuspiciousFlag[] = [];
  let normalized: string | null = null;
  let parsed: UrlSafetyReport["parsed"] = { scheme: null, hostname: null, port: null, path: null, query: {}, hasUserInfo: false };
  let classification: UrlSafetyReport["classification"] = { verdict: "invalid", publicOrPrivate: "unknown", resolvedIps: [], reason: null };

  // Pre-parse oddities before the guard normalises anything.
  if (/\s/.test(input)) suspicious.push({ flag: "whitespace-in-url", detail: "The URL contains whitespace, which some parsers strip or split on.", severity: "warning" });
  if (input.length > 2_000) suspicious.push({ flag: "very-long-url", detail: `URL length ${input.length} — possible parser-confusion or payload smuggling attempt.`, severity: "warning" });
  if (/\\/.test(input)) suspicious.push({ flag: "backslash-in-url", detail: "Backslashes can be normalised to slashes by some parsers (SSRF bypass shape).", severity: "warning" });
  if (/%00|%0d|%0a|%09/i.test(input)) suspicious.push({ flag: "encoded-control-characters", detail: "Percent-encoded control characters can confuse downstream parsers.", severity: "high" });
  if (/^https?:\/\/[\d.]+[:/]/i.test(input) && !/^(127|10|192|172|169|0)\./.test(input.replace(/^https?:\/\//i, ""))) {
    const literal = input.replace(/^https?:\/\//i, "").split(/[/:]/)[0];
    if (/^\d{1,}(\.\d{1,3}){3}$/.test(literal) && literal.split(".").some((part) => Number(part) > 255)) {
      suspicious.push({ flag: "invalid-ip-literal", detail: "The host looks like an IP literal with out-of-range octets.", severity: "warning" });
    }
  }
  const decimalIp = /^https?:\/\/0x[0-9a-f.]+|^https?:\/\/\d{8,}/i.test(input);
  if (decimalIp) suspicious.push({ flag: "alternate-ip-notation", detail: "Decimal/hexadecimal host forms are used to disguise IP literals; the guard normalises and classifies the resolved address.", severity: "high" });
  if (/^https?:\/\/[^/]*@/i.test(input)) suspicious.push({ flag: "embedded-userinfo", detail: "user:password@ in a URL is both a credential leak and a parser-confusion vector; DEMO rejects these outright.", severity: "high" });
  if (/^https?:\/\/[^/]*%2f%2f/i.test(input)) suspicious.push({ flag: "double-encoded-host", detail: "Double-encoded separators are an SSRF bypass shape.", severity: "warning" });

  const sync = checkUrlSync(input, { allowInsecureHttp: true });
  if (!sync.ok) {
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(input.trim());
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
    if (scheme && SUSPICIOUS_SCHEMES.has(scheme)) {
      suspicious.push({ flag: "unsafe-scheme", detail: `"${scheme}:" URLs are never fetched.`, severity: "high" });
    }
    classification = { verdict: "blocked", publicOrPrivate: "unknown", resolvedIps: [], reason: sync.reason };
    return {
      input: input.slice(0, 2_000),
      normalized: null,
      parsed,
      classification,
      suspicious,
      redirectChain: [],
      finalUrl: null,
      finalVerdict: null,
      response: null,
      message: `Blocked by DEMO's URL policy: ${sync.reason}`,
    };
  }

  try {
    const target = parseTargetUrl(sync.url);
    const query: Record<string, string> = {};
    target.url.searchParams.forEach((value, key) => {
      query[key] = value.slice(0, 200);
      if (OPEN_REDIRECT_PARAMS.test(key) && /^https?:/i.test(value)) {
        suspicious.push({ flag: "open-redirect-parameter", detail: `Query parameter "${key}" carries a full URL — classic open-redirect / SSRF pivot shape.`, severity: "warning" });
      }
      if (value.length > 500) suspicious.push({ flag: "oversized-query-value", detail: `Query parameter "${key}" is ${value.length} characters.`, severity: "info" });
    });
    parsed = {
      scheme: target.url.protocol.replace(":", ""),
      hostname: target.hostname,
      port: target.url.port ? Number(target.url.port) : target.url.protocol === "https:" ? 443 : 80,
      path: target.url.pathname.slice(0, 400),
      query,
      hasUserInfo: Boolean(target.url.username || target.url.password),
    };
  } catch {
    /* keep defaults */
  }
  normalized = sync.url;
  if (sync.warnings.includes("insecure-http")) suspicious.push({ flag: "insecure-http", detail: "The URL uses plain http:// — traffic is unencrypted.", severity: "info" });
  if (sync.warnings.includes("idn-hostname")) suspicious.push({ flag: "idn-hostname", detail: "The hostname is internationalised; homograph lookalikes are possible.", severity: "info" });

  return {
    input: input.slice(0, 2_000),
    normalized,
    parsed,
    classification: { verdict: "public", publicOrPrivate: "public", resolvedIps: [], reason: null },
    suspicious,
    redirectChain: [],
    finalUrl: null,
    finalVerdict: "not-checked",
    response: null,
    message: "Static checks passed. Use follow_redirects for destination inspection — every hop is re-validated against the same policy.",
  };
}

/** Full inspection: static checks + optional redirect walk (HEAD, every hop guarded). */
export async function inspectUrl(
  env: Record<string, unknown> | undefined,
  input: string,
  options: { followRedirects?: boolean; maxRedirects?: number; fetchImpl?: typeof fetch } = {},
): Promise<UrlSafetyReport> {
  publicToolRateLimiter.charge(env, "url_inspect", input);
  const report = inspectUrlStatic(input);
  if (report.classification.verdict === "blocked") return report;
  const fetchImpl = options.fetchImpl ?? fetch;
  // DEMO's own origin is reported as blocked rather than "public": the platform
  // refuses a same-zone Worker-to-Worker fetch (error code 1042), so a report
  // that called it reachable would be wrong about the only caller that matters.
  const verdict = await checkUrl(input, { allowInsecureHttp: true, dns: createDohResolver(), blockedOrigins: selfOrigins(env) });
  if (!verdict.ok) {
    return {
      ...report,
      classification: { verdict: "blocked", publicOrPrivate: "private", resolvedIps: [], reason: verdict.reason },
      finalVerdict: null,
      message: `Blocked after DNS resolution: ${verdict.reason}`,
    };
  }
  report.classification = {
    verdict: "public",
    publicOrPrivate: verdict.resolvedIps.length ? (verdict.resolvedIps.every((ip) => !isPrivateIp(ip)) ? "public" : "private") : "unknown",
    resolvedIps: verdict.resolvedIps,
    reason: null,
  };
  if (!options.followRedirects) return report;

  const maxRedirects = clamp(options.maxRedirects ?? 5, 0, 8);
  const chain: RedirectHopReport[] = [];
  let currentUrl = verdict.url;
  let finalVerdict: UrlSafetyReport["finalVerdict"] = "public";
  let responseInfo: UrlSafetyReport["response"] = null;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, { method: "HEAD", redirect: "manual", signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      chain.push({ url: currentUrl, status: null, location: null, target: null, verdict: "unfollowed", reason: String(error instanceof Error ? error.message : error).slice(0, 140) });
      break;
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get("location");
    chain.push({ url: currentUrl, status: response.status, location, target: null, verdict: "ok", reason: null });
    // The terminating response's headers are the interesting ones.
    {
      const securityHeaders: Record<string, string | null> = {};
      for (const name of ["strict-transport-security", "content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "server", "via", "cf-ray"]) {
        securityHeaders[name] = response.headers.get(name);
      }
      responseInfo = { status: response.status, securityHeaders };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400 || !location) break;
    let next: string;
    try {
      next = new URL(location, currentUrl).toString();
    } catch {
      chain[chain.length - 1].verdict = "blocked";
      chain[chain.length - 1].reason = "unparsable redirect target";
      finalVerdict = "blocked";
      break;
    }
    chain[chain.length - 1].target = next.slice(0, 500);
    const nextVerdict = await checkUrl(next, { allowInsecureHttp: true, dns: createDohResolver(), blockedOrigins: selfOrigins(env) });
    if (!nextVerdict.ok) {
      chain[chain.length - 1].verdict = "blocked";
      chain[chain.length - 1].reason = nextVerdict.reason;
      finalVerdict = "blocked";
      report.suspicious.push({ flag: "redirect-to-blocked-target", detail: `A redirect pointed at ${safeHost(next)} which the policy blocks: ${nextVerdict.reason}`, severity: "high" });
      break;
    }
    // Suspicious redirect patterns (cross-scheme downgrade, host flips).
    if (new URL(nextVerdict.url).protocol === "http:" && new URL(currentUrl).protocol === "https:") {
      report.suspicious.push({ flag: "https-downgrade-redirect", detail: `The chain downgrades to plain http at ${safeHost(nextVerdict.url)}.`, severity: "warning" });
    }
    if (new URL(nextVerdict.url).host !== new URL(currentUrl).host) {
      report.suspicious.push({ flag: "multi-host-redirect", detail: `The chain hops between hosts (…${safeHost(currentUrl)} → ${safeHost(nextVerdict.url)}).`, severity: "info" });
    }
    currentUrl = nextVerdict.url;
    if (hop === maxRedirects) {
      chain[chain.length - 1].verdict = "unfollowed";
      chain[chain.length - 1].reason = `redirect limit (${maxRedirects}) reached`;
    }
  }

  return {
    ...report,
    redirectChain: chain,
    finalUrl: currentUrl,
    finalVerdict,
    response: responseInfo,
    message:
      finalVerdict === "blocked"
        ? "The chain contains a blocked destination; DEMO stopped rather than follow it."
        : `Followed ${chain.length} hop(s). Every hop re-validated against the same URL policy; Set-Cookie and Authorization headers are never echoed.`,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "[invalid]";
  }
}
