/**
 * MCP surface for the Jev Decision Engine.
 *
 * Two tools, and neither one acts on the answer for you:
 *
 *  - `jev_decide` — ask one of the decision templates defined in `src/jev/decisions.ts`.
 *    The question set, the allowed answers and the thresholds live in code, so a caller
 *    cannot turn this into a generic oracle or a function-calling channel.
 *  - `jev_capabilities` — what this deployment can decide, with what model, under which
 *    limits, and what the engine is explicitly not allowed to do.
 *
 * `jev_decide` spends a paid API call, so it requires a short-lived, user-bound DEMO
 * OAuth grant. `jev_capabilities` is free and remains public.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { textResult, type ToolResult } from "./results.js";
import { redactValue, safeLog } from "../core/redact.js";
import { requireMcpScope } from "../auth/tool-auth.js";
import { resolveJevConfig } from "../jev/config.js";
import { decideResultReview, decideToolRoute, resolveVideoIntentWithJev, RESULT_REVIEW_LEVELS, VIDEO_FOCUS_CRITERIA, type DecisionOutcome, type JevDecisionContext } from "../jev/decisions.js";
import { resolveDecisionRoutingMode } from "../decisions/provider.js";
import { DECISION_ROUTING_MODES } from "../decisions/provider.js";
import type { DecisionRoutingMode } from "../decisions/types.js";
import { detectVideoIntent } from "../video/intent.js";
import { describeJevCapabilities, JEV_CAPABILITIES_URI, JEV_SCHEMA } from "../jev/capabilities.js";
import { listJevModels } from "../jev/client.js";

export const JEV_TOOL_NAMES = ["jev_decide", "jev_capabilities"] as const;
export type JevToolName = (typeof JEV_TOOL_NAMES)[number];

export const JEV_DECISION_TEMPLATES = ["tool_route", "video_intent_focus", "result_review"] as const;

export interface JevToolContext {
  env: Record<string, unknown>;
  requestUrl?: string | null;
  /** Optional request credential for private tools, never required by the transport. */
  authorization?: string | null;
}

function jevContext(ctx: JevToolContext, mode?: DecisionRoutingMode): JevDecisionContext {
  return { env: ctx.env, ...(mode ? { mode } : {}) };
}

async function run(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(redactValue(await work()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code ?? "internal";
    safeLog("warn", "jev-tool-error", { code, message }, "jev");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: code,
              message,
              ...((error as { hint?: string })?.hint ? { hint: (error as { hint: string }).hint } : {}),
              retryable: Boolean((error as { retryable?: boolean })?.retryable),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}

/** Everything a caller needs to know about how a decision was produced, verbatim. */
function decisionPayload(outcome: DecisionOutcome, extra: Record<string, unknown> = {}) {
  return {
    ...outcome,
    authority: "advisory",
    authorityNote:
      "A decision can select among DEMO's predefined options and add a review flag. It cannot grant a permission, skip a confirmation, authorise a write or destructive action, or override any check in this repository — and confidence describes the model's answer, not its correctness.",
    ...extra,
  };
}

export function registerJevTools(mcp: McpServer, ctx: JevToolContext): void {
  mcp.registerTool(
    "jev_decide",
    {
      title: "Ask Jev for a Typed Decision",
      description:
        "Run one of DEMO's predefined typed-decision templates (TypeSafe/Jev and/or Laya, per the provider argument and DECISION_PROVIDER_MODE) over the text you supply and return the typed answer with its probabilities, confidence and how DEMO's policy treated it. Choices are limited to the options in code: this is a judgment primitive, not a chat model, and it cannot call tools or authorize anything. This tool can incur paid provider usage and requires the user-bound DEMO OAuth scope decision:use. Returns the deterministic fallback with policy `unavailable_fallback` when no provider is configured or every provider fails.",
      annotations: {
        title: "Ask Jev for a Typed Decision",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        decision: z.enum(JEV_DECISION_TEMPLATES).describe(
          `Which judgment to ask for. tool_route: pick a DEMO tool family. video_intent_focus: which analysis focus a video request implies (options: ${Object.keys(VIDEO_FOCUS_CRITERIA).join(", ")}). result_review: how much review a produced result needs.`,
        ),
        request: z.string().max(4_000).optional().describe("The user's own words. Required for tool_route and video_intent_focus. Capped and redacted before it leaves the Worker; never sent as an instruction, only as state."),
        result: z.string().max(4_000).optional().describe("For result_review: the result text or JSON a person would otherwise have to skim."),
        evidence: z.string().max(4_000).optional().describe("For result_review: the evidence the result claims to rest on, so the judgment can compare the two."),
        provider: z.enum(DECISION_ROUTING_MODES).optional().describe(
          "Which typed-decision provider to ask. auto (default): Laya first when configured, then Jev, then the deterministic fallback. laya: only the external Laya server — an unavailable Laya is reported, never faked. jev: only the existing TypeSafe/Jev integration. Overrides DECISION_PROVIDER_MODE for this call.",
        ),
      },
    },
    async ({ decision, request, result, evidence, provider }) => {
      const auth = await requireMcpScope(ctx, "jev_decide", "decision:use");
      if (!auth.ok) return auth.result;
      return run(async () => {
        const jev = jevContext(ctx, provider);
        const config = resolveJevConfig(ctx.env);
        const routingExtra = {
          requestedProvider: provider ?? "auto",
          effectiveRoutingMode: resolveDecisionRoutingMode(ctx.env, provider ?? null),
        };
        if (decision === "result_review") {
          if (!result) throw new Error("result is required for the result_review decision.");
          const outcome = await decideResultReview(jev, {
            result: redactValue(result),
            ...(evidence ? { evidence: redactValue(evidence) } : {}),
            ...(request ? { note: request } : {}),
          });
          return decisionPayload(outcome, {
            decisionTemplate: "result_review",
            ...routingExtra,
            thresholdsNote: `Levels 0-${RESULT_REVIEW_LEVELS.length - 1} map to ${["no_review", "flag_for_review", "hold_for_review"].join(" / ")}. A hold never blocks anything: it reports that a person should look.`,
          });
        }
        if (!request) throw new Error("request is required for the tool_route and video_intent_focus decisions.");
        if (decision === "video_intent_focus") {
          const deterministic = detectVideoIntent({ userIntent: request });
          const resolved = await resolveVideoIntentWithJev(jev, { userIntent: request }, deterministic);
          return decisionPayload(resolved.decision ?? noDecision(config, "video_intent_focus"), {
            decisionTemplate: "video_intent_focus",
            ...routingExtra,
            rulesFocus: deterministic.focus,
            resolvedFocus: resolved.intent.focus,
            resolvedReactionMode: resolved.intent.reactionMode,
            analysisHint: resolved.intent.analysisHint,
          });
        }
        const outcome = await decideToolRoute(jev, request);
        return decisionPayload(outcome, { decisionTemplate: "tool_route", ...routingExtra, suggestedToolFamilies: outcome.notSupported ? [] : [outcome.decision] });
      });
    },
  );

  mcp.registerResource(
    "jev_capabilities",
    JEV_CAPABILITIES_URI,
    {
      title: "DEMO Jev Decision Engine Capabilities",
      description:
        "Whether this deployment can ask TypeSafe/Jev for typed decisions, the model and thresholds in force, every decision template with its allowed answers, when DEMO calls it and what it falls back to, and an explicit list of what the engine must never do. Read this before promising a decision-driven behaviour; it reports configuration presence only and no credential.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(jevCapabilitiesReport(ctx.env), null, 2) }],
    }),
  );

  mcp.registerTool(
    "jev_capabilities",
    {
      title: "Jev Decision Engine Capabilities",
      description:
        "Report whether this deployment can ask TypeSafe/Jev for typed decisions, which model and thresholds it uses, every decision template with its allowed answers and fallback, and what the engine must never do. Configuration presence only — no credential value. Also available as the demo://capabilities/jev resource and as flags in demo_ping, /health and /platform/stats.",
      annotations: { title: "Jev Decision Engine Capabilities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const config = resolveJevConfig(ctx.env);
        const models = await listJevModels(config, String(ctx.env.TYPESAFE_API_KEY ?? ""), undefined);
        return {
          ...describeJevCapabilities({ config }),
          ...(models?.length ? { accountModels: models } : {}),
          resources: [JEV_CAPABILITIES_URI],
        };
      }),
  );
}

function noDecision(config: ReturnType<typeof resolveJevConfig>, template: string): DecisionOutcome {
  return {
    template,
    decision: "general",
    label: null,
    source: "rules",
    policy: "unavailable_fallback",
    certainty: null,
    probabilities: null,
    thresholds: { review: config.reviewThreshold, accept: config.acceptThreshold },
    requiresReview: false,
    reviewReason: null,
    needsUserClarification: false,
    notSupported: false,
    proposedDecision: null,
    note: config.disabledReason,
    model: null,
    usage: null,
    attempts: 0,
    stateTruncated: false,
  };
}

/**
 * Shared capability report for the MCP resource, `/capabilities/jev` and the
 * inspector surfaces. Synchronous and credential-free by construction.
 */
export function jevCapabilitiesReport(env: Record<string, unknown> | undefined) {
  return describeJevCapabilities({ config: resolveJevConfig(env) });
}

export { JEV_CAPABILITIES_URI, JEV_SCHEMA };
