/**
 * /jev command — JEV collaboration.
 *
 * This is the dedicated JEV collaboration command. It reuses the EXISTING
 * JEV / TypeSafe integration and does not create another JEV engine.
 *
 * Flow:
 *   User → /jev <task> → Demo gathers relevant context → JEV analyzes → Demo returns result
 *
 * Only the minimum relevant context is sent to JEV. No secrets, credentials,
 * or private infrastructure information is forwarded.
 */

import { textResult, errorResult, type ToolResult } from "../mcp/results.js";
import { redactValue, safeLog } from "../core/redact.js";
import { resolveJevConfig } from "../jev/config.js";
import { decideToolRoute, decideResultReview } from "../jev/decisions.js";
import type { CommandHandler } from "./router.js";

export function createJevCommand(): CommandHandler {
  return {
    name: "jev",
    description: "Collaborate with JEV on the current task.",
    execute: async (args, env) => {
      const config = resolveJevConfig(env);

      if (!config.available) {
        return errorResult(
          JSON.stringify(
            {
              error: "jev_unavailable",
              message: "JEV decision engine is not available on this deployment.",
              hint: config.disabledReason ?? "Set the TYPESAFE_API_KEY secret on this Worker to enable JEV collaboration.",
              retryable: false,
              demo_contribution: "Demo's own deterministic rules are still active. JEV enhances decision-making when configured.",
            },
            null,
            2,
          ),
        );
      }

      if (!args || !args.trim()) {
        return textResult({
          command: "/jev",
          message: "JEV collaboration is available. Provide a task or question.",
          usage: [
            "/jev analyze this",
            "/jev help me decide",
            "/jev collaborate on this",
            "/jev inspect this result",
          ],
          available_templates: ["tool_route", "video_intent_focus", "result_review"],
          note: "JEV provides typed decisions, not free-form text. It answers predefined question types with probabilities.",
          jev_status: {
            available: true,
            model: config.model,
            review_threshold: config.reviewThreshold,
            accept_threshold: config.acceptThreshold,
          },
          demo_note: "Demo gathers the relevant context and forwards only what JEV needs. No secrets or credentials are sent.",
        });
      }

      const userMessage = args.trim().slice(0, 4_000);

      try {
        // Route the user's message to determine which JEV decision template to use
        const routeResult = await decideToolRoute({ env }, userMessage);

        // If the route suggests result_review, try that instead
        let result: Record<string, unknown>;

        if (routeResult.decision === "needs_user_clarification" || routeResult.notSupported) {
          // Fall back to a general tool_route analysis with the user's message
          result = {
            command: "/jev",
            success: true,
            user_input: redactValue(userMessage),
            jev_analysis: routeResult,
            source: "jev",
            demo_context: {
              version: String(env.DEMO_VERSION ?? "1.0.0"),
              note: "Demo forwarded the minimum relevant context to JEV. No secrets, credentials, or infrastructure details were included.",
            },
          };
        } else {
          result = {
            command: "/jev",
            success: true,
            user_input: redactValue(userMessage),
            jev_route: routeResult.decision,
            jev_label: routeResult.label,
            jev_certainty: routeResult.certainty,
            jev_source: routeResult.source,
            jev_model: routeResult.model,
            thresholds: {
              review: config.reviewThreshold,
              accept: config.acceptThreshold,
            },
            source: "jev",
            demo_context: {
              version: String(env.DEMO_VERSION ?? "1.0.0"),
              note: "Demo forwarded the minimum relevant context to JEV. No secrets, credentials, or infrastructure details were included.",
            },
          };
        }

        return textResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        safeLog("warn", "jev-command-error", { message }, "jev");
        return errorResult(
          JSON.stringify(
            {
              error: "jev_failed",
              message: "JEV collaboration failed.",
              detail: message.slice(0, 500),
              retryable: true,
              demo_note: "Demo's own processing is still available. JEV is an advisory layer.",
            },
            null,
            2,
          ),
        );
      }
    },
  };
}
