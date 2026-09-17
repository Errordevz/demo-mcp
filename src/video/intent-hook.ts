/**
 * Safe application of an injected decision hook.
 *
 * The video pipeline must never depend on a third-party decision service: this helper
 * is the only place the hook is awaited, it treats every provider outcome — a throw, a
 * missing field, an unknown focus, a non-object record — as "keep the deterministic
 * intent", and it returns the refined intent only when the shape is exactly what
 * `src/video/intent.ts` produces.
 */

import type { DetectedIntent, IntentFocus, IntentInput } from "./intent.js";
import { FOCUS_VALUES, analysisHintFor } from "./intent.js";
import type { IntentDecisionHook, IntentDecisionRecord } from "./types.js";

export interface IntentHookOutcome {
  intent: DetectedIntent;
  decision: IntentDecisionRecord | null;
}

export async function applyIntentHook(hook: IntentDecisionHook | null, input: IntentInput, deterministic: DetectedIntent): Promise<IntentHookOutcome> {
  if (!hook) return { intent: deterministic, decision: null };
  try {
    const resolved = await hook(input, deterministic);
    const candidate = resolved?.intent as Partial<DetectedIntent> | undefined;
    const focus = candidate?.focus;
    // A focus outside the curated set is rejected outright: it would otherwise let a
    // provider response steer the vision prompt. The hint is never taken from the hook
    // at all — it is recomputed from the accepted focus, so only our own curated
    // strings can reach the prompt.
    if (typeof focus !== "string" || !FOCUS_VALUES.includes(focus as IntentFocus)) return { intent: deterministic, decision: null };
    const reactionMode = typeof candidate?.reactionMode === "boolean" ? candidate.reactionMode : deterministic.reactionMode;
    const decision = resolved?.decision && typeof resolved.decision === "object" ? (resolved.decision as IntentDecisionRecord) : null;
    return {
      intent: { ...deterministic, focus: focus as IntentFocus, reactionMode, analysisHint: analysisHintFor(focus as IntentFocus) },
      decision,
    };
  } catch {
    return { intent: deterministic, decision: null };
  }
}
