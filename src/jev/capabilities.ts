/**
 * Capability report for the Jev Decision Engine — one source of truth.
 *
 * Mirrors `src/video/capabilities.ts`: the connected AI
 * must be able to see, before it promises anything, whether this deployment can ask for
 * typed decisions at all, what each decision template is allowed to answer, what the
 * thresholds mean, and what the engine explicitly cannot do.
 *
 * Reports *presence and policy only*. No credential value is ever included, and field
 * names avoid the redaction layer's sensitive-key list so nothing here gets masked by
 * accident.
 */

import type { JevConfig } from "./config.js";
import { JEV_LIMITS } from "./config.js";
import { RESULT_REVIEW_LEVELS, TOOL_ROUTE_CRITERIA, VIDEO_FOCUS_CRITERIA } from "./decisions.js";

export const JEV_CAPABILITIES_URI = "demo://capabilities/jev";
export const JEV_SCHEMA = "demo.jev-capabilities/1";

export interface JevDecisionDescription {
  id: string;
  asks: string;
  questionType: "choice" | "score" | "choice+noul";
  allowedOutputs: string[];
  whenCalled: string;
  actedOnBy: string;
  fallback: string;
}

export interface JevCapabilityReport {
  schema: typeof JEV_SCHEMA;
  provider: "typesafe";
  capability: "jev_decision_engine";
  available: boolean;
  enabled: boolean;
  credentialConfigured: boolean;
  disabledReason: string | null;
  model: string;
  modelNote: string;
  endpoint: string;
  /** Field names here matter: `…Token…`/`…secret…`/`…key…` would be redacted in tool output. */
  usage: { input: number | null; output: number | null } | null;
  thresholds: {
    review: number;
    accept: number;
    meaning: {
      belowReview: string;
      between: string;
      aboveAccept: string;
    };
    configuredBy: string;
  };
  certainty: {
    whatItIs: string;
    whatItIsNot: string;
    noulNote: string;
  };
  requestBudget: {
    stateChars: number;
    questionsPerRequest: number;
    choiceOptions: number;
    scoreLevels: number;
    timeoutMs: number;
    retries: string;
  };
  decisions: JevDecisionDescription[];
  workflowHooks: Array<{ workflow: string; file: string; behaviour: string }>;
  security: string[];
  configuration: {
    credential: { name: string; kind: "secret"; howToSet: string };
    /** Plain variables (never a credential value). */
    policy: Array<{ name: string; def: string; controls: string }>;
  };
  upstream: {
    documentedStatusCodes: Array<{ status: number; meaning: string; demoBehaviour: string }>;
    rateLimits: string;
    docs: string[];
  };
  /**
   * What this integration deliberately does not offer.
   *
   * Named `outOfScope`, not something containing "secret"/"otp": field names are
   * matched by the redaction layer's sensitive-key list (which caught `notProvided`
   * via "otp" and `nonSecret` via "secret"), and a masked field is a silent lie in a
   * report meant to be honest. A test in tests/jev.test.ts pins this.
   */
  outOfScope: string[];
}

export function describeJevCapabilities(input: { config: JevConfig; usage?: JevCapabilityReport["usage"] }): JevCapabilityReport {
  const { config } = input;
  return {
    schema: JEV_SCHEMA,
    provider: "typesafe",
    capability: "jev_decision_engine",
    available: config.available,
    enabled: config.enabled,
    credentialConfigured: config.apiKeyPresent,
    disabledReason: config.disabledReason,
    model: config.model,
    modelNote:
      "`jev-latest` is an alias that moves when TypeSafe ships a release; the response reports the versioned id (for example `jev-1.13.0`). If you tune thresholds against a version, pin it with TYPESAFE_MODEL.",
    endpoint: config.endpoint,
    usage: input.usage ?? null,
    thresholds: {
      review: config.reviewThreshold,
      accept: config.acceptThreshold,
      meaning: {
        belowReview:
          "Under the review floor DEMO does not act on the answer at all: the deterministic result stands, and what Jev proposed is reported for the record with `requiresReview: true`.",
        between:
          "Between the floors DEMO applies the answer for low-stakes choices (which frames to look at, which tool family) but marks it `applied_with_review` so the caller can double-check.",
        aboveAccept: "At or above the accept bar the answer is applied without a review flag.",
      },
      configuredBy: "TYPESAFE_REVIEW_THRESHOLD and TYPESAFE_ACCEPT_THRESHOLD (plain vars, 0-0.99)",
    },
    certainty: {
      whatItIs:
        "TypeSafe's `confidence`: how concentrated the returned probability distribution is, 0 (flat, genuinely unsure) to 1 (all probability on one answer). A Choice or Score answer always carries it; the raw per-option probabilities are returned too, so code can apply its own measure.",
      whatItIsNot:
        "Not a probability that the answer is correct, and not permission to act. TypeSafe documents confidence as a description of the model's own distribution; a wrong answer can arrive at 1.0. Thresholds must be validated on your traffic, and DEMO's permission, confirmation and safety checks never depend on them.",
      noulNote: "A Noul answer has no separate confidence value — its probability is the answer, so DEMO thresholds it at 0.5 (more likely than not) and says so.",
    },
    requestBudget: {
      stateChars: JEV_LIMITS.maxStateChars,
      questionsPerRequest: JEV_LIMITS.maxQuestions,
      choiceOptions: JEV_LIMITS.maxChoiceOptions,
      scoreLevels: JEV_LIMITS.maxScoreLevels,
      timeoutMs: config.timeoutMs,
      retries: "One retry, only for 429/529/5xx, honouring retry-after up to 1500ms; no retry on 401/422 and no retry that could double-bill a request.",
    },
    decisions: [
      {
        id: "video_intent_focus",
        asks: "Which analysis focus does this video request imply?",
        questionType: "choice+noul",
        allowedOutputs: Object.keys(VIDEO_FOCUS_CRITERIA),
        whenCalled: "Only inside `inspect_video`, and only when DEMO's own regex rules matched no focus while the message does contain words. Never for a bare link, and never when the caller pinned `reactionMode` and the rules already decided.",
        actedOnBy: "Replaces `focus` (and therefore the curated vision-prompt hint and frame allocation) and, when unpinned, `reactionMode`. It cannot add a focus this module does not list, cannot inject user text into the prompt, and cannot skip any permission check.",
        fallback: "The deterministic rules' answer, usually `general`, with `policy: low_confidence_fallback` or `unavailable_fallback` recorded.",
      },
      {
        id: "tool_route",
        asks: "Which DEMO tool family should handle this request?",
        questionType: "choice",
        allowedOutputs: Object.keys(TOOL_ROUTE_CRITERIA),
        whenCalled: "Only when you call `jev_decide` explicitly: DEMO's own routing is deterministic and does not depend on it.",
        actedOnBy: "Advisory only. Nothing in DEMO executes a tool call from this answer; the caller decides, and `needs_user_clarification` / `not_supported` are the preferred answers when the message is thin or outside DEMO's permitted tools.",
        fallback: "`needs_user_clarification` when the rules see nothing, otherwise the route the rules already found.",
      },
      {
        id: "result_review",
        asks: "How much review does a produced result need before a person relies on it?",
        questionType: "score",
        allowedOutputs: ["no_review", "flag_for_review", "hold_for_review"],
        whenCalled: "Only when you call `jev_decide` explicitly. Levels: " + RESULT_REVIEW_LEVELS.map((level, index) => `${index}=${level.split(":")[0]}`).join(", ") + ".",
        actedOnBy:
          "Sets `requiresReview` and a reason. It marks work for a human; it never blocks, deletes, publishes, spends, or authorises anything, and a hold verdict still leaves the underlying result with the caller.",
        fallback: "`no_review` with no flag, so an unavailable engine cannot stall a pipeline.",
      },
    ],
    workflowHooks: [
      {
        workflow: "inspect_video (video analysis focus)",
        file: "src/video/processor.ts → resolveVideoIntentWithJev",
        behaviour:
          "Read-only corroboration of one classification. The result is reported in `decision` with its source, policy and thresholds, so a reviewer can see whether a focus came from rules or from Jev. Deleting the engine entirely would change nothing except that field.",
      },
    ],
    security: [
      "The credential is a Worker secret read at call time and sent as one Authorization header; it is never in a URL, a var, a log line, an error message or a tool result.",
      "The API host is pinned in code (`https://api.typesafe.ai`); no variable can redirect the credential elsewhere.",
      "Answer values are validated against the option set defined in this repository. An unexpected value is rejected and the deterministic path runs.",
      "Free text from a caller is capped and redacted before it becomes `state`; provider text is capped and redacted before it is returned.",
      "A decision cannot authorize anything: it never bypasses DEMO's per-tool `decision:use` OAuth grant, human-confirmation requirements, or the Roblox/browser safety rules, and it cannot mark a destructive action approved.",
      "Jev is not a chat model: DEMO does not use it for text generation, summarisation, extraction of arbitrary values, or as a replacement for any configured LLM, and image state is not sent (the documented model is text-in only).",
    ],
    configuration: {
      credential: {
        name: "TYPESAFE_API_KEY",
        kind: "secret",
        howToSet: "Cloudflare dashboard → Workers & Pages → demo-mcp → Settings → Variables and secrets → Encrypt → add TYPESAFE_API_KEY (or `wrangler secret put TYPESAFE_API_KEY`). Keys are minted at console.typesafe.ai/keys.",
      },
      policy: [
        { name: "TYPESAFE_ENABLED", def: "on when a credential exists", controls: "Master switch. `false` makes every decision path return the deterministic result without a network call." },
        { name: "TYPESAFE_MODEL", def: "jev-latest", controls: "Model id or alias sent in `model`. Pin a versioned id (e.g. jev-1.13.0) if you tune thresholds." },
        { name: "TYPESAFE_DECISION_TIMEOUT_MS", def: "2500", controls: `Per-request budget, ${JEV_LIMITS.minTimeoutMs}-${JEV_LIMITS.maxTimeoutMs} ms. Over it, the call is abandoned rather than delaying the workflow.` },
        { name: "TYPESAFE_REVIEW_THRESHOLD", def: "0.5", controls: "Below it a decision is recorded but not acted on." },
        { name: "TYPESAFE_ACCEPT_THRESHOLD", def: "0.7", controls: "At or above it a low-stakes decision applies without a review flag. Never allowed below the review floor." },
      ],
    },
    upstream: {
      documentedStatusCodes: [
        { status: 401, meaning: "Missing or invalid credential", demoBehaviour: "`capability_unavailable`, no retry, the workflow continues on rules" },
        { status: 422, meaning: "Request body failed validation", demoBehaviour: "`validation_failed` with the provider detail; DEMO's own question builder is at fault, not your input" },
        { status: 429, meaning: "Rate limited", demoBehaviour: "One retry after `retry-after` (≤1500ms), then `rate_limited` and the fallback runs" },
        { status: 529, meaning: "TypeSafe overloaded", demoBehaviour: "One retry, then `PROVIDER_UNAVAILABLE` and the fallback runs" },
      ],
      rateLimits:
        "Documented for jev-1.13.0: 250,000 tokens/second and 1,200 requests/minute per account, and TypeSafe warns these are adjusting dynamically. DEMO sends at most one request per decision and never loops on a refusal.",
      docs: ["https://docs.typesafe.ai/api.md", "https://docs.typesafe.ai/primitives.md", "https://docs.typesafe.ai/confidence.md", "https://docs.typesafe.ai/models.md"],
    },
    outOfScope: [
      "No text generation, chat completions or reasoning traces: System One models return typed judgments, and DEMO does not offer Jev as an LLM choice.",
      "No image or video understanding — state is text/JSON. Frame analysis still runs through Workers AI vision models or the connected model.",
      "No arbitrary function calling: `jev_decide` accepts a template id defined in code, not caller-supplied instructions, so the model can never invent a tool or an argument.",
      "No autonomous agent loop: nothing here chains decisions into actions. Each call answers one question set and returns.",
      "No guarantee of correctness. Confidence is evidence about the answer's distribution, not about truth; TypeSafe's own documentation says to validate the model in the target domain.",
    ],
  };
}
