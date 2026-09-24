/**
 * Safe public-network diagnostics (DEMO 0.9).
 *
 * DNS inspection through the same DNS-over-HTTPS resolver the SSRF guard uses,
 * HTTP status/redirect-chain/header/timing inspection through the same
 * guarded fetch every other capability uses, and TLS certificate metadata when
 * the browser binding can observe it (Cloudflare Workers' fetch does not expose
 * peer certificates — that is reported as unavailable rather than guessed).
 *
 * This must never become an internal-network scanner: there is no port
 * probing, no protocol fingerprinting of arbitrary services, no sweep mode —
 * one hostname/URL at a time, through the existing deny-list (localhost,
 * RFC1918, link-local, metadata, internal DNS suffixes, blocked ports).
 */

import { BrowserError } from "../core/errors.js";
import { checkUrl, createDohResolver, isPrivateIp, type DnsResolver } from "../core/url-guard.js";
import { LIMITS, clamp } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";

export interface DnsRecordView {
  type: string;
  value: string;
  ttl: number | null;
}

export interface DnsReport {
  hostname: string;
  resolvable: boolean;
  addresses: string[];
  publicAddresses: boolean | null;
  records: DnsRecordView[];
  resolver: string;
  message: string;
}

const RECORD_TYPES = ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "CAA", "SRV"] as const;

/** DNS record inspection over DoH (Cloudflare's public resolver, like the guard). */
export async function dnsLookup(
  env: Record<string, unknown> | undefined,
  hostname: string,
  options: { types?: string[]; resolver?: DnsResolver } = {},
): Promise<DnsReport> {
  publicToolRateLimiter.charge(env, "net_diagnose", hostname);
  const name = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9._-]{1,253}$/i.test(name) && !/^[0-9.]+$/.test(name) && !name.includes(":")) {
    throw new BrowserError("invalid_input", "That is not a valid hostname for a DNS lookup.", { retryable: false });
  }
  // Reuse the guard's classification so diagnostics cannot inspect internals.
  const verdict = await checkUrl(`https://${name}/`, {
    allowInsecureHttp: true,
    dns: null,
  });
  if (!verdict.ok) {
    throw new BrowserError(verdict.code, `DNS diagnostics are restricted to public hostnames: ${verdict.reason}`, {
      hint: "localhost, private ranges, link-local and metadata endpoints are never queried.",
    });
  }

  const resolver = options.resolver ?? createDohResolver();
  const types = (options.types?.length ? options.types : RECORD_TYPES).filter((type): type is (typeof RECORD_TYPES)[number] => (RECORD_TYPES as readonly string[]).includes(type)).slice(0, 6);
  const records: DnsRecordView[] = [];
  const addresses: string[] = [];
  for (const type of types) {
    const entries = await dohQuery(name, type, resolver);
    for (const entry of entries) {
      records.push(entry);
      if (type === "A" || type === "AAAA") addresses.push(entry.value);
    }
  }
  return {
    hostname: name,
    resolvable: addresses.length > 0 || records.length > 0,
    addresses: addresses.slice(0, 12),
    publicAddresses: addresses.length ? addresses.every((address) => !isPrivateIp(address)) : null,
    records: records.slice(0, 40),
    resolver: "https://cloudflare-dns.com/dns-query",
    message:
      records.length === 0
        ? `No records of the requested types were found for ${name} (or the name does not resolve).`
        : `DNS is read-only observation; DEMO never enumerates internal names or resolves wildcards beyond the queried types.`,
  };
}

async function dohQuery(name: string, type: string, _resolver: DnsResolver): Promise<DnsRecordView[]> {
  // Direct DoH JSON queries per record type (the guard's resolver is A/AAAA only).
  try {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { Status?: number; Answer?: Array<{ name?: string; type?: number; data?: string; TTL?: number }> };
    if (data.Status !== 0 || !Array.isArray(data.Answer)) return [];
    return data.Answer.filter((answer) => answer.data).map((answer) => ({
      type,
      value: String(answer.data).slice(0, 500),
      ttl: typeof answer.TTL === "number" ? answer.TTL : null,
    }));
  } catch {
    return [];
  }
}

export interface HttpHop {
  url: string;
  status: number | null;
  location: string | null;
  timingMs: number;
  blocked: boolean | null;
  reason: string | null;
}

export interface TlsReport {
  available: boolean;
  issuer: string | null;
  subject: string | null;
  validFrom: string | null;
  validTo: string | null;
  expiresInDays: number | null;
  protocol: string | null;
  message: string;
}

export interface HttpDiagnosis {
  url: string;
  finalUrl: string;
  status: number | null;
  redirected: boolean;
  redirectChain: HttpHop[];
  headers: Record<string, string>;
  timing: { dnsValidatedMs: number; totalMs: number };
  resolvedAddresses: string[];
  securityHeaders: {
    strictTransportSecurity: string | null;
    contentSecurityPolicy: string | null;
    xContentTypeOptions: string | null;
    xFrameOptions: string | null;
    referrerPolicy: string | null;
    permissionsPolicy: string | null;
  };
  tls: TlsReport | null;
  message: string;
}

/** HTTP status + redirect chain + headers + timing through the guarded fetch. */
export async function httpDiagnose(
  env: Record<string, unknown> | undefined,
  url: string,
  options: { method?: "GET" | "HEAD"; maxRedirects?: number; fetchImpl?: typeof fetch } = {},
): Promise<HttpDiagnosis> {
  publicToolRateLimiter.charge(env, "net_diagnose", url);
  const started = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = clamp(options.maxRedirects ?? 5, 0, 8);
  const dnsStart = Date.now();
  // Guard + DNS validation first (records resolved addresses for the report).
  const verdict = await checkUrl(url, { allowInsecureHttp: true, dns: createDohResolver() });
  const dnsValidatedMs = Date.now() - dnsStart;
  if (!verdict.ok) {
    throw new BrowserError(verdict.code, `Network diagnostics are restricted to public targets: ${verdict.reason}`, {
      hint: "This tool refuses internal addresses instead of probing them.",
    });
  }
  const chain: HttpHop[] = [];
  let currentUrl = verdict.url;
  const headerSnapshot: Record<string, string> = {};
  let status: number | null = null;
  let finalUrl = currentUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const hopStart = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, { method: options.method ?? "HEAD", redirect: "manual", signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      chain.push({ url: currentUrl, status: null, location: null, timingMs: Date.now() - hopStart, blocked: null, reason: String(error instanceof Error ? error.message : error).slice(0, 160) });
      break;
    } finally {
      clearTimeout(timer);
    }
    status = response.status;
    const location = response.headers.get("location");
    chain.push({ url: currentUrl, status: response.status, location, timingMs: Date.now() - hopStart, blocked: null, reason: null });
    // Keep overwriting so the FINAL response's headers win (redirect hops
    // usually carry none of the security headers callers care about).
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "set-cookie" || /(authorization|token|secret|session)/i.test(lower)) return;
      if (lower === "location" && headerSnapshot["content-type"]) return;
      headerSnapshot[lower] = value.slice(0, 300);
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400 || !location) break;
    let next: string;
    try {
      next = new URL(location, currentUrl).toString();
    } catch {
      chain[chain.length - 1].blocked = true;
      chain[chain.length - 1].reason = "unparsable redirect target; not followed";
      break;
    }
    const nextVerdict = await checkUrl(next, { allowInsecureHttp: true, dns: createDohResolver() });
    if (!nextVerdict.ok) {
      chain[chain.length - 1].blocked = true;
      chain[chain.length - 1].reason = `redirect target blocked: ${nextVerdict.reason}`;
      break;
    }
    currentUrl = nextVerdict.url;
    finalUrl = currentUrl;
    if (hop === maxRedirects) {
      chain[chain.length - 1].blocked = true;
      chain[chain.length - 1].reason = `redirect limit (${maxRedirects}) reached; not following further`;
    }
  }

  return {
    url: verdict.url,
    finalUrl,
    status,
    redirected: chain.length > 1,
    redirectChain: chain,
    headers: headerSnapshot,
    timing: { dnsValidatedMs, totalMs: Date.now() - started },
    resolvedAddresses: verdict.resolvedIps,
    securityHeaders: {
      strictTransportSecurity: headerSnapshot["strict-transport-security"] ?? null,
      contentSecurityPolicy: headerSnapshot["content-security-policy"] ?? null,
      xContentTypeOptions: headerSnapshot["x-content-type-options"] ?? null,
      xFrameOptions: headerSnapshot["x-frame-options"] ?? null,
      referrerPolicy: headerSnapshot["referrer-policy"] ?? null,
      permissionsPolicy: headerSnapshot["permissions-policy"] ?? headerSnapshot["feature-policy"] ?? null,
    },
    tls: null,
    message: "Header values and redirect hops are observed as-is; credential-shaped headers (Set-Cookie, Authorization) are never echoed.",
  };
}

/**
 * TLS certificate metadata via DEMO's existing browser binding when it is
 * available (Puppeteer's `securityDetails()` on the navigation response).
 * Cloudflare `fetch` cannot see peer certificates, so without the browser the
 * report says `available: false` — never a fabricated issuer/expiry.
 */
export async function tlsDiagnose(
  env: Record<string, unknown> & { BROWSER?: unknown },
  url: string,
  options: { withRawPage?: (fn: (page: any) => Promise<TlsReport>) => Promise<TlsReport> },
): Promise<TlsReport> {
  publicToolRateLimiter.charge(env, "net_diagnose-tls", url);
  const verdict = await checkUrl(url, { allowInsecureHttp: false, dns: createDohResolver() });
  if (!verdict.ok) {
    throw new BrowserError(verdict.code, `TLS diagnostics are restricted to public https targets: ${verdict.reason}`, { hint: "Internal hosts are never inspected." });
  }
  if (!options.withRawPage) {
    return {
      available: false,
      issuer: null,
      subject: null,
      validFrom: null,
      validTo: null,
      expiresInDays: null,
      protocol: null,
      message: "TLS certificate metadata requires the Cloudflare Browser Rendering binding (peer certificates are not exposed to Workers fetch). This deployment reported it unavailable instead of guessing.",
    };
  }
  try {
    return await options.withRawPage(async (page: any) => {
      const response = await page.goto(verdict.url, { waitUntil: "domcontentloaded", timeout: LIMITS.navigationTimeoutDefaultMs });
      let details: { issuer?: () => string; validFrom?: () => number; validTo?: () => number; subjectName?: () => string; protocol?: () => string } | null = null;
      try {
        details = response?.request?.()?.response?.()?.securityDetails?.() ?? response?.securityDetails?.() ?? null;
      } catch {
        details = null;
      }
      if (!details || typeof details.validTo !== "function") {
        return {
          available: false,
          issuer: null,
          subject: null,
          validFrom: null,
          validTo: null,
          expiresInDays: null,
          protocol: null,
          message: "The browser connected, but the platform did not expose certificate details for this response.",
        };
      }
      const validToMs = details.validTo();
      const validFromMs = details.validFrom?.();
      return {
        available: true,
        issuer: details.issuer?.() ?? null,
        subject: details.subjectName?.() ?? null,
        validFrom: validFromMs ? new Date(validFromMs).toISOString() : null,
        validTo: validToMs ? new Date(validToMs).toISOString() : null,
        expiresInDays: Number.isFinite(validToMs) ? Math.round((validToMs - Date.now()) / 86_400_000) : null,
        protocol: details.protocol?.() ?? null,
        message: "Certificate metadata as reported by the browser's TLS stack. Expiry is informational; browsers enforce it independently.",
      };
    });
  } catch (error) {
    return {
      available: false,
      issuer: null,
      subject: null,
      validFrom: null,
      validTo: null,
      expiresInDays: null,
      protocol: null,
      message: `TLS inspection failed: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`,
    };
  }
}
