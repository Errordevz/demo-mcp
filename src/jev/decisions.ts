/**
 * The Jev Decision Engine: every TypeSafe question, option set and threshold in one
 * reviewable file.
 *
 * Design rules this module enforces (from the TypeSafe skill + docs, and DEMO's own
 * safety policy):
 *
 * 1. Deterministic code keeps the workflow. A Jev answer is only ever consulted where a
 *    rule could not decide, and it can only select from options enumerated here.
 * 2. Narrow questions. One judgment per question, asked together in a single request so
 *    they run in parallel (the documented "speculative fan-out" pattern); code consumes
 *    only the answers that apply.
 * 3. Typed results are validated, never trusted blindly. An option outside the allowed
 *    set is rejected by the client before it reaches this file.
 * 4. Uncertainty has a defined path. `reviewThreshold` and `acceptThreshold` decide
 *    whether an answer is acted on, and below the floor the deterministic result stands.
 * 5. **A decision never authorizes anything.** It cannot grant a permission, skip a
 *    confirmation, unlock a gated tool or make a destructive action permitted; it can
 *    only *add* review flags on top of DEMO's existing checks.
 */

import { redactText } from "../core/redact.js";
import type { DetectedIntent, IntentFocus, IntentInput } from "../video/intent.js";
import { analysisHintFor } from "../video/intent.js";
import { askJev, type JevAnswer, type JevQuestionSpec } from "./client.js";
import { resolveJevConfig, type JevConfig } from "./config.js";
import { BrowserError } from "../core/errors.js";

export interface JevDecisionContext {
  env: Record<string, unknown> | undefined;
  config?: JevConfig;
  fetchImpl?: (input: string, init?: Record<string, unknown>) => Promise<Response>;
}

export type DecisionSource = "jev" | "rules" | "explicit";
export type DecisionPolicy = "applied" | "applied_with_review" | "low_confidence_fallback" | "unavailable_fallback" | "not_applicable";

export interface DecisionOutcome {
  /** Which template produced this decision. */
  template: string;
  /** The canonical key DEMO acted on (always one of the template's allowed values). */
  decision: string;
  label: string | null;
  source: DecisionSource;
  policy: DecisionPolicy;
  /** Confidence as TypeSafe defines it: the shape of the probability distribution,
   * 0 = flat/unsure, 1 = fully concentrated. It describes the answer, not correctness. */
  certainty: number | null;
  probabilities: Record<string, number> | null;
  thresholds: { review: number; accept: number };
  requiresReview: boolean;
  reviewReason: string | null;
  /** Set when the state does not contain enough to answer honestly. */
  needsUserClarification: boolean;
  /** Set when the request falls outside what DEMO's tools support. */
  notSupported: boolean;
  /** What Jev answered when DEMO did not act on it, for transparency. */
  proposedDecision: string | null;
  note: string | null;
  model: string | null;
  /** Prompt/completion units billed by the provider. Named `input`/`output` because
   * "…Tokens" would be masked by the generic redaction layer for no good reason. */
  usage: { input: number | null; output: number | null } | null;
  attempts: number;
  stateTruncated: boolean;
}

/* ------------------------------------------------------------------ thresholds */

/**
 * A Noul carries no separate confidence field — the probability *is* the answer
 * (documented). 0.5 therefore means "more likely than not", nothing subtler.
 */
export const REACTION_NOUL_THRESHOLD = 0.5;

/* ------------------------------------------------------ template: video focus */

/**
 * Canonical mapping between DEMO's `IntentFocus` values and the option keys sent to
 * Jev. Both directions use this one object, so a Jev answer can never introduce a
 * focus value this codebase does not know.
 */
export const VIDEO_FOCUS_CRITERIA: Record<IntentFocus, string> = {
  reaction: "The user wants a natural reaction or opinion about the video rather than a report.",
  authenticity: "The user is asking whether the footage is real, staged, edited, AI-generated or misleading.",
  humor: "The user is asking whether it is funny, or sharing it as a joke or meme.",
  text_ocr: "The user wants the on-screen text, captions, subtitles or written words read out.",
  ending: "The user is asking about the final moments or how the video ends.",
  beginning: "The user is asking about the opening moments or how the video starts.",
  scary: "The user is asking about frightening, creepy or disturbing content.",
  people: "The user is asking who appears in the video.",
  game: "The user is asking which game, app or title is being shown.",
  summary: "The user wants a description or summary of what happens.",
  general: "None of the above fits: the request is open-ended or the message does not contain enough to tell.",
};

const VIDEO_FOCUS_KEYS = Object.keys(VIDEO_FOCUS_CRITERIA) as IntentFocus[];

/* --------------------------------------------------- template: tool routing */

/** DEMO's actual handler families. Anything else must come back as one of the last two. */
export const TOOL_ROUTE_CRITERIA: Record<string, string> = {
  browser_action: "Reading, opening, screenshotting or interacting with a web page needs the browser tools.",
  video_analysis: "A video or media clip should be resolved, frames extracted or content analysed.",
  roblox_account: "The request is about the signed-in user's own Roblox account (profile, inventory, linking).",
  skills_lookup: "The request is about finding, auditing or applying an agent skill.",
  utility: "A deterministic utility does it: JSON formatting, hashing, a UUID, or fetching one URL.",
  needs_user_clarification: "The message is ambiguous, missing the URL or target it clearly refers to, or could mean several different things.",
  not_supported: "The request needs an action DEMO has no permitted tool for (posting, deleting, purchasing, account changes, bypassing a wall).",
};

/* --------------------------------------------------- template: result review */

/** Ordered Score levels: index = the level number the API reports. */
export const RESULT_REVIEW_LEVELS = [
  "Nothing to check: the result states its own evidence, repeats no claim beyond it, and does not need a human before being shown.",
  "Worth a quick look: the result is usable but one part rests on an inference a person may want to confirm.",
  "Needs review before use: the result asserts something its own evidence does not support, or a limit that changes the answer was not reported.",
] as const;

/** Level index → action key. Deterministic, and the only mapping this code accepts. */
const RESULT_REVIEW_DECISIONS = ["no_review", "flag_for_review", "hold_for_review"] as const;

/* --------------------------------------------------------------- engine core */

interface AskOptions {
  template: string;
  state: unknown;
  questions: Record<string, JevQuestionSpec>;
  /** The value acted on when Jev is off, fails, or is too uncertain. */
  fallbackDecision: string;
  fallbackLabel: string | null;
  labels?: Record<string, string>;
  unmapped?: string;
}

interface EngineResult {
  outcome: DecisionOutcome;
  /** Undefined when the request failed or was skipped; the answer object otherwise. */
  answers?: Record<string, JevAnswer>;
}

function errorNote(error: unknown): string {
  if (error instanceof BrowserError) return redactText(`${error.code}: ${error.message}`, 300);
  return redactText(String(error), 300);
}

/**
 * Run one decision template against TypeSafe and apply DEMO's policy to the result.
 *
 * Never throws: every failure path returns the caller's fallback with `policy:
 * "unavailable_fallback"` and a redacted note, so a workflow can call it freely.
 */
export async function runDecision(ctx: JevDecisionContext, options: AskOptions): Promise<EngineResult> {
  const config = ctx.config ?? resolveJevConfig(ctx.env);
  const thresholds = { review: config.reviewThreshold, accept: config.acceptThreshold };
  const base = {
    template: options.template,
    thresholds,
    usage: null,
    model: null,
    attempts: 0,
    stateTruncated: false,
    proposedDecision: null,
    probabilities: null,
    certainty: null,
    needsUserClarification: false,
    notSupported: false,
    label: options.fallbackLabel,
  } satisfies Omit<DecisionOutcome, "decision" | "source" | "policy" | "requiresReview" | "reviewReason" | "note">;

  // These two flags describe what DEMO *did*, so they follow the decision that was
  // acted on — including when that is the deterministic fallback.
  const flagsFor = (decision: string) => ({ needsUserClarification: decision === "needs_user_clarification", notSupported: decision === "not_supported" });

  const fallback = (policy: DecisionPolicy, note: string | null, extra: Partial<DecisionOutcome> = {}): EngineResult => ({
    outcome: {
      ...base,
      ...flagsFor(options.fallbackDecision),
      decision: options.fallbackDecision,
      source: policy === "not_applicable" ? "explicit" : "rules",
      policy,
      requiresReview: false,
      reviewReason: null,
      note,
      ...extra,
    },
  });

  if (!config.available) return fallback("unavailable_fallback", config.disabledReason);

  let result: Awaited<ReturnType<typeof askJev>>;
  try {
    result = await askJev({
      config,
      apiKey: typeof ctx.env?.TYPESAFE_API_KEY === "string" ? ctx.env.TYPESAFE_API_KEY : "",
      state: options.state,
      questions: options.questions,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
  } catch (error) {
    return fallback("unavailable_fallback", errorNote(error));
  }

  const choice = result.answers.primary;
  if (!choice || choice.type !== "choice") {
    return fallback("unavailable_fallback", "TypeSafe did not return a Choice answer for this decision.", {
      model: result.model,
      usage: { input: result.usage.inputTokens, output: result.usage.outputTokens },
      attempts: result.attempts,
      stateTruncated: result.stateTruncated,
    });
  }

  const allowed = Object.keys(options.questions.primary?.criteria ?? {});
  const mapped = allowed.includes(choice.choice) ? choice.choice : options.unmapped ?? null;
  const identity: Record<string, unknown> = {
    model: result.model,
    usage: { input: result.usage.inputTokens, output: result.usage.outputTokens },
    attempts: result.attempts,
    stateTruncated: result.stateTruncated,
    certainty: choice.confidence,
    probabilities: choice.probabilities,
  };

  if (mapped === null) {
    // An answer outside the allowed set was already rejected by the client; this is
    // the belt-and-braces path. Report it rather than guessing.
    return fallback("low_confidence_fallback", `TypeSafe selected "${redactText(choice.choice, 40)}", which this decision does not allow.`, {
      ...identity,
      proposedDecision: choice.choice,
    });
  }

  const label = options.labels?.[mapped] ?? null;
  const verdict: Omit<DecisionOutcome, "policy" | "requiresReview" | "reviewReason"> = {
    note: null,
    ...base,
    ...identity,
    decision: mapped,
    label,
    source: "jev",
    ...flagsFor(mapped),
    proposedDecision: null,
  };

  if (choice.confidence < thresholds.review) {
    // Below the floor: do not act. Keep what Jev said visible for the reviewer.
    return {
      outcome: {
        ...verdict,
        decision: options.fallbackDecision,
        label: options.fallbackLabel,
        source: "rules",
        policy: "low_confidence_fallback",
        requiresReview: true,
        ...flagsFor(options.fallbackDecision),
        reviewReason: `TypeSafe answered ${mapped} at confidence ${choice.confidence.toFixed(2)}, below the ${thresholds.review} floor, so DEMO kept its deterministic result.`,
        proposedDecision: mapped,
        note: null,
      },
      answers: result.answers,
    };
  }

  const reviewBand = choice.confidence < thresholds.accept;
  return {
    outcome: {
      ...verdict,
      policy: reviewBand ? "applied_with_review" : "applied",
      requiresReview: reviewBand,
      reviewReason: reviewBand
        ? `Confidence ${choice.confidence.toFixed(2)} is above the floor but under the ${thresholds.accept} accept bar, so this routing is recorded for review.`
        : null,
      note: null,
    },
    answers: result.answers,
  };
}

/* --------------------------------------------------------- public templates */

/**
 * Route one natural-language request into a DEMO tool family.
 *
 * Deterministic first (the same substring rules DEMO already ships): Jev is asked only
 * when those rules see nothing, so a clear message never pays a network round-trip.
 */
export async function decideToolRoute(ctx: JevDecisionContext, request: string): Promise<DecisionOutcome> {
  const text = redactText(request, 2_000);
  const obvious = obviousRoute(text);
  const config = ctx.config ?? resolveJevConfig(ctx.env);
  if (obvious) {
    // Deterministic answer available: do not spend a request on it.
    return {
      template: "tool_route",
      decision: obvious,
      label: TOOL_ROUTE_LABELS[obvious] ?? null,
      source: "rules",
      policy: "not_applicable",
      certainty: null,
      probabilities: null,
      thresholds: { review: config.reviewThreshold, accept: config.acceptThreshold },
      requiresReview: false,
      reviewReason: null,
      needsUserClarification: false,
      notSupported: false,
      proposedDecision: null,
      note: "DEMO's own rules identified the tool family, so no decision request was sent.",
      model: null,
      usage: null,
      attempts: 0,
      stateTruncated: false,
    };
  }
  const outcome = await runDecision({ ...ctx, config }, {
    template: "tool_route",
    state: { user_message: text },
    questions: {
      primary: {
        type: "choice",
        instructions: "Which DEMO tool family should handle this user request? Judge only the request text; do not assume a capability exists.",
        criteria: TOOL_ROUTE_CRITERIA,
      },
    },
    fallbackDecision: "needs_user_clarification",
    fallbackLabel: TOOL_ROUTE_LABELS.needs_user_clarification,
    labels: TOOL_ROUTE_LABELS,
  });
  return outcome.outcome;
}

export const TOOL_ROUTE_LABELS: Record<string, string> = {
  browser_action: "browser tools",
  video_analysis: "video tools",
  roblox_account: "Roblox account tools",
  skills_lookup: "skills tools",
  utility: "utility tools",
  needs_user_clarification: "ask the user what they want",
  not_supported: "refuse: no permitted tool exists",
};

const ROUTE_RULES: Array<{ test: RegExp; route: string }> = [
  { test: /\b(video|clip|tiktok|reel|youtube|short|footage)\b/i, route: "video_analysis" },
  { test: /\b(screenshot|open (?:this|the|a) ?(?:url|page)|navigate|click|scroll|scrape|web ?page|browser)\b/i, route: "browser_action" },
  { test: /\b(my roblox|roblox account|my inventory|link (?:my )?roblox|roblox profile)\b/i, route: "roblox_account" },
  { test: /\bskill\b/i, route: "skills_lookup" },
  { test: /\b(format json|minify|hash this|sha ?256|uuid|fetch (?:this|a|the) url)\b/i, route: "utility" },
];

/** Deterministic pre-pass. Returns null when the message is genuinely ambiguous. */
function obviousRoute(text: string): string | null {
  const hits = ROUTE_RULES.filter((rule) => rule.test.test(text)).map((rule) => rule.route);
  const unique = [...new Set(hits)];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Ask whether a produced result should be reviewed before it is shown.
 *
 * A Score is used rather than a Noul because "review" has degrees, and the levels are
 * written as the three things a caller can actually do with the result. This is
 * advisory by construction: the highest level is `hold_for_review`, which marks the
 * result for a person — it never blocks, deletes or executes anything.
 */
export async function decideResultReview(ctx: JevDecisionContext, input: { result: unknown; evidence?: unknown; note?: string | null }): Promise<DecisionOutcome & { level: number; levelLabel: string }> {
  const config = ctx.config ?? resolveJevConfig(ctx.env);
  const base = {
    template: "result_review",
    thresholds: { review: config.reviewThreshold, accept: config.acceptThreshold },
    usage: null as DecisionOutcome["usage"],
    model: null,
    attempts: 0,
    stateTruncated: false,
    probabilities: null as Record<string, number> | null,
    certainty: null,
    proposedDecision: null,
    needsUserClarification: false,
    notSupported: false,
    source: "rules" as DecisionSource,
    policy: "unavailable_fallback" as DecisionPolicy,
    requiresReview: false,
    reviewReason: null,
    note: config.disabledReason,
    decision: "no_review",
    label: "no review requested",
  } satisfies DecisionOutcome & { level?: number };

  if (!config.available) return { ...base, level: 0, levelLabel: RESULT_REVIEW_LEVELS[0] };

  try {
    const result = await askJev({
      config,
      apiKey: typeof ctx.env?.TYPESAFE_API_KEY === "string" ? ctx.env.TYPESAFE_API_KEY : "",
      state: { result: input.result, ...(input.evidence !== undefined ? { evidence: input.evidence } : {}), ...(input.note ? { note: input.note } : {}) },
      questions: {
        review: {
          type: "score",
          instructions: "How much review does this result need before a person relies on it? Judge only whether the result's own stated evidence supports what it asserts, and whether unstated gaps could change the answer.",
          criteria: [...RESULT_REVIEW_LEVELS],
        },
      },
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    const answer = result.answers.review;
    if (!answer || answer.type !== "score") return { ...base, level: 0, levelLabel: RESULT_REVIEW_LEVELS[0], note: "TypeSafe returned no Score answer." };
    const level = Math.min(RESULT_REVIEW_LEVELS.length - 1, Math.max(0, Math.round(answer.score)));
    const decision = RESULT_REVIEW_DECISIONS[level];
    const uncertain = answer.confidence < config.reviewThreshold;
    return {
      ...base,
      source: "jev",
      model: result.model,
      usage: { input: result.usage.inputTokens, output: result.usage.outputTokens },
      attempts: result.attempts,
      stateTruncated: result.stateTruncated,
      certainty: answer.confidence,
      probabilities: answer.probabilities,
      decision: uncertain ? "no_review" : decision,
      label: decision === "hold_for_review" ? "hold for human review before use" : decision === "flag_for_review" ? "usable, flag the inference" : "no review requested",
      policy: uncertain ? "low_confidence_fallback" : answer.confidence < config.acceptThreshold ? "applied_with_review" : "applied",
      requiresReview: !uncertain && decision !== "no_review",
      reviewReason: uncertain
        ? `TypeSafe scored this ${level}/${RESULT_REVIEW_LEVELS.length - 1} at confidence ${answer.confidence.toFixed(2)}, under the ${config.reviewThreshold} floor, so no review flag is applied.`
        : decision === "hold_for_review"
          ? "TypeSafe recommends a person looks at this before it is used. Nothing is blocked: DEMO's own permission and confirmation checks still decide."
          : null,
      note: uncertain ? "Low-confidence review score ignored." : null,
      level: uncertain ? 0 : level,
      levelLabel: RESULT_REVIEW_LEVELS[uncertain ? 0 : level],
    };
  } catch (error) {
    return { ...base, level: 0, levelLabel: RESULT_REVIEW_LEVELS[0], note: errorNote(error) };
  }
}

/* ------------------------------------------- workflow hook: inspect_video focus */

export interface VideoIntentResolution {
  intent: DetectedIntent;
  decision: DecisionOutcome | null;
}

/**
 * The one workflow that consults Jev.
 *
 * `inspect_video` turns the user's words into an analysis focus so frame allocation and
 * the vision prompt can adapt. That mapping is a long list of regexes (see
 * `src/video/intent.ts`) — exactly the kind of fragile rule set a calibrated judgment
 * can cover. The rules still run first and still win whenever they matched; Jev is
 * asked only when they matched nothing, and its answer is accepted only for a focus this
 * module knows about and above the confidence floor.
 *
 * Returns the intent unchanged (with `decision: null`) when the caller pinned
 * `reactionMode` and the rules already decided, when the message is a bare link (no
 * text to judge), or when TypeSafe is unavailable.
 */
export async function resolveVideoIntentWithJev(ctx: JevDecisionContext, input: IntentInput, deterministic: DetectedIntent): Promise<VideoIntentResolution> {
  const hasText = Boolean(deterministic.userIntent || deterministic.question);
  const rulesDecided = deterministic.focus !== "general";
  const callerPinned = typeof input.reactionMode === "boolean";
  // Ask only in the one situation where the rules have nothing to offer: the message
  // contains words, but no focus pattern matched (which also means no reaction was
  // detected — a detected reaction already resolves the focus). A bare link, or a
  // message the regexes understood, costs nothing extra.
  if (!hasText || rulesDecided || deterministic.bareLink) {
    return { intent: deterministic, decision: null };
  }

  const config = ctx.config ?? resolveJevConfig(ctx.env);
  if (!config.available) return { intent: deterministic, decision: null };

  const questions: Record<string, JevQuestionSpec> = {
    primary: {
      type: "choice",
      instructions:
        "What kind of answer is the user asking for about this video? Judge only the message text. Choose general when the message does not say.",
      criteria: VIDEO_FOCUS_CRITERIA as unknown as Record<string, string | null>,
    },
    ...(callerPinned
      ? {}
      : {
          wants_reaction: {
            type: "noul" as const,
            instructions: "Does the message ask for the reader's own reaction or opinion rather than for information?",
            criteria: { true: "Asks for a reaction, opinion, thought or vibe check", false: "Asks for information, or says nothing about it" },
          },
        }),
  };

  const outcome = await runDecision({ ...ctx, config }, {
    template: "video_intent_focus",
    state: { user_intent: deterministic.userIntent, question: deterministic.question, regex_focus_guess: deterministic.focus },
    questions,
    fallbackDecision: deterministic.focus,
    fallbackLabel: null,
    labels: VIDEO_FOCUS_CRITERIA as unknown as Record<string, string>,
  });

  const { outcome: decision, answers } = outcome;
  const focusChoice = decision.source === "jev" ? decision.decision : decision.proposedDecision;
  const usable = decision.source === "jev" && (VIDEO_FOCUS_KEYS as string[]).includes(focusChoice ?? "");

  let intent = deterministic;
  if (usable && focusChoice && focusChoice !== deterministic.focus) {
    const focus = focusChoice as IntentFocus;
    intent = { ...deterministic, focus, analysisHint: analysisHintFor(focus) };
  }
  if (!callerPinned && usable) {
    const reaction = answers?.wants_reaction;
    if (reaction && reaction.type === "noul") {
      const wantsReaction = reaction.noul >= REACTION_NOUL_THRESHOLD;
      if (wantsReaction !== deterministic.reactionMode) {
        intent = { ...intent, reactionMode: wantsReaction, focus: wantsReaction && intent.focus === "general" ? "reaction" : intent.focus };
        intent = { ...intent, analysisHint: analysisHintFor(intent.focus) };
      }
    }
  }

  return { intent, decision };
}
