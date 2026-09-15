/**
 * Navigation safety: URL validation + SSRF protection.
 *
 * Every URL that reaches the browser (open, click-derived navigation, tab
 * creation, redirect verification) is validated here first. The checks are
 * defence in depth:
 *
 *   1. scheme allow-list (http/https only),
 *   2. static hostname / IP literal block-list (loopback, RFC1918, link-local,
 *      cloud metadata endpoints, internal DNS suffixes),
 *   3. DNS resolution through DNS-over-HTTPS so hostnames that resolve into
 *      private ranges are rejected as well,
 *   4. optional Browser Run `guardrails` (platform side egress policy) applied
 *      at session launch.
 *
 * The DNS step is best effort: the resolver result can be stale (DNS rebinding
 * / short TTL records), so it is a mitigation, not a proof. It never widens
 * access — it can only deny.
 */

import { BrowserError, capabilityUnavailable } from "./errors.js";

export interface DnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

export interface UrlGuardOptions {
  /** Allow plain `http://` URLs. Defaults to false (https preferred, http allowed for redirects only). */
  allowInsecureHttp?: boolean;
  /** DNS resolver used for the private-IP check. `null` disables the DNS step. */
  dns?: DnsResolver | null;
  /** When true, a DNS lookup failure does not block navigation. Defaults to false (fail closed). */
  dnsFailOpen?: boolean;
  /** Extra hostnames to deny (exact match, lower case). */
  blockedHostnames?: string[];
  /** Ports that are always denied regardless of the URL. */
  blockedPorts?: number[];
  /** When true, punycode/IDN hostnames are rejected. Defaults to false (flagged as a warning). */
  blockIdn?: boolean;
}

export type UrlGuardVerdict =
  | { ok: true; url: string; hostname: string; port: number; protocol: "http:" | "https:"; warnings: string[]; resolvedIps: string[] }
  | { ok: false; reason: string; code: BrowserError["code"]; hostname?: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "localhost.localdomain",
  "metadata",
  "metadata.internal",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".cluster.local",
  ".svc",
  ".onion", // not routable from the Browser Run network anyway
  ".i2p",
];

/** Ports that only ever expose infrastructure services, never a website. */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 135, 137, 138, 139, 143, 389, 445, 465, 587, 636, 873, 993, 995, 1433, 1521, 2049, 2375, 2376,
  3306, 3389, 5432, 5672, 5900, 5984, 6379, 6443, 7000, 7001, 8006, 8086, 8500, 9042, 9092, 9200, 9300, 11211, 15672,
  16379, 27017, 27018, 50070,
]);

const METADATA_IPS = new Set([
  "169.254.169.254", // AWS/GCP/Azure/DigitalOcean metadata
  "169.254.170.2", // ECS task metadata
  "100.100.100.200", // Alibaba Cloud metadata
  "192.0.0.192", // Oracle Cloud metadata
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const IPV4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (+ metadata)
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918 private
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved (includes 255.255.255.255)
];

export function isPrivateIpv4(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of IPV4_BLOCKS) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const address = ip.toLowerCase().split("%")[0];
  if (address === "::" || address === "::1") return true;
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const compat = /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (compat) return isPrivateIpv4(compat[1]);
  const head = address.split(":")[0];
  if (!head) return false;
  const first = Number.parseInt(head, 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (first === 0x0064 && address.startsWith("64:ff9b:")) return true; // NAT64
  if (first === 0x2001 && /^2001:(0*:)?(db8|0*db8)/i.test(address)) return true; // documentation
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  if (!value) return false;
  if (value.includes(":")) return isPrivateIpv6(value);
  return isPrivateIpv4(value);
}

/**
 * DNS-over-HTTPS resolver. Uses Cloudflare's public resolver, which is
 * reachable from a Worker without extra configuration.
 */
export function createDohResolver(fetchImpl: typeof fetch = fetch, endpoint = "https://cloudflare-dns.com/dns-query"): DnsResolver {
  return {
    async resolve(hostname: string): Promise<string[]> {
      const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=A,AAAA`;
      const response = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
      if (!response.ok) throw new Error(`DNS lookup failed with status ${response.status}`);
      const data = (await response.json()) as {
        Status?: number;
        Answer?: Array<{ type?: number; data?: string }>;
      };
      if (data.Status !== 0 || !Array.isArray(data.Answer)) return [];
      return data.Answer.map((answer) => String(answer.data ?? "").trim()).filter((entry) => entry.length > 0);
    },
  };
}

function hostnameFromUrl(url: URL): string {
  // `URL.hostname` keeps brackets for IPv6 literals; strip them for matching.
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export interface ParsedUrl {
  url: URL;
  hostname: string;
  isIpLiteral: boolean;
}

export function parseTargetUrl(input: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BrowserError("invalid_input", "Not a valid absolute URL.", {
      hint: "Provide a full URL such as https://example.com/page",
    });
  }
  return { url, hostname: hostnameFromUrl(url), isIpLiteral: isIpLiteralHostname(url.hostname) };
}

function isIpLiteralHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "");
  if (value.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

function deny(reason: string, code: BrowserError["code"] = "blocked_url", hostname?: string): UrlGuardVerdict {
  return { ok: false, reason, code, ...(hostname ? { hostname } : {}) };
}

/**
 * Synchronous, network-free portion of the guard. Exposed separately so it can
 * be unit tested and used on hot paths (e.g. validating a redirect target
 * while a page is already open).
 */
export function checkUrlSync(input: string, options: UrlGuardOptions = {}): UrlGuardVerdict {
  const { url, hostname, isIpLiteral } = parseTargetUrl(input);
  const warnings: string[] = [];

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return deny(`Only http(s) URLs can be opened (got "${url.protocol}").`, "invalid_input", hostname);
  }
  if (url.protocol === "http:" && options.allowInsecureHttp === false) {
    return deny("Plain http:// URLs are disabled for this deployment.", "blocked_url", hostname);
  }
  if (url.protocol === "http:") warnings.push("insecure-http");

  if (url.username || url.password) {
    return deny("URLs containing embedded credentials are not allowed.", "blocked_url", hostname);
  }
  if (!hostname) return deny("URL is missing a hostname.", "invalid_input", hostname);

  if (BLOCKED_HOSTNAMES.has(hostname)) return deny(`Hostname "${hostname}" is an internal or metadata endpoint.`, "blocked_url", hostname);
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return deny(`Hostname "${hostname}" resolves inside a private/internal DNS zone.`, "blocked_url", hostname);
    }
  }
  for (const extra of options.blockedHostnames ?? []) {
    if (hostname === extra.toLowerCase() || hostname.endsWith(`.${extra.toLowerCase()}`)) {
      return deny(`Hostname "${hostname}" is denylisted.`, "blocked_url", hostname);
    }
  }

  if (isIpLiteral && isPrivateIp(hostname)) {
    return deny(`IP address "${hostname}" is in a private, loopback, link-local or reserved range.`, "blocked_url", hostname);
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (Number.isFinite(port) && BLOCKED_PORTS.has(port)) {
    return deny(`Port ${port} is reserved for infrastructure services and cannot be browsed.`, "blocked_url", hostname);
  }

  if (hostname.includes("xn--") || /[^\x00-\x7F]/.test(hostname)) {
    if (options.blockIdn) return deny("Internationalised (IDN/punycode) hostnames are disabled.", "blocked_url", hostname);
    warnings.push("idn-hostname");
  }
  if (url.hostname !== hostname && url.hostname.startsWith("[")) warnings.push("ipv6-literal");

  return { ok: true, url: url.toString(), hostname, port, protocol: url.protocol as "http:" | "https:", warnings, resolvedIps: [] };
}

/**
 * Full guard: static checks + optional DNS resolution. Never performs the
 * navigation itself; callers must use the returned normalised `url`.
 */
export async function checkUrl(input: string, options: UrlGuardOptions = {}): Promise<UrlGuardVerdict> {
  const sync = checkUrlSync(input, options);
  if (!sync.ok) return sync;

  const { hostname, isIpLiteral } = parseTargetUrl(sync.url);
  if (isIpLiteral || !options.dns) return sync;

  let ips: string[];
  try {
    ips = await options.dns.resolve(hostname);
  } catch (error) {
    if (options.dnsFailOpen ?? true) {
      return { ...sync, warnings: [...sync.warnings, "dns-unverified"] };
    }
    return deny(
      `Unable to verify "${hostname}" against private IP ranges (DNS lookup failed).`,
      "blocked_url",
      hostname,
    );
  }

  const privateHits = ips.filter((ip) => isPrivateIp(ip));
  if (privateHits.length > 0) {
    return deny(`Hostname "${hostname}" resolves to a private/internal address.`, "blocked_url", hostname);
  }
  return { ...sync, resolvedIps: ips.slice(0, 10) };
}

/** Throwing variant used by the MCP tools. */
export async function assertNavigableUrl(input: string, options: UrlGuardOptions = {}): Promise<Extract<UrlGuardVerdict, { ok: true }>> {
  const verdict = await checkUrl(input, options);
  if (!verdict.ok) {
    throw new BrowserError(verdict.code, verdict.reason, {
      hint: "Navigation is restricted to public HTTP(S) websites. Private networks, metadata endpoints and localhost are blocked.",
      data: { hostname: verdict.hostname ?? null },
    });
  }
  return verdict;
}

/**
 * Build hostname patterns for Browser Run `guardrails` from a list of hosts.
 * The platform latches the policy for the whole session and fails closed, so
 * only pass domains the session is expected to visit.
 */
export function buildGuardrailDomains(hosts: string[]): string[] | null {
  const cleaned = hosts
    .map((host) => host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, ""))
    .filter(Boolean);
  if (cleaned.length === 0) return null;
  return [...new Set(cleaned)].slice(0, 50);
}

export function guardCapabilityMessage(): BrowserError {
  return capabilityUnavailable(
    "url_guard",
    "Navigation is blocked by the DEMO URL policy.",
    "Configure BROWSER_ALLOWED_DOMAINS or relax BROWSER_SSRF_* settings if this target should be reachable.",
  );
}
