/**
 * Network-facing inspection tools: `openapi_inspect` (document inspection only —
 * discovered APIs are never called), `net_diagnose` (safe DNS/HTTP/TLS
 * diagnostics, public targets only) and `url_inspect` (URL safety report over
 * the existing SSRF stack).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { LIMITS } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { inspectOpenApi, parseOpenApiDocument } from "../openapi/inspect.js";
import { dnsLookup, httpDiagnose, tlsDiagnose } from "../network/diagnose.js";
import { inspectUrl, inspectUrlStatic } from "../security/url-safety.js";
import { runTool, textResult } from "./results.js";

export const NETWORK_TOOL_NAMES = ["openapi_inspect", "net_diagnose", "url_inspect"] as const;

export interface NetworkToolContext {
  env: Record<string, unknown> & { BROWSER?: unknown };
  withRawPage?: <T>(fn: (page: unknown) => Promise<T>) => Promise<T>;
}

export function registerNetworkTools(mcp: McpServer, ctx: NetworkToolContext): void {
  mcp.registerTool(
    "openapi_inspect",
    {
      title: "OpenAPI Inspector",
      description:
        "Inspect a public OpenAPI 3.x document (or Swagger 2.0 where practical) in JSON or YAML: API title/version/description, servers, paths with HTTP methods, parameters, request bodies, response schemas, authentication/security schemes (names and types only — never credentials), reusable component schemas and endpoint summaries. Provide a public URL or inline document. DEMO READS the document and never calls the APIs it describes; remote $ref targets are never fetched. SSRF, size and timeout limits apply to the fetch.",
      inputSchema: {
        url: z.string().url().max(2_000).optional().describe("Public URL of the OpenAPI/Swagger document (JSON or YAML)."),
        document: z.string().max(LIMITS.openapiMaxBytes).optional().describe("Inline document text instead of a URL."),
        max_endpoints: z.number().int().min(1).max(LIMITS.openapiMaxEndpointsCap).default(LIMITS.openapiMaxEndpointsCap),
        timeout_ms: z.number().int().min(1_000).max(LIMITS.publicFetchTimeoutMaxMs).optional(),
      },
      annotations: { title: "OpenAPI Inspector", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        if (!args.url && !args.document) throw new BrowserError("invalid_input", "Provide either url or document.");
        let source = args.document ?? "";
        let fetchedFrom: string | null = null;
        let parseWarnings: string[] = [];
        if (args.url) {
          publicToolRateLimiter.charge(ctx.env, "openapi_inspect", args.url);
          const guard = createSsrfGuard(ctx.env);
          const result = await guardedFetchBytes(args.url, {
            guard,
            timeoutMs: args.timeout_ms ?? 15_000,
            maxBytes: LIMITS.openapiMaxBytes,
            acceptContentTypes: null,
            headers: { accept: "application/json, application/yaml, text/yaml, text/plain, */*;q=0.2", "user-agent": "DEMO-MCP/0.9.0 (+openapi inspector)" },
          });
          source = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
          fetchedFrom = result.finalUrl;
        }
        const parsed = parseOpenApiDocument(source);
        parseWarnings = parsed.warnings;
        const report = inspectOpenApi(parsed.document, { maxEndpoints: args.max_endpoints });
        return textResult({ ok: true, ...(fetchedFrom ? { fetchedFrom } : {}), ...report, warnings: [...parseWarnings, ...report.warnings] });
      }),
  );

  mcp.registerTool(
    "net_diagnose",
    {
      title: "Network Diagnostics",
      description:
        "Safe PUBLIC-network diagnostics for one hostname/URL at a time (never a scanner): mode=dns (DNS records via DNS-over-HTTPS: A/AAAA/MX/NS/TXT/CNAME/SOA/CAA/SRV with TTLs), mode=http (status, redirect chain with per-hop safety verdicts, response headers, timing, resolved addresses), mode=tls (certificate issuer/subject/expiry via the existing browser binding when available — reported unavailable otherwise, never guessed), mode=full (all of the above). localhost, private ranges, link-local, metadata endpoints and internal names are refused, not probed. No port scanning, no sweeps, no service fingerprinting.",
      inputSchema: {
        mode: z.enum(["dns", "http", "tls", "full"]).default("http"),
        target: z.string().max(2_000).describe("A public hostname (dns mode) or http(s) URL (http/tls/full)."),
        record_types: z.array(z.enum(["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "CAA", "SRV"])).max(6).optional().describe("dns mode: record types to query (default: all supported)."),
        max_redirects: z.number().int().min(0).max(8).default(5),
        method: z.enum(["GET", "HEAD"]).default("HEAD"),
      },
      annotations: { title: "Network Diagnostics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const mode = (args.mode ?? "http") as "dns" | "http" | "tls" | "full";
        const target = args.target.trim();
        const asUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`;
        const hostname = (() => {
          try {
            return new URL(asUrl).hostname;
          } catch {
            return target;
          }
        })();
        const out: Record<string, unknown> = { ok: true, mode, target };
        if (mode === "dns" || mode === "full") out.dns = await dnsLookup(ctx.env, hostname, { types: args.record_types });
        if (mode === "http" || mode === "full") out.http = await httpDiagnose(ctx.env, asUrl, { method: args.method, maxRedirects: args.max_redirects });
        if (mode === "tls" || mode === "full") {
          out.tls = await tlsDiagnose(ctx.env as never, asUrl, { ...(ctx.withRawPage ? { withRawPage: ctx.withRawPage as never } : {}) });
        }
        return textResult(out);
      }),
  );

  mcp.registerTool(
    "url_inspect",
    {
      title: "URL Safety Inspector",
      description:
        "Inspect a URL with DEMO's SSRF/security stack and report the verdict: parsing (scheme/host/port/path/query), scheme validation, hostname resolution with public/private classification, suspicious-pattern flags (open-redirect parameters, alternate IP notations, encoded control characters, userinfo tricks, downgrade/multi-host redirects) and — with follow_redirects — the full redirect chain with every hop re-validated plus the final destination and security-related response headers. Explicitly blocks localhost, RFC1918/loopback/link-local, metadata services, internal DNS zones and unsafe schemes — the same rules that protect every other tool (this never weakens them).",
      inputSchema: {
        url: z.string().max(2_000),
        follow_redirects: z.boolean().default(true),
        max_redirects: z.number().int().min(0).max(8).default(5),
        static_only: z.boolean().default(false).describe("Only parse/flag, no network at all."),
      },
      annotations: { title: "URL Safety Inspector", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        if (args.static_only) return textResult({ ok: true, ...inspectUrlStatic(args.url), message: `${inspectUrlStatic(args.url).message} (static_only: no network requests were made)` });
        const result = await inspectUrl(ctx.env, args.url, { followRedirects: args.follow_redirects, maxRedirects: args.max_redirects });
        return textResult({ ok: result.classification.verdict !== "blocked" && result.finalVerdict !== "blocked", ...result });
      }),
  );
}
