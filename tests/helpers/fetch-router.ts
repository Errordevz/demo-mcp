/**
 * Test helper: deterministic `globalThis.fetch` routing.
 *
 * Every DEMO 0.9 fetch-based capability goes through the SSRF-guarded client
 * which uses `fetch` — so tests stub the global with a hostname router (and
 * record requests for assertions), while DoH queries to cloudflare-dns.com can
 * be answered inline. Production code paths stay 100% real.
 */

export interface RouteResult {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Raw Response override (e.g. redirect hops). */
  response?: Response;
}

export type RouteHandler = (request: { url: URL; method: string; headers: Record<string, string>; body: Uint8Array | null }) => RouteResult | Promise<RouteResult>;

export interface FetchRouter {
  restore(): void;
  requests: Array<{ url: string; method: string }>;
  on(hostname: string, handler: RouteHandler): void;
  /** DNS answers returned for every DoH query (default: a public A record). */
  dnsAnswer: string | null;
  /** Make DoH requests fail (for fail-open/fail-closed tests). */
  dnsFails: boolean;
}

export function installFetchRouter(): FetchRouter {
  const realFetch = globalThis.fetch;
  const routes = new Map<string, RouteHandler>();
  const requests: Array<{ url: string; method: string }> = [];
  const state = { dnsAnswer: "8.8.8.8" as string | null, dnsFails: false };

  const router = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    requests.push({ url: request.url, method: request.method });
    if (url.hostname === "cloudflare-dns.com") {
      if (state.dnsFails) throw new TypeError("resolver unreachable");
      const type = url.searchParams.get("type");
      const answer = state.dnsAnswer && (type === "A" || !type) ? [{ type: 1, data: state.dnsAnswer, TTL: 60 }] : [];
      return new Response(JSON.stringify({ Status: 0, Answer: answer }), { headers: { "content-type": "application/dns-json" } });
    }
    const handler = routes.get(url.hostname);
    if (!handler) throw new TypeError(`fetch router: no route for ${url.hostname}`);
    let body: Uint8Array | null = null;
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      body = new Uint8Array(await request.arrayBuffer());
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const result = await handler({ url, method: request.method, headers, body });
    if (result.response) return result.response;
    return new Response(result.body === undefined ? null : typeof result.body === "string" ? result.body : result.body.slice(), {
      status: result.status ?? 200,
      headers: result.headers ?? {},
    });
  }) as typeof fetch;

  globalThis.fetch = router;
  return {
    restore() {
      globalThis.fetch = realFetch;
    },
    requests,
    on(hostname, handler) {
      routes.set(hostname, handler);
    },
    get dnsAnswer() {
      return state.dnsAnswer;
    },
    set dnsAnswer(value: string | null) {
      state.dnsAnswer = value;
    },
    get dnsFails() {
      return state.dnsFails;
    },
    set dnsFails(value: boolean) {
      state.dnsFails = value;
    },
  };
}

/** JSON body + content-type convenience. */
export function jsonResult(value: unknown, status = 200): RouteResult {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export function htmlResult(html: string, status = 200, headers: Record<string, string> = {}): RouteResult {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body: html };
}
