/**
 * Normalized typed-decision representation shared by every decision provider.
 *
 * DEMO talks to *typed-decision providers*, not to general-purpose chat models.
 * A provider takes `state` plus a map of typed questions and returns typed answers
 * with probabilities. Two providers exist today:
 *
 *   DecisionProvider
 *   ├── LayaProvider   — external Laya server (LAYA_BASE_URL), System One compatible
 *   └── JevProvider    — the existing TypeSafe/Jev integration (pinned api.typesafe.ai)
 *
 * Both normalize into the types below, so the decision engine in
 * `src/jev/decisions.ts` never has to know which provider answered.
 *
 * Safety boundary (unchanged by adding providers): a provider answer can only ever
 * *select among options enumerated in code* and add review flags. It cannot
 * authorize an MCP tool, bypass a permission or confirmation, read a secret,
 * override a security policy, execute code, or create a tool call.
 */

/** Which concrete provider answered (or was asked). */
export type DecisionProviderName = "laya" | "jev";

/**
 * Deployment/per-call routing mode:
 *  - `auto` — prefer Laya when configured, fail over to Jev, then to DEMO's rules.
 *  - `laya` — only Laya; an unavailable Laya is reported, never silently faked.
 *  - `jev`  — only the existing TypeSafe/Jev path.
 */
export type DecisionRoutingMode = "auto" | "laya" | "jev";

/** The request shape we accept, mirrored on the documented `Question` union. */
export type DecisionQuestionSpec =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

/** A typed answer, provider-normalized. Noul *is* a probability (0…1). */
export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

/** Usage metadata, preserved when the provider reports it. */
export interface DecisionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}
