/**
 * Reverse-engineering MCP tools.
 *
 * Seven tools, all delegating to one router (`src/reverse-engineering/router.ts`):
 *
 *   reverse_engineer     — the orchestrator: capabilities, triage, analyze,
 *                          protocol, deobfuscate, clean-room, evidence, report,
 *                          compare, dynamic (refused by default)
 *   reverse_capabilities — which engines exist here, and what is missing
 *   reverse_triage       — container/architecture/sections/symbols/entropy
 *   reverse_analyze      — the full evidence-driven pass for one objective
 *   reverse_evidence     — paged, labelled evidence for a stored analysis
 *   reverse_report       — the deliverable, with unknowns and single-source flags
 *   reverse_compare      — mechanical comparison of two artifacts
 *
 * Everything is read-only: the tools parse bytes, check arithmetic and report.
 * They never execute a target, never spawn a process, never accept a command.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { resolveReverseEngineeringConfig } from "../reverse-engineering/config.js";
import { createReverseEngineeringStore } from "../reverse-engineering/store.js";
import { runReverseRequest, type ReverseAction, type ReverseContext, type ReverseRequest } from "../reverse-engineering/router.js";
import { safetyContract } from "../reverse-engineering/sandbox.js";
import { runTool, textResult } from "./results.js";

export const REVERSE_TOOL_NAMES = [
  "reverse_engineer",
  "reverse_capabilities",
  "reverse_triage",
  "reverse_analyze",
  "reverse_evidence",
  "reverse_report",
  "reverse_compare",
] as const;

export interface ReverseToolContext {
  env: Record<string, unknown> & { SCREENSHOTS?: unknown };
}

const ACTIONS = ["capabilities", "triage", "analyze", "protocol", "deobfuscate", "cleanroom", "evidence", "report", "compare", "dynamic"] as const;

const targetSchema = {
  /** Base64 of the target bytes. The only source that works with no configuration. */
  inlineBase64: z.string().max(64 * 1024 * 1024).optional().describe("Base64-encoded target bytes (inline)."),
  /** A public URL, fetched through DEMO's SSRF guard. */
  url: z.string().url().max(2_000).optional().describe("Public http(s) URL of the target, fetched through DEMO's SSRF guard."),
  /** An id returned by a previous analysis. */
  artifactId: z.string().max(128).optional().describe("Id of a previously stored artifact from this deployment."),
  /** A path inside the isolated reverse-engineering workspace. */
  workspacePath: z.string().max(512).optional().describe("Path inside the isolated analysis workspace (re-workspace/…)."),
  name: z.string().max(128).optional().describe("Display name for the target. Never treated as a filesystem path."),
};

const evidenceLabel = z.enum(["observed", "inferred", "proposed", "web", "unknown"]);
const authorizationSchema = {
  confirmed: z.boolean().optional().describe("Explicitly confirm you are authorised to analyse this target."),
  scope: z.enum(["local-artifact", "authorized-target", "public-source", "captured-traffic"]).optional().describe("Where the target came from."),
  statement: z.string().max(500).optional().describe("Statement of authority, recorded with the evidence."),
  justification: z.string().max(500).optional().describe("Why dynamic analysis is necessary for this objective."),
};

function buildContext(ctx: ReverseToolContext): ReverseContext {
  const env = ctx.env;
  const config = resolveReverseEngineeringConfig(env);
  const bucket = env.SCREENSHOTS as never;
  const store = createReverseEngineeringStore(bucket as never, () => new Date());
  const guard = createSsrfGuard(env);
  return {
    config,
    store,
    fetchBytes: async (url, maxBytes) => {
      const result = await guardedFetchBytes(url, {
        guard,
        timeoutMs: Math.min(config.analyzerTimeoutMs, 30_000),
        maxBytes,
        acceptContentTypes: null,
        headers: { accept: "application/octet-stream, */*;q=0.1", "user-agent": "DEMO-MCP/1.1.0 (+reverse engineering)" },
      });
      return { bytes: result.bytes, contentType: result.contentType ?? null, finalUrl: result.finalUrl };
    },
    now: () => new Date(),
  };
}

export function registerReverseTools(mcp: McpServer, ctx: ReverseToolContext): void {
  const charge = (key: string) => {
    publicToolRateLimiter.charge(ctx.env, "reverse_engineer", key);
  };

  const run = async (request: ReverseRequest): Promise<string> => {
    const reverse = buildContext(ctx);
    const response = await runReverseRequest(reverse, request);
    return JSON.stringify(response, null, 2);
  };

  /* ------------------------------------------------------------- orchestrator */

  mcp.registerTool(
    "reverse_engineer",
    {
      title: "Reverse Engineer",
      description:
        "Evidence-driven reverse engineering of a binary, container, capture or archive. One orchestrator for the whole workflow: capabilities → triage → objective-specific analysis → evidence → report. Every claim is labelled observed / inferred / proposed / web / unknown, and every analysis names the tools it used and the ones it is missing. Static analysis only by default: bytes are read as data and never executed. Dynamic analysis is opt-in, sandboxed, and refused unless the deployment, an analysis service and an explicit authorization all agree. No arbitrary command execution is exposed.",
      inputSchema: {
        action: z.enum(ACTIONS).describe("Which phase to run. `analyze` runs the full pipeline; `capabilities` needs no target."),
        target: z.object(targetSchema).optional().describe("The target, from exactly one source."),
        compareWith: z.object(targetSchema).optional().describe("A second target, for compare."),
        objective: z
          .enum(["identify", "triage", "architecture", "functions", "symbols", "strings", "decompile", "protocol", "ipc", "behavior", "obfuscation", "clean-room", "compare", "vulnerability", "understand-behavior"])
          .optional()
          .describe("What the analysis is for. Drives the recommended workflow and the reported missing engines."),
        depth: z.enum(["quick", "standard", "deep"]).optional().describe("Analysis depth; changes the deterministic budgets."),
        dynamic: z.boolean().optional().describe("Request dynamic (instrumented) analysis. Requires an explicit authorization and is refused by default."),
        authorization: z.object(authorizationSchema).optional().describe("Authorization for a dynamic run."),
        limits: z
          .object({
            maxBytes: z.number().int().min(1).optional(),
            cpuMs: z.number().int().min(100).max(60_000).optional(),
            wallMs: z.number().int().min(100).max(300_000).optional(),
            memoryMb: z.number().int().min(16).max(4096).optional(),
            maxProcesses: z.number().int().min(0).max(16).optional(),
            network: z.enum(["none", "loopback-only", "consented"]).optional(),
          })
          .optional()
          .describe("Resource limits. These can only lower the deployment's caps, never raise them."),
        messages: z
          .array(z.object({ label: z.string().max(64).optional(), hex: z.string().max(8192).optional(), base64: z.string().max(8192).optional(), text: z.string().max(2048).optional() }))
          .max(64)
          .optional()
          .describe("Captured protocol messages, for protocol analysis."),
        sessions: z.array(z.array(z.string().max(64)).max(64)).max(64).optional().describe("Observed message-label sequences, one per session, for state-machine reconstruction."),
        opcodes: z.array(z.object({ name: z.string().max(64), code: z.number().int().min(0).max(0xffff), direction: z.string().max(32).optional() })).max(256).optional().describe("Opcodes recovered elsewhere, for protocol analysis."),
        observations: z
          .array(z.object({ id: z.string().max(64), statement: z.string().max(2000), source: z.string().max(64), location: z.string().max(128), label: evidenceLabel }))
          .max(200)
          .optional()
          .describe("Clean-room observations."),
        captures: z.array(z.object({ hex: z.string().max(8192).optional(), base64: z.string().max(8192).optional(), description: z.string().max(500), evidenceId: z.string().max(64).optional() })).max(64).optional(),
        golden: z.array(z.object({ id: z.string().max(64).optional(), description: z.string().max(500), input: z.string().max(8192), expectedOutput: z.string().max(8192).nullable().optional(), fromEvidence: z.string().max(64).nullable().optional(), inputEncoding: z.enum(["hex", "base64", "utf8"]).optional(), expectedEncoding: z.enum(["hex", "base64", "utf8"]).optional() })).max(64).optional(),
        comparisons: z.array(z.object({ id: z.string().max(64), actualOutput: z.string().max(8192), encoding: z.enum(["hex", "base64", "utf8"]).optional() })).max(64).optional(),
        purpose: z.string().max(500).optional().describe("Purpose recorded on a frozen clean-room specification."),
        struct: z.object({ fields: z.array(z.object({ name: z.string().max(64).optional(), offset: z.union([z.number(), z.string()]).optional(), size: z.union([z.number(), z.string()]).optional(), type: z.string().max(32).optional() })).max(256).optional(), total_size: z.union([z.number(), z.string()]).optional(), align: z.union([z.number(), z.string()]).optional() }).optional().describe("A recovered struct layout to validate (offset/size/total_size)."),
        evidence: z.object({ analysisId: z.string().max(128).optional(), label: evidenceLabel.optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional(), includeSuperseded: z.boolean().optional() }).optional(),
        report: z.object({ analysisId: z.string().max(128).optional(), maxChars: z.number().int().min(1000).max(100_000).optional() }).optional(),
        compare: z.object({ analysisIds: z.array(z.string().max(128)).max(4).optional() }).optional(),
      },
      annotations: { title: "Reverse Engineer", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const key = String(args.target?.url ?? args.target?.artifactId ?? args.target?.workspacePath ?? "inline");
        charge(key);
        const text = await run(args as unknown as ReverseRequest);
        return textResult(text);
      }),
  );

  /* ----------------------------------------------------------- capabilities */

  mcp.registerTool(
    "reverse_capabilities",
    {
      title: "Reverse Engineering Capabilities",
      description:
        "Which reverse-engineering engines this deployment actually has: the deterministic Worker engines, the external tools that need the optional analysis service, the current policy caps, the safety contract, and the recommended workflow for an objective. Never exposes credentials or internal URLs.",
      inputSchema: { objective: z.string().max(64).optional().describe("Optional objective, to scope the recommended workflow.") },
      annotations: { title: "Reverse Engineering Capabilities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(async () => {
        charge("capabilities");
        const response = await runReverseRequest(buildContext(ctx), { action: "capabilities", objective: args.objective ?? "understand-behavior" } as ReverseRequest);
        return textResult(JSON.stringify(response, null, 2));
      }),
  );

  /* ---------------------------------------------------------------- triage */

  mcp.registerTool(
    "reverse_triage",
    {
      title: "Reverse Engineering Triage",
      description:
        "Deterministic first pass over one target: container family, architecture, bits, endianness, entry point, sections with per-section entropy, symbol surface, imports, toolchain hints, packing assessment and the string surface. Every value is labelled with the tool that produced it. Read-only; the target is never executed.",
      inputSchema: {
        target: z.object(targetSchema),
        depth: z.enum(["quick", "standard", "deep"]).optional(),
      },
      annotations: { title: "Reverse Engineering Triage", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        charge(String(args.target?.url ?? args.target?.artifactId ?? "inline"));
        const response = await runReverseRequest(buildContext(ctx), { action: "triage", target: args.target, depth: args.depth } as ReverseRequest);
        return textResult(JSON.stringify(response, null, 2));
      }),
  );

  /* --------------------------------------------------------------- analyze */

  mcp.registerTool(
    "reverse_analyze",
    {
      title: "Reverse Engineering Analysis",
      description:
        "Run the full evidence-driven analysis for one objective: triage plus objective-specific work (protocol framing, obfuscation, comparison, clean-room). Returns findings, labelled evidence, unknowns and the engines that were missing. Static only unless `dynamic` is set, which additionally requires authorization.",
      inputSchema: {
        target: z.object(targetSchema),
        objective: z.enum(["identify", "triage", "architecture", "functions", "symbols", "strings", "decompile", "protocol", "ipc", "behavior", "obfuscation", "clean-room", "compare", "vulnerability", "understand-behavior"]).optional(),
        depth: z.enum(["quick", "standard", "deep"]).optional(),
        compareWith: z.object(targetSchema).optional(),
        messages: z.array(z.object({ label: z.string().max(64).optional(), hex: z.string().max(8192).optional(), base64: z.string().max(8192).optional(), text: z.string().max(2048).optional() })).max(64).optional(),
        sessions: z.array(z.array(z.string().max(64)).max(64)).max(64).optional(),
        opcodes: z.array(z.object({ name: z.string().max(64), code: z.number().int().min(0).max(0xffff), direction: z.string().max(32).optional() })).max(256).optional(),
        observations: z.array(z.object({ id: z.string().max(64), statement: z.string().max(2000), source: z.string().max(64), location: z.string().max(128), label: evidenceLabel })).max(200).optional(),
        purpose: z.string().max(500).optional(),
        dynamic: z.boolean().optional(),
        authorization: z.object(authorizationSchema).optional(),
      },
      annotations: { title: "Reverse Engineering Analysis", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        charge(String(args.target?.url ?? args.target?.artifactId ?? "inline"));
        const response = await runReverseRequest(buildContext(ctx), { action: "analyze", ...args } as unknown as ReverseRequest);
        return textResult(JSON.stringify(response, null, 2));
      }),
  );

  /* --------------------------------------------------------------- evidence */

  mcp.registerTool(
    "reverse_evidence",
    {
      title: "Reverse Engineering Evidence",
      description:
        "Read the labelled evidence for a stored analysis: which tool produced each claim, against which target, at which location, with what confidence, and which claims rest on a single source. Filter by label or free text.",
      inputSchema: {
        analysisId: z.string().max(128).describe("The analysis id returned by the analysis that produced the evidence."),
        label: evidenceLabel.optional(),
        query: z.string().max(200).optional().describe("Free-text match over claim, source and location."),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { title: "Reverse Engineering Evidence", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(async () => {
        charge(args.analysisId);
        const response = await runReverseRequest(buildContext(ctx), { action: "evidence", evidence: { analysisId: args.analysisId, label: args.label, query: args.query, limit: args.limit } } as ReverseRequest);
        return textResult(JSON.stringify(response, null, 2));
      }),
  );

  /* ----------------------------------------------------------------- report */

  mcp.registerTool(
    "reverse_report",
    {
      title: "Reverse Engineering Report",
      description:
        "Build the deliverable for an analysis: executive summary, triage table, architecture summary, findings grouped by evidence label, the unknowns, the artifacts and the recommended next steps. Also lists every claim that rests on a single source, so a reader knows where a second opinion is still needed.",
      inputSchema: {
        analysisId: z.string().max(128).optional().describe("Analysis to report on. Omit and pass `target` to analyse and report in one step."),
        target: z.object(targetSchema).optional(),
        maxChars: z.number().int().min(1000).max(100_000).optional(),
      },
      annotations: { title: "Reverse Engineering Report", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(async () => {
        charge(args.analysisId ?? String(args.target?.url ?? "inline"));
        const response = await runReverseRequest(buildContext(ctx), { action: "report", report: { analysisId: args.analysisId, maxChars: args.maxChars }, target: args.target } as ReverseRequest);
        return textResult(JSON.stringify(response, null, 2));
      }),
  );

  /* ---------------------------------------------------------------- compare */

  mcp.registerTool(
    "reverse_compare",
    {
      title: "Reverse Engineering Compare",
      description:
        "Compare two artifacts mechanically: hash, container, size, entropy, symbol/import/section/string overlap, and toolchain fingerprint. Reports the specific differences, not just a similarity score. A metadata comparison is not a behavioural comparison, and the result says so.",
      inputSchema: {
        target: z.object(targetSchema).optional(),
        compareWith: z.object(targetSchema).optional(),
        analysisIds: z.array(z.string().max(128)).max(4).optional().describe("Two stored analysis ids to compare instead of two targets."),
      },
      annotations: { title: "Reverse Engineering Compare", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        charge(String(args.target?.url ?? args.target?.artifactId ?? args.analysisIds?.join(",") ?? "inline"));
        const response = await runReverseRequest(buildContext(ctx), { action: "compare", target: args.target, compareWith: args.compareWith, compare: { analysisIds: args.analysisIds } } as ReverseRequest);
        return textResult(JSON.stringify(response, null, 2));
      }),
  );

}

/** The router's action list, re-exported so the capability resource stays in sync. */
export function reverseToolActions(): ReverseAction[] {
  return ["capabilities", "triage", "analyze", "protocol", "deobfuscate", "cleanroom", "evidence", "report", "compare", "dynamic"];
}
