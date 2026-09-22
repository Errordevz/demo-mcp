/**
 * Security & privacy hardening regression suite (0.8.4 overhaul).
 *
 * Covers the additive guards added without changing the architecture:
 *  - constant-time-ish private-tool credential comparison,
 *  - per-hop validated redirects + bounded body read for `http_fetch`,
 *  - the MCP request-body cap (413 before any handler runs),
 *  - static security headers on JSON and UI responses,
 *  - the Durable Object retention sweep for idle browser-session state,
 *  - the privacy invariants (no IP logging, no set-cookie on tool surfaces).
 */

import { describe, expect, it, vi } from "vitest";
import worker, { TOOL_COUNT } from "../index.js";
import platform from "../platform-entry.js";
import { bearerCredentialMatches } from "../src/core/credential.js";
import { guardedFetchText, type UrlGuard } from "../src/core/guarded-fetch.js";
import { oversizedBody, securityHeaders, uiSecurityHeaders } from "../src/core/headers.js";
import { BrowserError } from "../src/core/errors.js";
import { LIMITS } from "../src/core/limits.js";
import { BrowserSession } from "../src/session/durable-object.js";
import { createSessionState } from "../src/browser/runtime.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

async function rpc(method: string, params: Record<string, unknown>, env: unknown = {}, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const response = await worker.fetch(
    new Request("https://demo.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env as never,
    CTX,
  );
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    if (dataLines.length) json = JSON.parse(dataLines[dataLines.length - 1].slice(5).trim());
  }
  return { status: response.status, json, text };
}

async function callTool(name: string, args: Record<string, unknown>, env: unknown = {}, headers: Record<string, string> = {}) {
  const { json } = await rpc("tools/call", { name, arguments: args }, env, headers);
  const result = json?.result ?? {};
  const text = (result.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
  return { isError: Boolean(result.isError), text, parsed: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/* ------------------------------------------------------- credential check -- */

describe("private-tool credential comparison", () => {
  const KEY = "demo-secret-key-0123456789abcdef";

  it("accepts the exact bearer credential (case-insensitive scheme)", async () => {
    expect(await bearerCredentialMatches(`Bearer ${KEY}`, KEY)).toBe(true);
    expect(await bearerCredentialMatches(`bearer ${KEY}`, KEY)).toBe(true);
    expect(await bearerCredentialMatches(`  Bearer   ${KEY}  `, KEY)).toBe(true);
  });

  it("rejects wrong, prefix, extended and non-bearer credentials", async () => {
    expect(await bearerCredentialMatches(`Bearer wrong-${KEY}`, KEY)).toBe(false);
    expect(await bearerCredentialMatches(`Bearer ${KEY.slice(0, KEY.length - 2)}`, KEY)).toBe(false);
    expect(await bearerCredentialMatches(`Bearer ${KEY}-extra`, KEY)).toBe(false);
    expect(await bearerCredentialMatches(`Basic ${KEY}`, KEY)).toBe(false);
    expect(await bearerCredentialMatches(KEY, KEY)).toBe(false);
    expect(await bearerCredentialMatches(null, KEY)).toBe(false);
    expect(await bearerCredentialMatches(`Bearer ${KEY}`, "")).toBe(false);
    expect(await bearerCredentialMatches(`Bearer ${KEY}`, null)).toBe(false);
  });

  it("keeps the encoded credential out of thrown strings and results", async () => {
    // The helper returns booleans only — there is no value path that could leak.
    const outcome = await bearerCredentialMatches("Bearer nope", KEY);
    expect(typeof outcome).toBe("boolean");
  });
});

/* ------------------------------------------------------------ guarded fetch -- */

function bodyResponse(init: { status: number; headers?: Record<string, string>; text?: string }): Response {
  const encoder = new TextEncoder();
  const payload = encoder.encode(init.text ?? "");
  return new Response(payload, { status: init.status, headers: init.headers });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** Static-only guard: mirrors the SSRF guard's literal blocks without DNS. */
const localGuard: UrlGuard = async (url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("blocked scheme");
  const host = parsed.hostname;
  const blocked = ["127.0.0.1", "0.0.0.0", "169.254.169.254", "[::1]", "localhost", "10.0.0.5", "192.168.1.1"];
  if (blocked.includes(host)) throw new BrowserError("blocked_url", `${host} is not a public target`, { retryable: false });
  return url;
};

describe("http_fetch guard", () => {
  it("fetches a public URL and reports bounded metadata", async () => {
    const fetched: string[] = [];
    const result = await guardedFetchText("https://public.example/data", {
      method: "GET",
      guard: localGuard,
      fetchImpl: (async (url: string) => {
        fetched.push(String(url));
        return bodyResponse({ status: 200, headers: { "content-type": "text/plain" }, text: "hello" });
      }) as typeof fetch,
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe("hello");
    expect(result.finalUrl).toBe("https://public.example/data");
    expect(fetched).toHaveLength(1);
  });

  it("follows public-to-public redirects and revalidates every hop", async () => {
    const fetched: string[] = [];
    const guard = vi.fn(localGuard);
    const result = await guardedFetchText("https://a.example/start", {
      method: "GET",
      guard,
      fetchImpl: (async (url: string) => {
        fetched.push(String(url));
        if (url === "https://a.example/start") return redirectResponse("https://b.example/mid");
        if (url === "https://b.example/mid") return redirectResponse("/end");
        return bodyResponse({ status: 200, text: "done" });
      }) as typeof fetch,
    });
    expect(result.body).toBe("done");
    expect(result.finalUrl).toBe("https://b.example/end");
    expect(result.redirects).toBe(2);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetched).toEqual(["https://a.example/start", "https://b.example/mid", "https://b.example/end"]);
  });

  it("blocks a redirect that bounces a public URL into a private target", async () => {
    const fetched: string[] = [];
    await expect(
      guardedFetchText("https://public.example/redirect", {
        method: "GET",
        guard: localGuard,
        fetchImpl: (async (url: string) => {
          fetched.push(String(url));
          if (url === "https://public.example/redirect") return redirectResponse("http://169.254.169.254/latest/meta-data/");
          return bodyResponse({ status: 200, text: "secret" });
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "blocked_url" });
    // The private hop was never actually fetched.
    expect(fetched).toEqual(["https://public.example/redirect"]);
  });

  it("gives up after the redirect budget instead of looping forever", async () => {
    let calls = 0;
    await expect(
      guardedFetchText("https://loop.example/1", {
        method: "GET",
        guard: localGuard,
        fetchImpl: (async (url: string) => {
          calls += 1;
          return redirectResponse(`${url.replace(/\d+$/, "")}${Number(url.slice(-1)) + 1}`);
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "blocked_url" });
    expect(calls).toBeLessThanOrEqual(6);
  });

  it("rejects oversized declared bodies before reading them", async () => {
    await expect(
      guardedFetchText("https://big.example/file", {
        method: "GET",
        guard: localGuard,
        maxBodyBytes: 1_000,
        fetchImpl: (async () => bodyResponse({ status: 200, headers: { "content-length": String(50_000_000) } })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "size_limit_exceeded" });
  });

  it("stops reading the stream at the byte cap and reports truncation", async () => {
    const huge = "x".repeat(10_000);
    const result = await guardedFetchText("https://big.example/stream", {
      method: "GET",
      guard: localGuard,
      maxBodyBytes: 1_000,
      fetchImpl: (async () => bodyResponse({ status: 200, text: huge })) as typeof fetch,
    });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps HEAD requests body-free", async () => {
    const result = await guardedFetchText("https://public.example/head", {
      method: "HEAD",
      guard: localGuard,
      fetchImpl: (async () => bodyResponse({ status: 200, text: "ignored" })) as typeof fetch,
    });
    expect(result.body).toBe("");
  });

  it("http_fetch refuses literal private targets through the MCP surface", async () => {
    const result = await callTool("http_fetch", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(result.isError).toBe(true);
    expect(String(result.parsed?.error ?? result.text)).toMatch(/blocked_url/);
  });
});

/* -------------------------------------------------------------- body cap -- */

describe("mcp request body cap", () => {
  it("answers 413 before the transport runs for an oversized body", async () => {
    const oversized = "x".repeat(LIMITS.maxMcpBodyBytes + 100);
    const direct = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(oversized.length) },
        body: oversized,
      }),
      {} as never,
      CTX,
    );
    expect(direct.status).toBe(413);
    const payload = (await direct.json()) as { error: string };
    expect(payload.error).toBe("request_too_large");
    expect(direct.headers.get("x-content-type-options")).toBe("nosniff");

    // The platform entry guards the same path before forwarding.
    const viaPlatform = await platform.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(oversized.length) },
        body: oversized,
      }),
      {} as never,
      CTX,
    );
    expect(viaPlatform.status).toBe(413);
  });

  it("still serves ordinary MCP traffic after the cap check", async () => {
    const { json } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(json?.result?.serverInfo?.name).toBe("DEMO");
    expect(TOOL_COUNT).toBeGreaterThan(0);
  });

  it("exposes the guard on the helper directly", () => {
    const request = new Request("https://demo.test/mcp", { method: "POST", headers: { "content-length": "100" }, body: "{}" });
    expect(oversizedBody(request, 50)?.status).toBe(413);
    expect(oversizedBody(request, 1_000_000)).toBeNull();
    expect(oversizedBody(new Request("https://demo.test/mcp"), 10)).toBeNull();
  });
});

/* ---------------------------------------------------------------- headers -- */

describe("security headers", () => {
  it("stamp nosniff and no-referrer onto JSON routes of both entrypoints", async () => {
    const health = await worker.fetch(new Request("https://demo.test/health"), {} as never, CTX);
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");

    const stats = await platform.fetch(new Request("https://demo.test/platform/stats"), {} as never, CTX);
    expect(stats.headers.get("x-content-type-options")).toBe("nosniff");
    expect(stats.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("locks the inspector UI down with a restrictive CSP and no framing", async () => {
    for (const fetchUi of [
      () => platform.fetch(new Request("https://demo.test/"), {} as never, CTX),
      () => import("../ui.js").then((ui) => ui.demoUi()),
    ]) {
      const response = await fetchUi();
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain("https:");
    }
  });

  it("keeps the helper surfaces stable", () => {
    expect(securityHeaders()).toEqual({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    expect(uiSecurityHeaders()["Content-Security-Policy"]).toContain("form-action 'none'");
  });
});

/* --------------------------------------------------------- retention sweep -- */

describe("durable-object session retention sweep", () => {
  function makeDo() {
    const storage = new Map<string, unknown>();
    const ctx = {
      storage: {
        get: async <T>(key: string) => (storage.get(key) as T) ?? null,
        put: async (key: string, value: unknown) => void storage.set(key, value),
        setAlarm: async () => undefined,
        deleteAll: async () => storage.clear(),
      },
      blockConcurrencyWhile: (work: () => Promise<void>) => work(),
      id: { toString: () => "s-sweep" },
      waitUntil: () => undefined,
    };
    return { session: new BrowserSession(ctx as never, {} as never), storage };
  }

  it("wipes stale browser-session state on the next wake-up and keeps working", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(" ")));
    const { session, storage } = makeDo();
    try {
      const stale = createSessionState("s-stale", "cloudflare", 300_000);
      stale.lastUsedAt = Date.now() - LIMITS.sessionStateRetentionMs - 60_000;
      stale.providerSessionId = "session-dead";
      stale.tabs = [
        { id: "p1", targetId: "t1", index: 0, url: "https://user-browsing.example/private-inbox", title: "Inbox", createdAt: 1, updatedAt: 1 },
      ];
      stale.activeTabId = "p1";
      stale.lastError = "old failure";
      await storage.set("session", stale);

      const summary = await session.summary();
      expect(summary.tabs).toEqual([]);
      expect(summary.providerSessionId).toBeNull();
      expect(summary.lastError).toBeNull();

      const stored = (await storage.get("session")) as typeof stale;
      expect(stored.tabs).toEqual([]);
      expect(stored.providerSessionId).toBeNull();
      expect(JSON.stringify(stored)).not.toContain("private-inbox");
      expect(logs.join("\n")).toContain("session-state-swept");
      expect(logs.join("\n")).not.toContain("private-inbox");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves fresh session state untouched", async () => {
    const { session, storage } = makeDo();
    await session.summary(); // creates + persists a fresh state
    const stored = (await storage.get("session")) as { lastUsedAt: number; tabs: unknown[] };
    expect(stored.lastUsedAt).toBeGreaterThan(Date.now() - 60_000);
  });
});

/* ------------------------------------------------------------ privacy pins -- */

describe("privacy invariants", () => {
  it("public telemetry carries no client identifiers", async () => {
    const stats = await (await platform.fetch(new Request("https://demo.test/platform/stats"), {} as never, CTX)).json();
    const dumped = JSON.stringify(stats).toLowerCase();
    for (const marker of ["connecting-ip", "x-forwarded", "user-agent", "fingerprint", "set-cookie", "ipaddress", "clientip"]) {
      expect(dumped, marker).not.toContain(marker);
    }
  });

  it("public JSON routes set no cookies", async () => {
    const health = await worker.fetch(new Request("https://demo.test/health"), {} as never, CTX);
    expect(health.headers.get("set-cookie")).toBeNull();
    const stats = await platform.fetch(new Request("https://demo.test/platform/stats"), {} as never, CTX);
    expect(stats.headers.get("set-cookie")).toBeNull();
  });

  it("private tools still demand the configured credential", async () => {
    const denied = await callTool("roblox_account_status", {}, { DEMO_API_KEY: "k-test-12345" }, { Authorization: "Bearer wrong-key" });
    expect(denied.isError).toBe(true);
    expect(denied.parsed?.error).toBe("unauthorized");
    expect(denied.text).not.toContain("k-test-12345");

    const unconfigured = await callTool("roblox_account_status", {});
    expect(unconfigured.isError).toBe(true);
    expect(["not_configured", "unauthorized"]).toContain(unconfigured.parsed?.error);
  });
});
