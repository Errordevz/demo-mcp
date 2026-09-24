/**
 * DEMO 0.9 — OpenAPI inspection + network diagnostics + URL safety.
 * Documents parse offline; diagnostics run against stubbed public endpoints;
 * the inspector must never call the APIs it discovers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseYamlLite } from "../src/openapi/yaml.js";
import { inspectOpenApi, parseOpenApiDocument } from "../src/openapi/inspect.js";
import { dnsLookup, httpDiagnose, tlsDiagnose } from "../src/network/diagnose.js";
import { inspectUrl, inspectUrlStatic } from "../src/security/url-safety.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import { installFetchRouter, jsonResult, type FetchRouter, type RouteResult } from "./helpers/fetch-router.js";

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Weather API
  description: |
    Public weather lookups.
    Two lines of description.
  version: 1.2.0
servers:
  - url: https://api.weather.example.com/v1
    description: production
paths:
  /forecast:
    get:
      operationId: getForecast
      summary: Get the forecast
      tags: [weather]
      parameters:
        - name: city
          in: query
          required: true
          schema:
            type: string
      responses:
        '200':
          description: A forecast
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Forecast'
        '404':
          description: Unknown city
    post:
      operationId: createSubscription
      summary: Subscribe to alerts
      deprecated: true
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Subscription'
      responses:
        '201': { description: Created }
      security:
        - apiKey: []
components:
  schemas:
    Forecast:
      type: object
      properties:
        city: { type: string }
        tempC: { type: number }
    Subscription:
      type: object
      required: [email]
      properties:
        email: { type: string }
  securitySchemes:
    apiKey:
      type: apiKey
      in: header
      name: X-API-Key
security:
  - apiKey: []`;

describe("YAML subset parser", () => {
  it("parses mappings, sequences, flow collections and block scalars", () => {
    const result = parseYamlLite("a: 1\nb:\n  - x\n  - y: 2\n    z: [1, 2]\nc: |\n  line1\n  line2\nd: \"quoted: yes\"\n# comment\n");
    const value = result.value as Record<string, any>;
    expect(value.a).toBe(1);
    expect(value.b[0]).toBe("x");
    expect(value.b[1].y).toBe(2);
    expect(value.b[1].z).toEqual([1, 2]);
    expect(String(value.c)).toContain("line1");
    expect(value.d).toBe("quoted: yes");
    expect(result.warnings.length).toBe(0);
  });

  it("handles anchors/aliases, merge keys and malformed lines without throwing", () => {
    const result = parseYamlLite("base: &base\n  kind: shared\nchild:\n  <<: *base\n  name: kid\nbroken line without colon\n");
    const value = result.value as Record<string, any>;
    expect(value.child.kind).toBe("shared");
    expect(value.child.name).toBe("kid");
    const malformed = parseYamlLite("::: not yaml at all ][");
    expect(malformed.value === null || typeof malformed.value === "object").toBe(true);
  });
});

describe("OpenAPI inspection", () => {
  it("extracts title/version/servers/paths/params/bodies/responses/security/components from OpenAPI 3 YAML", () => {
    const parsed = parseOpenApiDocument(OPENAPI_YAML);
    const report = inspectOpenApi(parsed.document);
    expect(report.specification).toBe("openapi3");
    expect(report.title).toBe("Weather API");
    expect(report.version).toBe("1.2.0");
    expect(report.description).toContain("Public weather lookups");
    expect(report.servers[0].url).toBe("https://api.weather.example.com/v1");
    expect(report.operations.length).toBe(2);
    const get = report.operations.find((operation) => operation.method === "get")!;
    expect(get.operationId).toBe("getForecast");
    expect(get.summary).toBe("Get the forecast");
    expect(get.parameters[0]).toMatchObject({ name: "city", in: "query", required: true, type: "string" });
    expect(get.responses.find((response) => response.status === "200")?.schemaRef).toBe("#/components/schemas/Forecast");
    const post = report.operations.find((operation) => operation.method === "post")!;
    expect(post.deprecated).toBe(true);
    expect(post.requestBody?.schemaRef).toBe("#/components/schemas/Subscription");
    expect(report.securitySchemes[0]).toMatchObject({ name: "apiKey", type: "apiKey", in: "header", apiKeyName: "X-API-Key" });
    expect(report.components.schemas.map((schema) => schema.name).sort()).toEqual(["Forecast", "Subscription"]);
    expect(report.components.schemas[0].properties).toContain("city");
    expect(report.stats.operationsByMethod.get).toBe(1);
    expect(report.notes.join(" ")).toMatch(/did not call any endpoint/i);
  });

  it("reads Swagger 2.0 documents where practical", () => {
    const swagger = JSON.stringify({
      swagger: "2.0",
      info: { title: "Legacy API", version: "0.9" },
      host: "legacy.example.com",
      basePath: "/api",
      schemes: ["https"],
      paths: { "/things": { get: { summary: "List things", parameters: [{ name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Thing" } }], responses: { "200": { description: "ok", schema: { type: "array", items: { $ref: "#/definitions/Thing" } } } } } } },
      definitions: { Thing: { type: "object", properties: { id: { type: "string" } } } },
      securityDefinitions: { basic: { type: "basic" } },
    });
    const report = inspectOpenApi(parseOpenApiDocument(swagger).document);
    expect(report.specification).toBe("swagger2");
    expect(report.servers[0].url).toBe("https://legacy.example.com/api");
    expect(report.securitySchemes[0]).toMatchObject({ name: "basic", type: "basic" });
    expect(report.components.schemas[0].name).toBe("Thing");
  });

  it("never calls discovered APIs (exactly one document fetch)", async () => {
    const router = installFetchRouter();
    publicToolRateLimiter.reset();
    try {
      router.on("spec.example.com", () => ({ status: 200, headers: { "content-type": "application/yaml" }, body: OPENAPI_YAML }));
      const { default: worker } = await import("../index.js");
      const response = await worker.fetch(
        new Request("https://demo.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "openapi_inspect", arguments: { url: "https://spec.example.com/openapi.yaml" } } }),
        }),
        { TOOL_RATE_LIMIT_PER_MINUTE: "60" } as never,
        { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
      );
      const text = await response.text();
      const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
      const body = JSON.parse((payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n"));
      expect(body.ok).toBe(true);
      expect(body.title).toBe("Weather API");
      // Exactly one fetch to the document host (DoH may query A+AAAA first),
      // and absolutely no request to the API servers the document describes.
      const hosts = router.requests.map((request) => new URL(request.url).hostname);
      expect(hosts.filter((host) => host === "spec.example.com").length).toBe(1);
      expect(hosts.every((host) => host === "cloudflare-dns.com" || host === "spec.example.com")).toBe(true);
      expect(router.requests.some((request) => request.url.includes("api.weather.example.com"))).toBe(false);
    } finally {
      router.restore();
    }
  });
});

describe("network diagnostics", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("inspects DNS records via DoH with TTLs", async () => {
    const result = await dnsLookup({ TOOL_RATE_LIMIT_PER_MINUTE: "60" }, "example.com", { types: ["A", "MX"] });
    expect(result.hostname).toBe("example.com");
    expect(result.addresses).toContain("8.8.8.8");
    expect(result.publicAddresses).toBe(true);
    expect(result.records[0].ttl).toBe(60);
  });

  it("refuses internal hostnames instead of probing them", async () => {
    await expect(dnsLookup({}, "localhost")).rejects.toMatchObject({ code: "blocked_url" });
    await expect(dnsLookup({}, "metadata.google.internal")).rejects.toMatchObject({ code: "blocked_url" });
    expect(router.requests.filter((request) => request.url.includes("metadata"))).toEqual([]);
  });

  it("reports status, redirect chain with per-hop verdicts, headers and timing", async () => {
    router.on("site.example.com", ({ url }): RouteResult => {
      if (url.pathname === "/start") return { status: 302, headers: { location: "https://site.example.com/next" } };
      if (url.pathname === "/next") return { status: 301, headers: { location: "https://cdn.example.com/final" } };
      return { status: 200, headers: { "content-type": "text/html", "strict-transport-security": "max-age=31536000", "x-frame-options": "DENY" } };
    });
    router.on("cdn.example.com", (): RouteResult => ({ status: 200, headers: { "content-type": "text/html", "strict-transport-security": "max-age=31536000", "x-frame-options": "DENY", "x-content-type-options": "nosniff" } }));
    const result = await httpDiagnose({ TOOL_RATE_LIMIT_PER_MINUTE: "60" }, "https://site.example.com/start", { maxRedirects: 5 });
    expect(result.redirectChain.length).toBe(3);
    expect(result.finalUrl).toBe("https://cdn.example.com/final");
    expect(result.redirected).toBe(true);
    expect(result.securityHeaders.strictTransportSecurity).toContain("max-age");
    expect(result.securityHeaders.xFrameOptions).toBe("DENY");
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.resolvedAddresses.length).toBeGreaterThan(0);
  });

  it("stops at blocked redirect targets and says why", async () => {
    router.on("evil.example.com", () => ({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    const result = await httpDiagnose({}, "https://evil.example.com/", { maxRedirects: 5 });
    expect(result.redirectChain[0].blocked).toBe(true);
    expect(result.redirectChain[0].reason).toMatch(/blocked/i);
    expect(result.finalUrl).toBe("https://evil.example.com/");
  });

  it("reports TLS as unavailable without a browser binding (never guessed)", async () => {
    router.on("secure.example.com", () => ({ status: 200, headers: { "content-type": "text/html" }, body: "ok" }));
    const result = await tlsDiagnose({}, "https://secure.example.com/", {});
    expect(result.available).toBe(false);
    expect(result.issuer).toBeNull();
    expect(result.message).toMatch(/not exposed|unavailable/i);
  });
});

describe("URL safety inspector", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("classifies and flags suspicious URL shapes statically", () => {
    const ok = inspectUrlStatic("https://example.com/path?q=1");
    expect(ok.classification.verdict).toBe("public");
    expect(ok.parsed.scheme).toBe("https");
    expect(ok.parsed.query.q).toBe("1");

    const redirect = inspectUrlStatic("https://example.com/login?next=https://evil.test/x");
    expect(redirect.suspicious.map((flag) => flag.flag)).toContain("open-redirect-parameter");

    const userinfo = inspectUrlStatic("https://user:pass@example.com/");
    expect(userinfo.suspicious.map((flag) => flag.flag)).toContain("embedded-userinfo");
    expect(userinfo.classification.verdict).toBe("blocked");

    const decimal = inspectUrlStatic("https://0x7f000001/admin");
    expect(decimal.suspicious.map((flag) => flag.flag)).toContain("alternate-ip-notation");

    const controls = inspectUrlStatic("https://example.com/a%00b");
    expect(controls.suspicious.map((flag) => flag.flag)).toContain("encoded-control-characters");

    for (const blocked of ["http://localhost/x", "http://127.0.0.1/", "http://10.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "file:///etc/passwd", "javascript:alert(1)"]) {
      const report = inspectUrlStatic(blocked);
      expect(report.classification.verdict, blocked).toBe("blocked");
      expect(report.message).toMatch(/policy/i);
    }
  });

  it("walks redirect chains re-validating every hop", async () => {
    router.on("jump.example.com", () => ({ status: 302, headers: { location: "https://final.example.com/landing" } }));
    router.on("final.example.com", () => ({ status: 200, headers: { "content-type": "text/html", "server": "demo" } }));
    const report = await inspectUrl({}, "https://jump.example.com/go", { followRedirects: true });
    expect(report.redirectChain.length).toBe(2);
    expect(report.finalUrl).toBe("https://final.example.com/landing");
    expect(report.finalVerdict).toBe("public");
    expect(report.response?.securityHeaders.server).toBe("demo");
    expect(report.suspicious.map((flag) => flag.flag)).toContain("multi-host-redirect");
  });

  it("flags https downgrade and blocked redirect destinations", async () => {
    router.on("down.example.com", () => ({ status: 301, headers: { location: "http://down.example.com/plain" } }));
    router.on("blocked-hop.example.com", () => ({ status: 302, headers: { location: "https://127.0.0.1/admin" } }));
    const downgrade = await inspectUrl({}, "https://down.example.com/secure", { followRedirects: true });
    expect(downgrade.suspicious.map((flag) => flag.flag)).toContain("https-downgrade-redirect");
    const blocked = await inspectUrl({}, "https://blocked-hop.example.com/", { followRedirects: true });
    expect(blocked.finalVerdict).toBe("blocked");
    expect(blocked.suspicious.map((flag) => flag.flag)).toContain("redirect-to-blocked-target");
  });
});
