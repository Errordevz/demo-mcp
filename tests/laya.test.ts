/**
 * Laya decision-provider tests.
 *
 * Laya is the second typed-decision provider, next to the existing TypeSafe/Jev
 * integration: an external, configurable server speaking the same Jev-compatible
 * `POST /v1/systemone` contract. Everything here runs against in-process mock
 * servers (`stubLaya` / `stubProviders`), so no real Laya deployment and no real
 * credential is involved. The assertions cover the wire contract, every failure
 * mode, the routing chain (auto / laya / jev), the SSRF guard on LAYA_BASE_URL,
 * and the rule that the Laya credential can never escape — not through results,
 * not through logs, and not through any status surface.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askLaya, probeLaya, sanitizeUntrustedProviderText } from "../src/laya/client.js";
import { resolveLayaConfig, layaFlags, LAYA_DEFAULT_MODEL, LAYA_LIMITS } from "../src/laya/config.js";
import { describeLayaCapabilities, LAYA_CAPABILITIES_URI } from "../src/laya/capabilities.js";
import { layaProvider, jevProvider, resolveDecisionRoutingMode, DECISION_ROUTING_MODES } from "../src/decisions/provider.js";
import { askRoutedDecision, anyProviderAvailable, providerChainFor, describeRoutedMiss } from "../src/decisions/router.js";
import { decideResultReview, decideToolRoute, resolveVideoIntentWithJev, VIDEO_FOCUS_CRITERIA } from "../src/jev/decisions.js";
import { detectVideoIntent } from "../src/video/intent.js";
import { createLayaCommand } from "../src/commands/laya-command.js";
import { createMcpCommand } from "../src/commands/mcp-command.js";
import { registerCommand, routeCommand } from "../src/commands/router.js";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import platform from "../platform-entry.js";

const CTX = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext;
const LAYA_KEY = "laya_secret_test_key_00112233445566778899aabbccddeeff";
const JEV_KEY = "tsk_live_9f2b7c1d8e4a5566f0ab34cd78ef0123";
const LAYA_BASE = "https://laya.example.test";
const LAYA_ENDPOINT = `${LAYA_BASE}/v1/systemone`;
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Test env: Laya configured, DNS stubbed out (fetch is stubbed; DoH would hit the stub). */
const env = (overrides: Record<string, unknown> = {}) => ({ LAYA_BASE_URL: LAYA_BASE, LAYA_API_KEY: LAYA_KEY, SSRF_DNS_CHECK: "false", ...overrides }) as Record<string, unknown>;
const config = (overrides: Record<string, unknown> = {}) => resolveLayaConfig(env(overrides));

function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence: number) {
  return { type: "choice", choice, probabilities, confidence };
}

function distribution(options: string[], winner: string, weight = 0.8): Record<string, number> {
  const rest = (1 - weight) / Math.max(1, options.length - 1);
  return Object.fromEntries(options.map((option) => [option, option === winner ? weight : Number(rest.toFixed(4))]));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

interface ProviderCall {
  url: string;
  method: string;
  body: any;
  authorization: string | null;
  hasSignal: boolean;
}

/**
 * Mock Laya server (in process). `respond` is a function of the parsed request body,
 * so a test can assert what DEMO sent *and* decide the answer from it.
 */
function stubLaya(respond: (body: any) => Response | Promise<Response>): { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: String(init?.method ?? "GET"), body, authorization: headers.get("authorization"), hasSignal: Boolean(init?.signal) });
    return await respond(body);
  }));
  return { calls };
}

/** Mock both decision providers at once and route by URL, for fallback-chain tests. */
function stubProviders(handlers: {
  laya?: (body: any) => Response | Promise<Response>;
  jev?: (body: any) => Response | Promise<Response>;
}): { layaCalls: ProviderCall[]; jevCalls: ProviderCall[] } {
  const layaCalls: ProviderCall[] = [];
  const jevCalls: ProviderCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call: ProviderCall = { url, method: String(init?.method ?? "GET"), body, authorization: headers.get("authorization"), hasSignal: Boolean(init?.signal) };
    if (url.startsWith(LAYA_BASE)) {
      layaCalls.push(call);
      if (handlers.laya) return await handlers.laya(body);
      return jsonResponse({ detail: "no laya stub" }, 500);
    }
    if (url.startsWith("https://api.typesafe.ai")) {
      jevCalls.push(call);
      if (handlers.jev) return await handlers.jev(body);
      return jsonResponse({ detail: "no jev stub" }, 500);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }));
  return { layaCalls, jevCalls };
}

afterEach(() => vi.unstubAllGlobals());

/* ------------------------------------------------------------ configuration */

describe("laya configuration", () => {
  it("is off until LAYA_BASE_URL exists, and reports presence only — never the credential", () => {
    const off = resolveLayaConfig({});
    expect(off.available).toBe(false);
    expect(off.configured).toBe(false);
    expect(off.credentialConfigured).toBe(false);
    expect(off.disabledReason).toContain("LAYA_BASE_URL");

    const on = config();
    expect(on.available).toBe(true);
    expect(on.endpoint).toBe(LAYA_ENDPOINT);
    expect(on.endpointHost).toBe("laya.example.test");
    expect(JSON.stringify(on)).not.toContain(LAYA_KEY);
    expect(JSON.stringify(layaFlags(env()))).not.toContain(LAYA_KEY);
    expect(layaFlags(env())).toMatchObject({ layaDecisionEngine: true, layaConfigured: true, layaApiKeyConfigured: true, layaModel: LAYA_DEFAULT_MODEL });
  });

  it("honours LAYA_ENABLED=false without treating it as an error", () => {
    for (const value of ["false", "off", "0", "no"]) {
      const disabled = resolveLayaConfig(env({ LAYA_ENABLED: value }));
      expect(disabled.enabled).toBe(false);
      expect(disabled.available).toBe(false);
      expect(disabled.disabledReason).toMatch(/LAYA_ENABLED is false/);
    }
    expect(resolveLayaConfig(env({ LAYA_ENABLED: "true" })).enabled).toBe(true);
  });

  it("normalises the base URL (trailing slashes, path prefix) and clamps the timeout", () => {
    expect(resolveLayaConfig(env({ LAYA_BASE_URL: `${LAYA_BASE}/` })).endpoint).toBe(LAYA_ENDPOINT);
    const prefixed = resolveLayaConfig(env({ LAYA_BASE_URL: `${LAYA_BASE}/laya/v2/` }));
    expect(prefixed.endpoint).toBe(`${LAYA_BASE}/laya/v2/v1/systemone`);
    expect(prefixed.endpointHost).toBe("laya.example.test");
    expect(resolveLayaConfig(env({ LAYA_TIMEOUT_MS: "999999" })).timeoutMs).toBe(LAYA_LIMITS.maxTimeoutMs);
    expect(resolveLayaConfig(env({ LAYA_TIMEOUT_MS: "junk" })).timeoutMs).toBe(LAYA_LIMITS.defaultTimeoutMs);
    expect(resolveLayaConfig(env({ LAYA_MODEL: "laya-2.1.0" })).model).toBe("laya-2.1.0");
  });

  it("rejects unusable endpoints at resolution time, without leaking what was embedded", () => {
    const http = resolveLayaConfig(env({ LAYA_BASE_URL: "http://laya.example.test" }));
    expect(http.available).toBe(false);
    expect(http.disabledReason).toMatch(/https/);

    const withCreds = resolveLayaConfig(env({ LAYA_BASE_URL: "https://user:p4ssw0rd-shape@laya.example.test" }));
    expect(withCreds.available).toBe(false);
    expect(withCreds.disabledReason).toMatch(/credentials/);
    expect(withCreds.disabledReason).not.toContain("p4ssw0rd-shape");

    const withQuery = resolveLayaConfig(env({ LAYA_BASE_URL: `${LAYA_BASE}/?cb=1` }));
    expect(withQuery.available).toBe(false);
    const invalid = resolveLayaConfig(env({ LAYA_BASE_URL: "not a url" }));
    expect(invalid.available).toBe(false);
  });

  it("resolves the routing mode: auto default, explicit values, garbage falls back to auto", () => {
    expect(resolveDecisionRoutingMode({})).toBe("auto");
    expect(resolveDecisionRoutingMode({ DECISION_PROVIDER_MODE: "laya" })).toBe("laya");
    expect(resolveDecisionRoutingMode({ DECISION_PROVIDER_MODE: "JEV" })).toBe("jev");
    expect(resolveDecisionRoutingMode({ DECISION_PROVIDER_MODE: "chaos" })).toBe("auto");
    expect(resolveDecisionRoutingMode({ DECISION_PROVIDER_MODE: "jev" }, "laya")).toBe("laya");
    expect(DECISION_ROUTING_MODES).toEqual(["auto", "laya", "jev"]);
    expect(providerChainFor("auto").map((p) => p.name)).toEqual(["laya", "jev"]);
    expect(providerChainFor("jev").map((p) => p.name)).toEqual(["jev"]);
    expect(providerChainFor("laya").map((p) => p.name)).toEqual(["laya"]);
  });
});

/* ------------------------------------------------------------- the client */

describe("askLaya", () => {
  it("sends exactly the documented request: configured host + /v1/systemone, bearer header, state/model/questions", async () => {
    const stub = stubLaya(() => jsonResponse({ model: "laya-1.2.3", answers: { dept: choiceAnswer("technical", { billing: 0.1, technical: 0.85, sales: 0.05 }, 0.86) }, usage: { input_tokens: 210, output_tokens: 12 } }));
    const result = await askLaya({
      config: config(),
      apiKey: LAYA_KEY,
      env: env(),
      state: { user_message: "the billing page crashes when I click pay" },
      questions: { dept: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs", sales: "Pricing" } } },
    });

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call.url).toBe(LAYA_ENDPOINT);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe(`Bearer ${LAYA_KEY}`);
    expect(call.body.model).toBe(LAYA_DEFAULT_MODEL);
    expect(call.body.state).toContain("billing page");
    expect(call.hasSignal).toBe(true); // a bounded request, always
    expect(result.provider).toBe("laya");
    expect(result.answers.dept).toMatchObject({ type: "choice", choice: "technical", confidence: 0.86 });
    expect(result.model).toBe("laya-1.2.3");
    expect(result.usage).toEqual({ inputTokens: 210, outputTokens: 12 });
    expect(result.attempts).toBe(1);
    expect(result.stateTruncated).toBe(false);
  });

  it("handles a score answer with legend and probabilities", async () => {
    stubLaya(() => jsonResponse({
      model: "laya-1.2.3",
      answers: { review: { type: "score", score: 1.4, legend: { "0": "fine", "1": "look", "2": "hold" }, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 }, confidence: 0.81 } },
      usage: { input_tokens: 40, output_tokens: 9 },
    }));
    const result = await askLaya({
      config: config(),
      apiKey: LAYA_KEY,
      env: env(),
      state: "result text",
      questions: { review: { type: "score", instructions: "How much review?", criteria: ["fine", "look", "hold"] } },
    });
    expect(result.answers.review).toMatchObject({ type: "score", score: 1.4, confidence: 0.81, legend: { "1": "look" } });
  });

  it("handles a noul answer (the probability IS the answer)", async () => {
    stubLaya(() => jsonResponse({ answers: { urgent: { type: "noul", noul: 0.93 } }, usage: {} }));
    const result = await askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { urgent: { type: "noul", instructions: "Urgent?" } } });
    expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.93 });
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null }); // usage preserved as nulls, not fabricated
  });

  it("supports an unauthenticated Laya server: no key configured, no Authorization header sent", async () => {
    const stub = stubLaya(() => jsonResponse({ answers: { a: { type: "noul", noul: 0.5 } }, usage: {} }));
    const result = await askLaya({ config: config(), apiKey: "", env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } });
    expect(stub.calls[0].authorization).toBeNull();
    expect(result.answers.a).toEqual({ type: "noul", noul: 0.5 });
  });

  it("treats a malformed (non-JSON) response as a provider failure", async () => {
    stubLaya(() => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("treats an invalid answer schema as a provider failure, never as a decision", async () => {
    const cases: Array<[Record<string, unknown>, unknown, RegExp]> = [
      [{ type: "noul", instructions: "q?" }, { type: "noul", noul: 1.7 }, /out-of-range noul/],
      [{ type: "choice", instructions: "q?", criteria: { x: "ex", y: "why" } }, { type: "choice", choice: "not_an_option", probabilities: {}, confidence: 0.9 }, /does not allow/],
      [{ type: "choice", instructions: "q?", criteria: { x: "ex", y: "why" } }, { type: "choice", choice: "x", probabilities: { x: 2 }, confidence: 0.9 }, /invalid probability|does not allow/],
      [{ type: "score", instructions: "q?", criteria: ["low", "high"] }, { type: "score", score: "high", legend: {}, probabilities: {}, confidence: 0.9 }, /non-numeric score/],
      [{ type: "choice", instructions: "q?", criteria: { x: "ex", y: "why" } }, { type: "choice", choice: "x", probabilities: { x: 1 } }, /no usable confidence/],
    ];
    for (const [question, answer, pattern] of cases) {
      stubLaya(() => jsonResponse({ answers: { q: answer }, usage: {} }));
      await expect(
        askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { q: question as never } }),
      ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringMatching(pattern) });
      vi.unstubAllGlobals();
    }
  });

  it("maps HTTP 4xx codes to stable failures without a retry", async () => {
    for (const [status, code] of [[401, "capability_unavailable"], [403, "capability_unavailable"], [422, "validation_failed"]] as const) {
      const stub = stubLaya(() => jsonResponse({ detail: "provider side text" }, status));
      await expect(askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({ code });
      expect(stub.calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("retries 5xx/429 exactly once, then reports provider unavailable / rate limited", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      return jsonResponse({ detail: "overloaded" }, 500);
    }));
    await expect(askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(attempts).toBe(2);

    attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      return jsonResponse({ detail: "slow down" }, 429, { "retry-after": "0" });
    }));
    await expect(askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({ code: "rate_limited" });
    expect(attempts).toBe(2);
  });

  it("recovers within the retry budget when the second attempt answers", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ detail: "busy" }, 503);
      return jsonResponse({ answers: { a: { type: "noul", noul: 0.6 } }, usage: {} });
    }));
    const result = await askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } });
    expect(result.attempts).toBe(2);
    expect(result.answers.a).toEqual({ type: "noul", noul: 0.6 });
  });

  it("turns an aborted request into a timeout, naming LAYA_TIMEOUT_MS in the hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }));
    await expect(askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      hint: expect.stringMatching(/LAYA_TIMEOUT_MS/),
    });
  });

  it("turns a connection failure into PROVIDER_UNAVAILABLE without leaking internals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "Could not reach laya.example.test.",
      retryable: true,
    });
  });

  it("stays off the network entirely when disabled or unconfigured", async () => {
    const stub = stubLaya(() => jsonResponse({ answers: {} }));
    await expect(askLaya({ config: config({ LAYA_ENABLED: "false" }), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({
      code: "capability_unavailable",
      capability: "laya_decisions",
    });
    await expect(askLaya({ config: resolveLayaConfig({}), apiKey: "", env: {}, state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({
      code: "capability_unavailable",
      hint: expect.stringMatching(/LAYA_BASE_URL/),
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("reports an invalid API key honestly (401) and never echoes the key", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stub = stubLaya(() => jsonResponse({ detail: `the key ${LAYA_KEY} is wrong` }, 401)); // hostile: server echoes the key
    let error: any;
    try {
      await askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "capability_unavailable", capability: "laya_decisions" });
    expect(error.message).toBe("Laya rejected this Worker's API key.");
    expect(stub.calls[0].authorization).toBe(`Bearer ${LAYA_KEY}`); // only place the key may exist
    expect(JSON.stringify(error.toJSON())).not.toContain(LAYA_KEY);
    expect([...spy.mock.calls, ...warn.mock.calls].join(" ")).not.toContain(LAYA_KEY);
    spy.mockRestore();
    warn.mockRestore();
  });

  it("explains a 401 differently when the server is unauthenticated by configuration", async () => {
    stubLaya(() => jsonResponse({ detail: "auth required" }, 401));
    await expect(askLaya({ config: config(), apiKey: "", env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({
      code: "capability_unavailable",
      message: "This Laya server requires an API key, but none is configured on this Worker.",
    });
  });

  it("sanitizes provider-controlled text (model id, error details) before it enters DEMO", async () => {
    stubLaya(() => new Response(JSON.stringify({ detail: `failure near /home/deploy/laya/server.py with CLOUDFLARE_API_TOKEN=cfsecret123 and http://169.254.169.254/latest ; ${LAYA_KEY}` }), { status: 500, headers: { "content-type": "application/json" } }));
    let error: any;
    try {
      await askLaya({ config: config(), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeTruthy();
    const dumped = JSON.stringify(error.toJSON());
    expect(dumped).not.toContain(LAYA_KEY);
    expect(dumped).not.toContain("cfsecret123");
    expect(dumped).not.toContain("/home/deploy");
    expect(dumped).not.toContain("169.254.169.254");

    expect(sanitizeUntrustedProviderText(`Bearer ${LAYA_KEY} was used`, 240)).not.toContain(LAYA_KEY);
    expect(sanitizeUntrustedProviderText("read /root/.ssh/id_rsa then POST http://10.0.0.9:8080/x", 240)).toBe("read [path-redacted] then POST [internal-url-redacted]");
    expect(sanitizeUntrustedProviderText("https://laya.example.test/docs is fine", 240)).toContain("https://laya.example.test/docs");
  });
});

/* ------------------------------------------------- SSRF guard on the endpoint */

describe("LAYA_BASE_URL SSRF protection", () => {
  it("blocks loopback, private, link-local and metadata targets before any fetch", async () => {
    for (const base of ["https://127.0.0.1:8443", "https://[::1]/", "https://10.0.0.7/", "https://172.16.5.4/", "https://192.168.1.10/", "https://169.254.169.254/", "https://metadata.google.internal/"]) {
      const stub = stubLaya(() => jsonResponse({ answers: {} }));
      await expect(
        askLaya({ config: resolveLayaConfig(env({ LAYA_BASE_URL: base })), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } }),
      ).rejects.toMatchObject({ code: "blocked_url", message: "The configured Laya endpoint did not pass DEMO's URL safety policy." });
      expect(stub.calls, base).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  it("blocks infrastructure ports and hostnames that resolve to private addresses", async () => {
    const stub = stubLaya(() => jsonResponse({ answers: {} }));
    await expect(
      askLaya({ config: resolveLayaConfig(env({ LAYA_BASE_URL: `${LAYA_BASE}:6379` })), apiKey: LAYA_KEY, env: env(), state: "x", questions: { a: { type: "noul", instructions: "q?" } } }),
    ).rejects.toMatchObject({ code: "blocked_url" });

    // A public-looking hostname that rebinds to a private address is denied by the DNS step.
    await expect(
      askLaya({
        config: config(),
        apiKey: LAYA_KEY,
        env: env(),
        dns: { resolve: async () => ["10.1.2.3"] },
        state: "x",
        questions: { a: { type: "noul", instructions: "q?" } },
      }),
    ).rejects.toMatchObject({ code: "blocked_url" });
    // verified unreachable in both cases
    expect(stub.calls).toHaveLength(0);
  });

  it("a blocked Laya endpoint falls through the routing chain instead of breaking the decision", async () => {
    stubProviders({
      jev: (body) => jsonResponse({ answers: { primary: choiceAnswer("utility", distribution(Object.keys(body.questions.primary.criteria), "utility", 0.9), 0.9) }, usage: {} }),
    });
    const outcome = await decideToolRoute({ env: env({ LAYA_BASE_URL: "https://127.0.0.1:8443", TYPESAFE_API_KEY: JEV_KEY }) }, "what happened to the thing I asked you about earlier?");
    expect(outcome.source).toBe("jev");
    expect(outcome.decision).toBe("utility");
    expect(outcome.note).toMatch(/Laya failed/);
  });
});

/* ----------------------------------------------------------- routing chain */

describe("decision routing modes", () => {
  const ambiguous = "what do you make of the thing from earlier?";
  const layaRoute = (body: any, route = "browser_action") => jsonResponse({
    model: "laya-1.2.3",
    answers: { primary: choiceAnswer(route, distribution(Object.keys(body.questions.primary.criteria), route, 0.88), 0.88) },
    usage: { input_tokens: 30, output_tokens: 4 },
  });
  const jevRoute = (body: any, route = "utility") => jsonResponse({
    model: "jev-1.13.0",
    answers: { primary: choiceAnswer(route, distribution(Object.keys(body.questions.primary.criteria), route, 0.91), 0.91) },
    usage: { input_tokens: 31, output_tokens: 5 },
  });

  it("auto: prefers Laya when both providers are configured", async () => {
    const stubs = stubProviders({ laya: layaRoute, jev: jevRoute });
    const outcome = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }) }, ambiguous);
    expect(outcome).toMatchObject({ source: "laya", decision: "browser_action", policy: "applied", model: "laya-1.2.3" });
    expect(outcome.usage).toEqual({ input: 30, output: 4 });
    expect(stubs.layaCalls).toHaveLength(1);
    expect(stubs.jevCalls).toHaveLength(0);
  });

  it("auto: unchanged DEMO behaviour when only Jev is configured", async () => {
    const stubs = stubProviders({ laya: layaRoute, jev: jevRoute });
    const outcome = await decideToolRoute({ env: { TYPESAFE_API_KEY: JEV_KEY } }, ambiguous);
    expect(outcome).toMatchObject({ source: "jev", decision: "utility" });
    expect(stubs.layaCalls).toHaveLength(0);
    expect(stubs.jevCalls).toHaveLength(1);
  });

  it("auto: works when only Laya is configured", async () => {
    const stubs = stubProviders({ laya: layaRoute, jev: jevRoute });
    const outcome = await decideToolRoute({ env: env() }, ambiguous);
    expect(outcome).toMatchObject({ source: "laya", decision: "browser_action" });
    expect(stubs.jevCalls).toHaveLength(0);
  });

  it("auto: Laya failure fails over to Jev, and the outcome says so", async () => {
    const stubs = stubProviders({
      laya: () => jsonResponse({ detail: "overloaded" }, 500),
      jev: jevRoute,
    });
    const outcome = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }) }, ambiguous);
    expect(outcome).toMatchObject({ source: "jev", decision: "utility", policy: "applied" });
    expect(outcome.note).toMatch(/Laya failed/);
    expect(outcome.note).toMatch(/answered instead/);
    expect(stubs.layaCalls).toHaveLength(2); // one bounded retry inside the Laya provider
    expect(stubs.jevCalls).toHaveLength(1);
  });

  it("auto: an invalid Laya schema is a provider failure and falls through to Jev", async () => {
    const stubs = stubProviders({
      laya: (body) => jsonResponse({ answers: { primary: choiceAnswer("delete_everything", distribution(Object.keys(body.questions.primary.criteria), "utility", 0.9), 0.99) }, usage: {} }),
      jev: jevRoute,
    });
    const outcome = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }) }, ambiguous);
    expect(outcome).toMatchObject({ source: "jev", decision: "utility" });
    expect(outcome.note).toMatch(/validation_failed/);
    expect(outcome.decision).not.toBe("delete_everything");
    expect(stubs.jevCalls).toHaveLength(1);
  });

  it("auto: when Laya and Jev both fail, the deterministic fallback reports both failures — nothing is fabricated", async () => {
    const stubs = stubProviders({
      laya: () => jsonResponse({ detail: "laya down" }, 500),
      jev: () => jsonResponse({ detail: "jev down" }, 503),
    });
    const outcome = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }) }, ambiguous);
    expect(outcome).toMatchObject({ source: "rules", decision: "needs_user_clarification", policy: "unavailable_fallback", certainty: null });
    expect(outcome.note).toMatch(/Laya/);
    expect(outcome.note).toMatch(/TypeSafe/);
    expect(outcome.note).toMatch(/deterministic/);
    expect(outcome.probabilities).toBeNull();
    expect(stubs.layaCalls.length).toBeGreaterThan(0);
    expect(stubs.jevCalls.length).toBeGreaterThan(0);
  });

  it("explicit laya mode: only Laya is asked, and an unavailable Laya is an honest report, not a silent detour", async () => {
    const stubs = stubProviders({ laya: layaRoute, jev: jevRoute });
    const viaEnv = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY, DECISION_PROVIDER_MODE: "laya" }) }, ambiguous);
    expect(viaEnv).toMatchObject({ source: "laya", decision: "browser_action" });
    const viaOverride = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }), mode: "laya" }, ambiguous);
    expect(viaOverride.source).toBe("laya");
    expect(stubs.jevCalls).toHaveLength(0);

    vi.unstubAllGlobals();
    const again = stubProviders({ jev: jevRoute });
    // Laya not configured at all: explicit mode must say so, and must NOT pretend.
    const missing = await decideToolRoute({ env: { TYPESAFE_API_KEY: JEV_KEY, DECISION_PROVIDER_MODE: "laya" } }, ambiguous);
    expect(missing).toMatchObject({ source: "rules", policy: "unavailable_fallback" });
    expect(missing.note).toMatch(/Laya was explicitly selected/);
    expect(missing.note).toMatch(/LAYA_BASE_URL/);
    expect(again.jevCalls).toHaveLength(0); // explicit laya means Jev is not consulted
  });

  it("explicit laya mode: a failed Laya stays a Laya failure (no hidden Jev hop)", async () => {
    const stubs = stubProviders({ laya: () => jsonResponse({ detail: "down" }, 500), jev: jevRoute });
    const outcome = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }), mode: "laya" }, ambiguous);
    expect(outcome).toMatchObject({ source: "rules", policy: "unavailable_fallback" });
    expect(outcome.note).toMatch(/Laya was explicitly selected and failed/);
    expect(stubs.jevCalls).toHaveLength(0);
  });

  it("explicit jev mode: only the existing Jev implementation is asked", async () => {
    const stubs = stubProviders({ laya: layaRoute, jev: jevRoute });
    const viaEnv = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY, DECISION_PROVIDER_MODE: "jev" }) }, ambiguous);
    const viaOverride = await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }), mode: "jev" }, ambiguous);
    expect(viaEnv).toMatchObject({ source: "jev", decision: "utility" });
    expect(viaOverride.source).toBe("jev");
    expect(stubs.layaCalls).toHaveLength(0);
    expect(stubs.jevCalls).toHaveLength(2);
  });

  it("never loops: a decision asks each available provider at most once (plus its own bounded retry)", async () => {
    const stubs = stubProviders({
      laya: () => jsonResponse({ detail: "down" }, 500),
      jev: () => jsonResponse({ detail: "down" }, 500),
    });
    await decideToolRoute({ env: env({ TYPESAFE_API_KEY: JEV_KEY }) }, ambiguous);
    expect(stubs.layaCalls).toHaveLength(2); // 1 decision + its single contract retry
    expect(stubs.jevCalls).toHaveLength(2);
  });

  it("our own invalid questions are not retried against the next provider", async () => {
    const stubs = stubProviders({ laya: layaRoute, jev: jevRoute });
    await expect(askRoutedDecision(env({ TYPESAFE_API_KEY: JEV_KEY }), "auto", { state: "x", questions: { "Bad Id": { type: "noul", instructions: "q?" } } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(stubs.layaCalls).toHaveLength(0); // request building failed before any fetch
    expect(stubs.jevCalls).toHaveLength(0);
  });

  it("anyProviderAvailable and the provider statuses reflect configuration honestly", () => {
    expect(anyProviderAvailable({}, "auto")).toBe(false);
    expect(anyProviderAvailable(env(), "auto")).toBe(true);
    expect(anyProviderAvailable(env(), "jev")).toBe(false); // no TYPESAFE key
    expect(anyProviderAvailable(env({ TYPESAFE_API_KEY: JEV_KEY }), "jev")).toBe(true);
    const statuses = [layaProvider.status(env()), jevProvider.status({ TYPESAFE_API_KEY: JEV_KEY })];
    expect(JSON.stringify(statuses)).not.toContain(LAYA_KEY);
    expect(JSON.stringify(statuses)).not.toContain(JEV_KEY);
    const miss = describeRoutedMiss({ kind: "unavailable", mode: "auto", skipped: [] });
    expect(miss).toMatch(/No typed-decision provider/);
  });

  it("routes the result_review template through Laya too", async () => {
    const stubs = stubProviders({
      laya: () => jsonResponse({
        answers: { review: { type: "score", score: 2.6, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: { "0": 0.05, "1": 0.05, "2": 0.9 }, confidence: 0.95 } },
        usage: {},
      }),
    });
    const outcome = await decideResultReview({ env: env() }, { result: "published" });
    expect(outcome).toMatchObject({ source: "laya", decision: "hold_for_review", requiresReview: true, level: 2 });
    expect(stubs.layaCalls).toHaveLength(1);
  });

  it("the video-intent hook accepts a Laya answer exactly like a Jev one, with the same guards", async () => {
    stubLaya((body) => {
      expect(Object.keys(body.questions.primary.criteria)).toEqual(Object.keys(VIDEO_FOCUS_CRITERIA));
      return jsonResponse({
        answers: {
          primary: choiceAnswer("text_ocr", Object.fromEntries(Object.keys(body.questions.primary.criteria).map((key) => [key, key === "text_ocr" ? 0.94 : 0.006])), 0.94),
          wants_reaction: { type: "noul", noul: 0.1 },
        },
        usage: {},
      });
    });
    const deterministic = detectVideoIntent({ userIntent: "hmm not sure what to make of this one" });
    expect(deterministic.focus).toBe("general");
    const resolved = await resolveVideoIntentWithJev({ env: env() }, { userIntent: "hmm not sure what to make of this one" }, deterministic);
    expect(resolved.intent.focus).toBe("text_ocr");
    expect(resolved.decision).toMatchObject({ source: "laya", policy: "applied" });
  });
});

/* ------------------------------------------------------------ /laya command */

describe("/laya command", () => {
  it("reports safe status fields only, even with a credential configured", async () => {
    const cmd = createLayaCommand();
    const result = await cmd.execute("", env());
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.command).toBe("/laya");
    expect(parsed.laya).toMatchObject({
      enabled: true,
      configured: true,
      available: true,
      credential_configured: true,
      routing_mode: "auto",
      endpoint_hostname: "laya.example.test",
      timeout_ms: LAYA_LIMITS.defaultTimeoutMs,
      model: LAYA_DEFAULT_MODEL,
    });
    expect(text).not.toContain(LAYA_KEY);
    expect(text).not.toContain("LAYA_API_KEY");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain(`${LAYA_BASE}/v1/systemone`); // the full URL is not part of the status surface
  });

  it("is honest when Laya is not configured, with setup guidance and no network traffic", async () => {
    const stub = stubLaya(() => jsonResponse({ answers: {} }));
    const cmd = createLayaCommand();
    const result = await cmd.execute("", {});
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.laya.available).toBe(false);
    expect(parsed.laya.configured).toBe(false);
    expect(parsed.setup_hint).toMatch(/LAYA_BASE_URL/);
    expect(parsed.safety).toMatch(/cannot authorize tools/i);
    expect(stub.calls).toHaveLength(0);
  });

  it("/laya check performs one live round-trip and reports reachability without secrets", async () => {
    const stub = stubLaya(() => jsonResponse({ model: "laya-mock-1.0.0", answers: { probe: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 2 } }));
    const cmd = createLayaCommand();
    const result = await cmd.execute("check", env());
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ command: "/laya check", probed: true, reachable: true, model_answered: "laya-mock-1.0.0", attempts: 1 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe(LAYA_ENDPOINT);
    expect(JSON.stringify(stub.calls[0].body.state)).not.toMatch(/user/i); // the probe carries no user data
    expect(text).not.toContain(LAYA_KEY);

    vi.unstubAllGlobals();
    stubLaya(() => jsonResponse({ detail: "down" }, 500));
    const failing = await cmd.execute("check", env());
    const failed = JSON.parse((failing.content[0] as { text: string }).text);
    expect(failed).toMatchObject({ reachable: false, probed: true });
    expect(failed.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect((failed.error.message + failed.note)).not.toContain(LAYA_KEY);
  });

  it("/laya check skips the network when Laya is unavailable and says why", async () => {
    const stub = stubLaya(() => jsonResponse({ answers: {} }));
    const cmd = createLayaCommand();
    const result = await cmd.execute("check", { LAYA_ENABLED: "false" });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({ command: "/laya check", reachable: false, probed: false });
    expect(stub.calls).toHaveLength(0);
  });

  it("/laya mode explains the routing modes and the fallthrough chain", async () => {
    const cmd = createLayaCommand();
    const result = await cmd.execute("mode", env({ TYPESAFE_API_KEY: JEV_KEY, DECISION_PROVIDER_MODE: "jev" }));
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.routing_mode).toBe("jev");
    expect(parsed.modes.auto).toMatch(/Laya is asked first/);
    expect(parsed.providers.laya.available).toBe(true);
    expect(parsed.providers.jev.available).toBe(true);
  });

  it("routes through the command registry like the other commands", async () => {
    registerCommand(createLayaCommand());
    const result = await routeCommand("/laya", env());
    expect(result).not.toBeNull();
    expect(JSON.parse((result?.content[0] as { text: string }).text).command).toBe("/laya");
  });
});

/* ------------------------------------------------------ MCP + HTTP surfaces */

async function rpc(method: string, params: Record<string, unknown>, envValue: unknown, headers: Record<string, string> = {}) {
  const response = await worker.fetch(
    new Request("https://demo.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    envValue as never,
    CTX,
  );
  const text = await response.text();
  if (text.trim().startsWith("{")) return JSON.parse(text);
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
  return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim());
}

async function callTool(name: string, args: Record<string, unknown>, envValue: unknown, headers: Record<string, string> = { authorization: "Bearer mcp-key" }) {
  const response = await rpc("tools/call", { name, arguments: args }, envValue, headers);
  expect(response.error).toBeUndefined();
  const text = (response.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { isError: Boolean(response.result?.isError), text, parsed };
}

describe("Laya MCP surface", () => {
  it("registers laya_capabilities alongside — never replacing — the Jev tools", async () => {
    const listed = await rpc("tools/list", {}, {});
    const names: string[] = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("laya_capabilities");
    expect(names).toContain("jev_decide");
    expect(names).toContain("jev_capabilities");
    expect(names).toHaveLength(TOOL_COUNT);
    expect(DEMO_TOOL_NAMES.filter((name) => name.startsWith("laya_"))).toEqual(["laya_capabilities"]);
    const decide = listed.result.tools.find((tool: { name: string }) => tool.name === "jev_decide");
    expect(decide.inputSchema.properties.provider.enum).toEqual(["auto", "laya", "jev"]);
  });

  it("publishes a presence-only capability report (tool, resource and route)", async () => {
    const result = await callTool("laya_capabilities", {}, env({ DEMO_API_KEY: "mcp-key" }));
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({
      schema: "demo.laya-capabilities/1",
      provider: "laya",
      available: true,
      enabled: true,
      configured: true,
      credentialConfigured: true,
      endpointHost: "laya.example.test",
      httpsOnly: true,
      model: LAYA_DEFAULT_MODEL,
    });
    expect(result.parsed.routing.mode).toBe("auto");
    expect(result.parsed.routing.failover).toMatch(/Laya.*Jev.*deterministic/s);
    expect(result.parsed.endpointNote).toMatch(/never hosts/i);
    expect(result.text).not.toContain(LAYA_KEY);
    expect(result.text).not.toContain("LAYA_API_KEY");
    expect(result.text).not.toContain("[redacted]");

    const route = await worker.fetch(new Request("https://demo.test/capabilities/laya"), env({ DEMO_API_KEY: "mcp-key" }) as never, CTX);
    expect(route.status).toBe(200);
    expect(((await route.json()) as { schema: string }).schema).toBe("demo.laya-capabilities/1");

    const resource = await rpc("resources/read", { uri: LAYA_CAPABILITIES_URI }, env({ DEMO_API_KEY: "mcp-key" }));
    expect(resource.error).toBeUndefined();
    expect(JSON.parse(resource.result.contents[0].text).provider).toBe("laya");

    // Without configuration the report says so, and still spends nothing.
    const bare = await callTool("laya_capabilities", {}, {});
    expect(bare.parsed.available).toBe(false);
    expect(bare.parsed.disabledReason).toMatch(/LAYA_BASE_URL/);
  });

  it("jev_decide provider:\"laya\" runs the decision through Laya only", async () => {
    const stubs = stubProviders({
      laya: (body) => jsonResponse({ model: "laya-1.2.3", answers: { primary: choiceAnswer("utility", distribution(Object.keys(body.questions.primary.criteria), "utility", 0.9), 0.9) }, usage: { input_tokens: 9, output_tokens: 2 } }),
      jev: () => jsonResponse({ detail: "must not be called" }, 500),
    });
    const result = await callTool("jev_decide", { decision: "tool_route", request: "what should I do with the string I pasted earlier?", provider: "laya" }, env({ DEMO_API_KEY: "mcp-key" }));
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ source: "laya", decision: "utility", requestedProvider: "laya", effectiveRoutingMode: "laya", authority: "advisory" });
    expect(stubs.layaCalls).toHaveLength(1);
    expect(stubs.jevCalls).toHaveLength(0);
    expect(result.text).not.toContain(LAYA_KEY);
  });

  it("jev_decide provider:\"jev\" keeps the unchanged Jev path even with Laya configured", async () => {
    const stubs = stubProviders({
      laya: () => jsonResponse({ detail: "must not be called" }, 500),
      jev: (body) => jsonResponse({ model: "jev-1.13.0", answers: { primary: choiceAnswer("utility", distribution(Object.keys(body.questions.primary.criteria), "utility", 0.92), 0.92) }, usage: {} }),
    });
    const result = await callTool("jev_decide", { decision: "tool_route", request: "what should I do with the string I pasted earlier?", provider: "jev" }, env({ DEMO_API_KEY: "mcp-key", TYPESAFE_API_KEY: JEV_KEY }));
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ source: "jev", decision: "utility", requestedProvider: "jev", effectiveRoutingMode: "jev" });
    expect(stubs.layaCalls).toHaveLength(0);
    expect(stubs.jevCalls).toHaveLength(1);
    expect(result.text).not.toContain(JEV_KEY);
  });

  it("demo_ping and /health expose Laya presence flags and the routing mode — and no credential material", async () => {
    const ping = await callTool("demo_ping", {}, env({ DEMO_API_KEY: "mcp-key" }));
    expect(ping.parsed).toMatchObject({ layaDecisionEngine: true, layaConfigured: true, layaApiKeyConfigured: true, layaModel: LAYA_DEFAULT_MODEL, decisionRoutingMode: "auto" });
    expect(ping.text).not.toContain(LAYA_KEY);

    for (const path of ["/", "/health"]) {
      const response = await worker.fetch(new Request(`https://demo.test${path}`), env() as never, CTX);
      const body = await response.text();
      expect(body).not.toContain(LAYA_KEY);
      expect(body).not.toContain("LAYA_API_KEY");
      expect(body).not.toContain("Bearer");
      const flags = JSON.parse(body);
      expect(flags.layaDecisionEngine).toBe(true);
      expect(flags.decisionRoutingMode).toBe("auto");
      expect(flags.resources).toContain("demo://capabilities/laya");
    }
  });

  it("/platform/stats reports Laya presence-only alongside Jev, satisfying the no-secrets invariant", async () => {
    const response = await platform.fetch(new Request("https://demo.test/platform/stats"), env({ TYPESAFE_API_KEY: JEV_KEY }) as never, CTX);
    const body = await response.json() as Record<string, any>;
    expect(body.telemetry.containsSecrets).toBe(false);
    expect(body.capabilities.layaDecisionProvider).toMatchObject({
      available: true,
      enabled: true,
      configured: true,
      credentialConfigured: true,
      model: LAYA_DEFAULT_MODEL,
      endpointHost: "laya.example.test",
      routingMode: "auto",
    });
    expect(body.capabilities.typedDecisions).toBe(true);
    expect(body.endpoints.layaCapabilities).toBe("/capabilities/laya");
    const dumped = JSON.stringify(body);
    expect(dumped).not.toMatch(/api[_-]?key|authorization|bearer/i);
    expect(dumped).not.toContain(LAYA_KEY);
    expect(dumped).not.toContain(JEV_KEY);
    expect(dumped).not.toContain("/v1/systemone");
  });

  it("the /mcp command shows Laya alongside JEV without exposing the credential", async () => {
    const cmd = createMcpCommand({ version: "0.9.0-test", toolNames: ["laya_capabilities", "jev_decide", "jev_capabilities"], commands: [] });
    const result = await cmd.execute("", env({ TYPESAFE_API_KEY: JEV_KEY }));
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.tools.Laya).toEqual(["laya_capabilities"]);
    expect(parsed.tools.JEV).toEqual(["jev_decide", "jev_capabilities"]);
    expect(parsed.health.Laya).toMatch(/Online/);
    expect(parsed.health["JEV / TypeSafe"]).toMatch(/Online/);
    expect(parsed.capabilities).toContain("Laya");
    expect(parsed.capabilities).toContain("JEV");
    expect(parsed.decision_routing.mode).toBe("auto");
    expect(text).not.toContain(LAYA_KEY);
    expect(text).not.toContain(JEV_KEY);
  });

  it("a broken Laya configuration must not break unrelated DEMO tools", async () => {
    // Laya endpoint blocked by the SSRF guard; everything else must keep working.
    const broken = env({ LAYA_BASE_URL: "https://127.0.0.1:8443", DEMO_API_KEY: "mcp-key" });
    const ping = await callTool("demo_ping", {}, broken);
    expect(ping.parsed.ok).toBe(true);
    const formatted = await callTool("json_format", { json: '{"a":1}' }, broken);
    expect(formatted.parsed).toEqual({ a: 1 });
    const uuid = await callTool("generate_uuid", {}, broken);
    expect(uuid.text).toMatch(/^[0-9a-f-]{36}$/);
    const laya = await callTool("laya_capabilities", {}, broken);
    expect(laya.parsed.available).toBe(true); // config parses; the guard blocks at call time
    const probe = await probeLaya({ config: resolveLayaConfig(broken), apiKey: LAYA_KEY, env: broken });
    expect(probe.reachable).toBe(false);
    expect(probe.error?.code).toBe("blocked_url");
  });
});
