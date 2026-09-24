/**
 * Local utility tools — all offline, no API key, no data leaves the Worker:
 * `schema_validate` (JSON Schema), `jwt_inspect` (decode-only), `cron_explain`
 * (validate/explain/schedule) and `text_diff` (text/JSON/document comparison).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { changedSections, diffJson, diffLines, normalizeForDiff, summarizeDiff, toUnifiedDiff } from "../core/text-diff.js";
import { validateJsonSchema } from "../validate/json-schema.js";
import { inspectJwt } from "../tokens/jwt.js";
import { explainCron, nextCronOccurrences } from "../time/cron.js";
import { runTool, textResult } from "./results.js";

export const UTIL_TOOL_NAMES = ["schema_validate", "jwt_inspect", "cron_explain", "text_diff"] as const;

export interface UtilToolContext {
  env: Record<string, unknown>;
}

export function registerUtilTools(mcp: McpServer, _ctx: UtilToolContext): void {
  mcp.registerTool(
    "schema_validate",
    {
      title: "Validate JSON against a Schema",
      description:
        "Validate a JSON document against a JSON Schema (draft-07 / 2019-09 / 2020-12 practical subset: type, enum, const, properties, required, additionalProperties, items/prefixItems, numeric/string bounds, pattern, format subset, allOf/anyOf/oneOf/not, if/then/else, internal $ref). Returns valid/invalid plus EXACT failing JSON-pointer paths, the expected schema constraint, the received value/type and useful messages. Entirely local — user data is never sent to an external service. Remote $ref targets are refused (never fetched) and unsupported keywords are reported in warnings, not silently ignored.",
      inputSchema: {
        instance: z.string().max(LIMITS.jsonSchemaMaxBytes).describe("The JSON document to validate (as text)."),
        schema: z.string().max(LIMITS.jsonSchemaMaxBytes).describe("The JSON Schema (as text)."),
        max_errors: z.number().int().min(1).max(LIMITS.jsonSchemaMaxErrors).default(LIMITS.jsonSchemaMaxErrors),
      },
      annotations: { title: "Validate JSON against a Schema", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(async () => {
        let instance: unknown;
        let schema: unknown;
        try {
          instance = JSON.parse(args.instance);
        } catch (error) {
          throw new BrowserError("invalid_input", `instance is not valid JSON: ${String(error instanceof Error ? error.message : error).slice(0, 140)}`, { retryable: false });
        }
        try {
          schema = JSON.parse(args.schema);
        } catch (error) {
          throw new BrowserError("invalid_input", `schema is not valid JSON: ${String(error instanceof Error ? error.message : error).slice(0, 140)}`, { retryable: false });
        }
        const result = validateJsonSchema(instance, schema, { maxErrors: args.max_errors });
        return textResult({ ok: true, ...result });
      }),
  );

  mcp.registerTool(
    "jwt_inspect",
    {
      title: "Inspect a JWT (decode only)",
      description:
        "DECODE a JWT/JWS (compact three-part form): structure check, header decoding (alg, typ, kid…), payload/claims decoding with exp/iat/nbf/iss/aud/sub inspection and expiry-window status. DECODING ≠ VERIFICATION — the result always says verification: not-performed and a decodable token is NEVER claimed to be valid or authentic. No signing key is requested, accepted or stored (there is no verification path at all). The complete token is never returned or logged — only decoded parts (redacted) and a short SHA-256 fingerprint.",
      inputSchema: {
        token: z.string().max(LIMITS.jwtMaxChars).describe("The compact JWT/JWS to decode. Never send signing keys — DEMO does not verify."),
        now: z.string().max(40).optional().describe("Optional reference time (ISO-8601) for exp/nbf evaluation; defaults to current time."),
      },
      annotations: { title: "Inspect a JWT (decode only)", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(async () => {
        let now: Date | undefined;
        if (args.now) {
          const parsed = Date.parse(args.now);
          if (!Number.isFinite(parsed)) throw new BrowserError("invalid_input", "now must be an ISO-8601 timestamp.");
          now = new Date(parsed);
        }
        const result = await inspectJwt(args.token, now ? { now } : {});
        if (!result.ok) return textResult({ ok: false, error: result.error, message: result.message, verification: "not-performed" });
        return textResult({ ok: true, ...result.inspection });
      }),
  );

  mcp.registerTool(
    "cron_explain",
    {
      title: "Cron Expression Helper",
      description:
        "Validate and explain a cron expression in human-readable language and compute upcoming execution times. Supports standard 5-field cron, the common 6-field seconds extension and @yearly/@monthly/@weekly/@daily/@hourly macros, with lists, ranges, steps and month/weekday names (Vixie day-of-month/day-of-week OR semantics). Malformed expressions return a precise error. Entirely local — no external service.",
      inputSchema: {
        expression: z.string().max(120).describe('e.g. "*/15 9-17 * * MON-FRI" or "@daily"'),
        count: z.number().int().min(1).max(LIMITS.cronMaxOccurrences).default(5).describe("How many upcoming occurrences to compute."),
        from: z.string().max(40).optional().describe("ISO-8601 reference time (default now)."),
        horizon_days: z.number().int().min(1).max(LIMITS.cronSearchHorizonDays).default(366),
      },
      annotations: { title: "Cron Expression Helper", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(async () => {
        let from: Date | undefined;
        if (args.from) {
          const parsed = Date.parse(args.from);
          if (!Number.isFinite(parsed)) throw new BrowserError("invalid_input", "from must be an ISO-8601 timestamp.");
          from = new Date(parsed);
        }
        const result = nextCronOccurrences(args.expression, { count: args.count, ...(from ? { from } : {}), horizonDays: args.horizon_days });
        return textResult({ ok: result.valid, ...result });
      }),
  );

  mcp.registerTool(
    "text_diff",
    {
      title: "Text / Document Diff",
      description:
        "Compare two texts or documents locally: mode=lines (structured added/removed/changed sections), mode=unified (unified-diff text), mode=json (deep JSON diff with exact paths). Optional normalization (web-noise/whitespace) for content with timestamps and counters. Markdown and other documents compare as text — added/removed lines, changed sections and a similarity score, structured for both humans and coding agents. Nothing is uploaded to any service.",
      inputSchema: {
        mode: z.enum(["lines", "unified", "json"]).default("lines"),
        a: z.string().max(1_000_000).describe("First (previous) text or JSON."),
        b: z.string().max(1_000_000).describe("Second (current) text or JSON."),
        normalize: z.enum(["none", "whitespace", "web-noise"]).default("none"),
        label_a: z.string().max(120).default("a"),
        label_b: z.string().max(120).default("b"),
        context_lines: z.number().int().min(0).max(10).default(3),
        max_lines: z.number().int().min(50).max(LIMITS.diffMaxLinesCap).default(LIMITS.diffMaxLinesDefault),
      },
      annotations: { title: "Text / Document Diff", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(async () => {
        const mode = (args.mode ?? "lines") as "lines" | "unified" | "json";
        if (mode === "json") {
          let left: unknown;
          let right: unknown;
          try {
            left = JSON.parse(args.a);
            right = JSON.parse(args.b);
          } catch (error) {
            throw new BrowserError("invalid_input", `json mode needs both sides to be valid JSON: ${String(error instanceof Error ? error.message : error).slice(0, 140)}`, { retryable: false });
          }
          const result = diffJson(left, right);
          return textResult({ ok: true, mode, ...result, summary: { changes: result.entries.length, truncated: result.truncated } });
        }
        const left = normalizeForDiff(args.a, args.normalize);
        const right = normalizeForDiff(args.b, args.normalize);
        const diff = diffLines(left, right, { maxLines: args.max_lines });
        const summary = summarizeDiff(diff);
        if (mode === "unified") {
          return textResult({ ok: true, mode, summary, unified_diff: toUnifiedDiff(diff, args.label_a, args.label_b, args.context_lines).slice(0, LIMITS.diffMaxOutputBytes) });
        }
        return textResult({
          ok: true,
          mode,
          summary,
          sections: changedSections(diff).slice(0, 100),
          added: diff.ops.filter((op) => op.op === "insert").map((op) => op.text).slice(0, 500),
          removed: diff.ops.filter((op) => op.op === "delete").map((op) => op.text).slice(0, 500),
        });
      }),
  );
}
