import { describe, expect, it } from "vitest";
import { checkUrl, checkUrlSync, isPrivateIp, isPrivateIpv4, isPrivateIpv6 } from "../src/core/url-guard.js";

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
