/**
 * Intent detection for the high-level `inspect_video` tool.
 *
 * The connected AI should not have to translate "react to this", "is this
 * real?" or a bare video link into low-level pipeline arguments. This module
 * maps the user's own words onto:
 *
 *  - `reactionMode`: the user wants a natural reaction rather than a report.
 *  - `focus`: which visual evidence matters most (ending, on-screen text,
 *    authenticity, …) so frame allocation and the vision prompt adapt.
 *  - `analysisHint`: a curated, bounded hint appended to the frame-grounded
 *    vision prompt. Raw user text is never injected into the prompt, so a
 *    hostile message cannot steer the vision model beyond these fixed hints.
 *
 * Everything here is pure and deterministic so it can be unit-tested without a
 * browser, network or AI binding.
 */

export type IntentFocus =
  | "reaction"
  | "authenticity"
  | "humor"
  | "text_ocr"
  | "ending"
  | "beginning"
  | "scary"
  | "people"
  | "game"
  | "summary"
  | "general";

export interface DetectedIntent {
  userIntent: string | null;
  question: string | null;
  /** True when the user asked for a reaction (or sent only the link). */
  reactionMode: boolean;
  focus: IntentFocus;
  /** Curated vision-prompt hint for the detected focus (null for general). */
  analysisHint: string | null;
  /** True when the message carried no intent/question — just the link. */
  bareLink: boolean;
}

export interface IntentInput {
  userIntent?: string | null;
  question?: string | null;
  /** Explicit override; when omitted (null/undefined) the mode is detected. */
  reactionMode?: boolean | null;
}

/** Phrases that mean "give me your natural reaction to this video". */
const REACTION_PATTERNS: RegExp[] = [
  /\breact(?:s|ed|ion|ing)?\b/i,
  /\bwhat(?:'s| is| do you|s)?\b[^.?!\n]*\bthink\b/i,
  /\bthoughts\b/i,
  /\blook(?:ed|ing)? at this\b/i,
  /\bwatch this\b/i,
  /\bcheck this(?: out)?\b/i,
  /\b(?:rate|rating)\b[^.?!\n]*\bvibe\b|\bvibe\b[^.?!\n]*\b(?:check|rate)\b|\brate the vibe\b/i,
  /\bopinion\b/i,
  /\bhot take\b/i,
  /\bwhat do you make of\b/i,
  /[💀😭🤣😂😳🔥👀🎥🍿]/u,
];

/** Focus rules, most specific first. Applied to userIntent + question. */
const FOCUS_RULES: Array<{ focus: IntentFocus; test: RegExp }> = [
  {
    focus: "text_ocr",
    test: /\b(?:what does the (?:text|caption|sign|title|subtitle)s? say|read the text|on-?screen text|\bocr\b|subtitles?|captions?|what(?:'s| is) written|what does it say|transcribe the text)\b/i,
  },
  {
    focus: "ending",
    test: /\b(?:at the (?:very )?end|the ending|how does it end|final (?:part|scene|frame|seconds?|moments?)|last (?:part|scene|frame|seconds?|moments?)|end of the (?:video|clip)|what happens at the end)\b/i,
  },
  {
    focus: "beginning",
    test: /\b(?:at the (?:start|beginning)|how does it (?:start|begin)|opening (?:scene|shot|moments?)|first (?:part|scene|frame|seconds?))\b/i,
  },
  {
    focus: "authenticity",
    test: /\b(?:is (?:this|it|that) (?:real|fake|staged|cgi|ai(?:-generated)?|edited)|real or (?:fake|staged|ai)|authentic(?:ity)?|deep ?fake|\bedited\b|\bspliced\b|\bmanipulated\b|is this footage real)\b/i,
  },
  {
    focus: "scary",
    test: /\b(?:scary|scared|creepy|disturbing|unsettling|horror|terrifying|paranormal|ghost|haunted)\b/i,
  },
  {
    focus: "game",
    test: /\b(?:(?:what|which) (?:game|app|title)\b|gameplay|playthrough|what is this playing)\b/i,
  },
  {
    focus: "people",
    test: /\b(?:who(?:'s| is| are)? (?:this|that|in|the|she|he)|which person|identify|celebrity)\b/i,
  },
  {
    focus: "humor",
    test: /\b(?:funny|hilarious|laugh(?:ing|ed)?|lmao|lol|meme|joke|comedic|is this funny)\b/i,
  },
  {
    focus: "summary",
    test: /\b(?:summar(?:y|ize|ise)|explain|what happens|what(?:'s| is) happening|describe|walk me through|break ?(?:it |this )?down|tell me about|recap)\b/i,
  },
];

/** Curated per-focus hints appended to the frame-grounded vision prompt. */
const FOCUS_HINTS: Record<IntentFocus, string | null> = {
  text_ocr: "Transcribe any visible on-screen text exactly as rendered (captions, signs, UI labels, watermarks).",
  ending: "Pay special attention to the final moments and any sudden change near the end.",
  beginning: "Pay special attention to the opening moments and how the scene starts.",
  authenticity:
    "Focus on visible evidence of staging or editing: cuts, splices, watermarks, overlays, shadows, reflections, compression artifacts, and inconsistencies between frames.",
  scary: "Note atmosphere, lighting, and any disturbing, sudden, or unsettling visual events.",
  game: "Note UI elements, HUD, logos, characters, and gameplay visuals that could identify the game.",
  people: "Describe visible people neutrally (position, clothing, actions) without guessing identities.",
  humor: "Focus on tone and anything visually funny, absurd, or surprising.",
  summary: "Describe the visible events chronologically, frame by frame.",
  reaction: "Focus on tone, surprise, and the most visually striking or emotionally salient moments.",
  general: null,
};

const MAX_INTENT_CHARS = 2_000;

function boundedText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_INTENT_CHARS);
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Detect reaction mode and analysis focus from the user's own message.
 *
 * Rules:
 *  - an explicit `reactionMode` boolean always wins;
 *  - a bare link (no userIntent and no question) implies a reaction request;
 *  - otherwise reaction phrases ("react", "what do you think", "look at this",
 *    "rate the vibe", 💀-style emoji, …) enable reaction mode;
 *  - the focus is the first matching rule over userIntent + question.
 */
export function detectVideoIntent(input: IntentInput = {}): DetectedIntent {
  const userIntent = boundedText(input.userIntent);
  const question = boundedText(input.question);
  const combined = [userIntent, question].filter(Boolean).join("\n");
  const bareLink = !userIntent && !question;

  const detectedReaction = bareLink || matchesAny(combined, REACTION_PATTERNS);
  const reactionMode = typeof input.reactionMode === "boolean" ? input.reactionMode : detectedReaction;

  let focus: IntentFocus = "general";
  for (const rule of FOCUS_RULES) {
    if (rule.test.test(combined)) {
      focus = rule.focus;
      break;
    }
  }
  if (focus === "general" && reactionMode) focus = "reaction";

  return {
    userIntent,
    question,
    reactionMode,
    focus,
    analysisHint: FOCUS_HINTS[focus],
    bareLink,
  };
}
