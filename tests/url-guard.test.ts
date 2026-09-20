import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkUrl, checkUrlSync, createDohResolver, isPrivateIp, isPrivateIpv4, isPrivateIpv6, resetDohCache } from "../src/core/url-guard.js";

const publicResolver = { resolve: async () => ["93.184.216.34"] };
const privateResolver = { resolve: async () => ["10.0.0.5"] };
const metadataResolver = { resolve: async () => ["169.254.169.254"] };

describe("url guard — static checks", () => {
  it("accepts public http(s) URLs", () => {
    for (const url of ["https://example.com/", "http://example.com:8080/path?q=1", "https://www.tiktok.com/@a/video/1"]) {
      const verdict = checkUrlSync(url, { allowInsecureHttp: true, dns: null });
      expect(verdict.ok, `${url} should be allowed`).toBe(true);
    }
  });

  it("rejects non-http schemes", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x", "chrome://settings", "ws://example.com"]) {
      const verdict = checkUrlSync(url, { allowInsecureHttp: true, dns: null });
      expect(verdict.ok, `${url} should be blocked`).toBe(false);
    }
  });

  it("rejects embedded credentials", () => {
    const verdict = checkUrlSync("https://user:pass@example.com/", { dns: null });
    expect(verdict.ok).toBe(false);
  });

  it("rejects localhost and internal DNS suffixes", () => {
    for (const host of [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://0.0.0.0/",
      "https://api.internal/",
      "https://db.cluster.local/",
      "https://printer.local/",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://kubernetes.default.svc/",
    ]) {
      const verdict = checkUrlSync(host, { allowInsecureHttp: true, dns: null });
      expect(verdict.ok, `${host} should be blocked`).toBe(false);
    }
  });

  it("rejects cloud metadata IP literals", () => {
    for (const host of ["http://169.254.169.254/latest/meta-data/", "http://100.100.100.200/", "http://192.0.0.192/"]) {
      const verdict = checkUrlSync(host, { allowInsecureHttp: true, dns: null });
      expect(verdict.ok, `${host} should be blocked`).toBe(false);
    }
  });

  it("normalises obfuscated IP literals before checking", () => {
    // WHATWG URL parsing converts these to dotted-quad form.
    for (const host of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/"]) {
      const verdict = checkUrlSync(host, { allowInsecureHttp: true, dns: null });
      expect(verdict.ok, `${host} should be blocked`).toBe(false);
    }
  });

  it("rejects infrastructure ports", () => {
    for (const port of [22, 3306, 6379, 9200, 27017]) {
      const verdict = checkUrlSync(`https://example.com:${port}/`, { dns: null });
      expect(verdict.ok, port.toString()).toBe(false);
    }
  });

  it("flags IDN hostnames and can block them", () => {
    const flagged = checkUrlSync("https://xn--80ak6aa92e.com/", { dns: null });
    expect(flagged.ok).toBe(true);
    expect(flagged.ok && flagged.warnings).toContain("idn-hostname");
    const blocked = checkUrlSync("https://xn--80ak6aa92e.com/", { dns: null, blockIdn: true });
    expect(blocked.ok).toBe(false);
  });
});

describe("url guard — DNS resolution", () => {
  it("allows hostnames that resolve to public addresses", async () => {
    const verdict = await checkUrl("https://example.com/", { dns: publicResolver });
    expect(verdict.ok).toBe(true);
  });

  it("blocks hostnames that resolve into private ranges", async () => {
    const verdict = await checkUrl("https://internal.example.com/", { dns: privateResolver });
    expect(verdict.ok).toBe(false);
  });

  it("blocks hostnames that resolve to the metadata endpoint", async () => {
    const verdict = await checkUrl("https://metadata.example.com/", { dns: metadataResolver });
    expect(verdict.ok).toBe(false);
  });

  it("fails open with a warning when the resolver is unreachable", async () => {
    const failing = { resolve: async () => { throw new Error("DNS lookup failed"); } };
    const open = await checkUrl("https://example.com/", { dns: failing });
    expect(open.ok).toBe(true);
    expect(open.ok && open.warnings).toContain("dns-unverified");
  });

  it("can be configured to fail closed when a hostname cannot be verified", async () => {
    const failing = { resolve: async () => { throw new Error("DNS lookup failed"); } };
    const closed = await checkUrl("https://example.com/", { dns: failing, dnsFailOpen: false });
    expect(closed.ok).toBe(false);
  });

  it("names the lookup failure when failing closed so environment limits are diagnosable", async () => {
    const failing = { resolve: async () => { throw new Error("Too many subrequests."); } };
    const closed = await checkUrl("https://example.com/", { dns: failing, dnsFailOpen: false });
    expect(closed.ok).toBe(false);
    expect(!closed.ok && closed.code).toBe("blocked_url");
    expect(!closed.ok && closed.reason).toContain("DNS lookup failed: Too many subrequests.");
  });
});

describe("url guard — DoH resolver", () => {
  type DnsAnswer = { type: number; data: string; TTL?: number };
  const dnsJson = (answers: DnsAnswer[], status = 0) =>
    new Response(JSON.stringify({ Status: status, Answer: answers }), {
      status: 200,
      headers: { "content-type": "application/dns-json" },
    });
  const stubFetch = (handler: (name: string, type: string) => Response | Promise<Response>) => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type") ?? "";
      calls.push(`${name}/${type}`);
      return handler(name, type);
    }) as typeof fetch;
    return { fetchImpl, calls };
  };

  beforeEach(() => {
    resetDohCache();
    vi.useRealTimers();
  });
  afterEach(() => {
    resetDohCache();
    vi.useRealTimers();
  });

  it("queries A and AAAA and merges the answers", async () => {
    const { fetchImpl, calls } = stubFetch((_name, type) =>
      type === "A"
        ? dnsJson([{ type: 1, data: "93.184.216.34", TTL: 300 }])
        : dnsJson([{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946", TTL: 300 }]),
    );
    const resolver = createDohResolver(fetchImpl);
    await expect(resolver.resolve("example.com")).resolves.toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
    expect(calls.sort()).toEqual(["example.com/A", "example.com/AAAA"]);
  });

  it("reuses a positive answer within its TTL and re-queries after it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    const { fetchImpl, calls } = stubFetch((_name, type) =>
      type === "A" ? dnsJson([{ type: 1, data: "93.184.216.34", TTL: 30 }]) : dnsJson([]),
    );
    const resolver = createDohResolver(fetchImpl);
    await resolver.resolve("example.com");
    await resolver.resolve("EXAMPLE.com");
    await createDohResolver(fetchImpl).resolve("example.com");
    expect(calls).toHaveLength(2);

    vi.setSystemTime(new Date("2026-09-20T12:00:31Z"));
    await expect(resolver.resolve("example.com")).resolves.toEqual(["93.184.216.34"]);
    expect(calls).toHaveLength(4);
  });

  it("caps the reuse window even when the record advertises a long TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    const { fetchImpl, calls } = stubFetch((_name, type) =>
      type === "A" ? dnsJson([{ type: 1, data: "93.184.216.34", TTL: 86_400 }]) : dnsJson([]),
    );
    const resolver = createDohResolver(fetchImpl);
    await resolver.resolve("example.com");
    vi.setSystemTime(new Date("2026-09-20T12:00:59Z"));
    await resolver.resolve("example.com");
    expect(calls).toHaveLength(2);
    vi.setSystemTime(new Date("2026-09-20T12:01:01Z"));
    await resolver.resolve("example.com");
    expect(calls).toHaveLength(4);
  });

  it("never caches failures, TTL-less answers or empty answers", async () => {
    let mode: "error" | "no-ttl" | "empty" = "error";
    const { fetchImpl, calls } = stubFetch((_name, type) => {
      if (mode === "error") return new Response("rate limited", { status: 429 });
      if (mode === "no-ttl") return type === "A" ? dnsJson([{ type: 1, data: "93.184.216.34" }]) : dnsJson([]);
      return dnsJson([], 3);
    });
    const resolver = createDohResolver(fetchImpl);
    await expect(resolver.resolve("example.com")).rejects.toThrow("DNS lookup failed with status 429");
    await expect(resolver.resolve("example.com")).rejects.toThrow("DNS lookup failed with status 429");
    expect(calls).toHaveLength(4);

    mode = "no-ttl";
    await expect(resolver.resolve("example.com")).resolves.toEqual(["93.184.216.34"]);
    await resolver.resolve("example.com");
    expect(calls).toHaveLength(8);

    mode = "empty";
    await expect(resolver.resolve("missing.example.com")).resolves.toEqual([]);
    await resolver.resolve("missing.example.com");
    expect(calls).toHaveLength(12);
  });

  it("still blocks a hostname whose cached answer is private", async () => {
    const { fetchImpl, calls } = stubFetch((_name, type) =>
      type === "A" ? dnsJson([{ type: 1, data: "10.0.0.5", TTL: 300 }]) : dnsJson([]),
    );
    const dns = createDohResolver(fetchImpl);
    const first = await checkUrl("https://internal.example.com/", { dns, dnsFailOpen: false });
    const second = await checkUrl("https://internal.example.com/", { dns, dnsFailOpen: false });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toContain("private/internal address");
    expect(calls).toHaveLength(2);
  });

  it("fails closed with the DoH error when configured to and the endpoint rejects the query", async () => {
    const { fetchImpl } = stubFetch(() => new Response("Too many subrequests.", { status: 429 }));
    const verdict = await checkUrl("https://example.com/", { dns: createDohResolver(fetchImpl), dnsFailOpen: false });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("DNS lookup failed: DNS lookup failed with status 429");
  });
});

describe("ip helpers", () => {
  it("classifies IPv4 ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1"]) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "8.8.8.8"]) {
      expect(isPrivateIpv4(ip), ip).toBe(false);
    }
  });

  it("classifies IPv6 ranges", () => {
    for (const ip of ["::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::"]) {
      expect(isPrivateIpv6(ip), ip).toBe(true);
    }
    expect(isPrivateIpv6("2606:4700::1111")).toBe(false);
  });

  it("dispatches on address family", () => {
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
  });
});
