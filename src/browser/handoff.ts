/**
 * CAPTCHA / bot-verification human-handoff state machine.
 *
 * When Demo hits a CAPTCHA or bot-verification challenge during browser
 * automation it must stop driving the page, hand the *existing* browser session
 * to the user through Live View, and automatically pick the task back up from
 * the exact step it paused on once the challenge is gone.
 *
 * Hard safety rules, mirrored from `challenge.ts`:
 *  - Demo never solves, bypasses, spoofs or pre-empts a challenge.
 *  - The session is never rotated, never re-fingerprinted and the page is not
 *    reloaded in a loop to shake a challenge off.
 *  - Challenge contents (sitekeys, challenge payloads, user keystrokes) are
 *    never logged or persisted — only coarse vendor/signal metadata.
 *
 * This module is deliberately pure (no browser, no I/O) so the state machine,
 * the event vocabulary and the redaction rules can be unit tested on their own.
 * The browser orchestration lives in `BrowserRuntime` (`captchaHandoff*`
 * methods), which persists the record inside the session `SessionState`.
 */

/* ------------------------------------------------------------- vocabulary -- */

/**
 * Developer-facing state machine. `RUNNING → CAPTCHA_DETECTED → HUMAN_HANDOFF
 * → USER_INTERACTING → CAPTCHA_COMPLETED → RESUMING → RUNNING`, with terminal
 * error states `FAILED | TIMEOUT | CANCELLED | SESSION_LOST`.
 */
export type HandoffPhase =
  | "RUNNING"
  | "CAPTCHA_DETECTED"
  | "HUMAN_HANDOFF"
  | "USER_INTERACTING"
  | "CAPTCHA_COMPLETED"
  | "RESUMING"
  // Terminal states.
  | "FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "SESSION_LOST";

/** Structured lifecycle events (never challenge contents). */
export type HandoffEventName =
  | "captcha_detected"
  | "human_handoff_started"
  | "human_handoff_active"
  | "captcha_completed"
  | "automation_resumed"
  | "captcha_failed"
  | "captcha_timeout"
  | "human_handoff_cancelled"
  | "browser_session_lost";

export interface HandoffEvent {
  at: number;
  event: HandoffEventName;
  phase: HandoffPhase;
  /** Coarse, redaction-safe detail (counts, urls, phase names). */
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * What the caller learns from a monitor tick (`browser_captcha_wait`).
 */
export type HandoffOutcome =
  | "no_challenge"
  | "waiting_for_human"
  | "completed_and_resumed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "session_lost"
  | "no_handoff";

/** Challenge classifications that route into the human handoff. */
export const HANDOFF_TRIGGER_STATUSES = ["captcha", "bot_check"] as const;

export function isHandoffTrigger(status: string): status is (typeof HANDOFF_TRIGGER_STATUSES)[number] {
  return (HANDOFF_TRIGGER_STATUSES as readonly string[]).includes(status);
}

export const ACTIVE_PHASES: HandoffPhase[] = ["CAPTCHA_DETECTED", "HUMAN_HANDOFF", "USER_INTERACTING", "CAPTCHA_COMPLETED", "RESUMING"];
export const TERMINAL_PHASES: HandoffPhase[] = ["FAILED", "TIMEOUT", "CANCELLED", "SESSION_LOST"];

export function isTerminalPhase(phase: HandoffPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export function isActivePhase(phase: HandoffPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/**
 * Legal transitions. Active states may fall out to any terminal state at any
 * time (a dead session does not wait for a graceful point). Terminal states are
 * final; starting a new handoff replaces the whole record.
 */
const TRANSITIONS: Record<HandoffPhase, HandoffPhase[]> = {
  RUNNING: ["CAPTCHA_DETECTED"],
  CAPTCHA_DETECTED: ["HUMAN_HANDOFF", ...TERMINAL_PHASES],
  HUMAN_HANDOFF: ["USER_INTERACTING", "CAPTCHA_COMPLETED", ...TERMINAL_PHASES],
  USER_INTERACTING: ["CAPTCHA_COMPLETED", ...TERMINAL_PHASES],
  CAPTCHA_COMPLETED: ["RESUMING", ...TERMINAL_PHASES],
  RESUMING: ["RUNNING", ...TERMINAL_PHASES],
  FAILED: [],
  TIMEOUT: [],
  CANCELLED: [],
  SESSION_LOST: [],
};

export function canTransition(from: HandoffPhase, to: HandoffPhase): boolean {
  return from === to || TRANSITIONS[from]?.includes(to) === true;
}

export class HandoffTransitionError extends Error {
  constructor(from: HandoffPhase, to: HandoffPhase) {
    super(`Illegal CAPTCHA handoff transition ${from} → ${to}`);
    this.name = "HandoffTransitionError";
  }
}

/* ----------------------------------------------------------------- record -- */

/** Resumable task snapshot captured at the moment automation pauses. */
export interface ResumableTask {
  /** Caller-supplied workflow label (defaults to "browser_automation"). */
  workflow: string;
  /** Human-readable description of the exact step automation stopped on. */
  step: string;
  /** Small caller-supplied key/value context preserved across the handoff. */
  context: Record<string, string>;
  savedAt: number;
}

export interface HandoffInteractionCues {
  pageFocused: boolean;
  activeTag: string | null;
  checkedBoxes: number;
  markerCount: number;
  title: string;
  textLength: number;
}

export interface HandoffInteraction {
  detectedAt: number | null;
  cues: HandoffInteractionCues | null;
  /** Coarse reason list, e.g. ["platform-handoff-active", "dom-changed"]. */
  reasons: string[];
  eventEmitted: boolean;
  /** First time the platform reported an attached human (handoff active). */
  platformSeenAt: number | null;
}

export interface CaptchaHandoffRecord {
  phase: HandoffPhase;
  /** Monotonic counter of completed transitions (diagnostics only). */
  revision: number;
  pageId: string;
  /** URL on which the challenge was detected. */
  url: string;
  /** Live URL at the last check (may have moved during handoff). */
  currentUrl: string | null;
  vendor: string | null;
  /** Detection signal names (e.g. "google-recaptcha") — no page contents. */
  signals: string[];
  challengeStatus: string;
  confidence: number;
  detectedAt: number;
  handoffStartedAt: number | null;
  deadline: number;
  lastCheckedAt: number | null;
  liveViewUrl: string | null;
  liveViewExpiresAtMs: number | null;
  handoffId: string | null;
  instructions: string;
  screenshotUrl: string | null;
  task: ResumableTask | null;
  interaction: HandoffInteraction;
  /** Bounded structured event log. */
  events: HandoffEvent[];
  failure: { reason: string; detail: string | null } | null;
  completedAt: number | null;
  resumedAt: number | null;
  terminatedAt: number | null;
}

/** Bounds that keep the persisted record small and safe. */
export const HANDOFF_LIMITS = {
  /** One `browser_captcha_wait` call polls at most this long. */
  monitorWindowDefaultMs: 10_000,
  monitorWindowMaxMs: 30_000,
  pollIntervalMs: 1_000,
  pollIntervalMinMs: 250,
  pollIntervalMaxMs: 5_000,
  /** Overall handoff budget (`timeout_ms` on start). */
  handoffDefaultMs: 600_000,
  handoffMinMs: 5_000,
  handoffMaxMs: 1_800_000,
  maxEvents: 50,
  maxTaskContextEntries: 20,
  maxTaskContextValueChars: 200,
  maxTaskStepChars: 500,
} as const;

/** Exact user-facing notification copy required by the handoff contract. */
export const HANDOFF_USER_NOTICE = "CAPTCHA detected. Demo is paused. Please complete the verification in the live browser.";

export interface StartHandoffInput {
  pageId: string;
  url: string;
  vendor: string | null;
  signals: string[];
  challengeStatus: string;
  confidence: number;
  timeoutMs: number;
  liveViewUrl: string | null;
  liveViewExpiresAtMs: number | null;
  handoffId: string | null;
  instructions: string;
  screenshotUrl: string | null;
  task?: { workflow?: string; step?: string; context?: Record<string, string> } | null;
}

/** Sanitise + bound the caller-supplied task snapshot. */
export function normaliseTask(input: StartHandoffInput["task"], sessionId: string, pageId: string, url: string): ResumableTask {
  const context: Record<string, string> = {};
  if (input?.context) {
    for (const [key, value] of Object.entries(input.context)) {
      if (Object.keys(context).length >= HANDOFF_LIMITS.maxTaskContextEntries) break;
      if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(key)) continue;
      context[key] = String(value ?? "").slice(0, HANDOFF_LIMITS.maxTaskContextValueChars);
    }
  }
  return {
    workflow: (input?.workflow ?? "browser_automation").slice(0, 64),
    step: (input?.step ?? `paused on ${url} while a human completes the challenge; resume this tab (${pageId}) in session ${sessionId}`).slice(0, HANDOFF_LIMITS.maxTaskStepChars),
    context,
    savedAt: Date.now(),
  };
}

export function createHandoffRecord(input: StartHandoffInput, sessionId: string): CaptchaHandoffRecord {
  const now = Date.now();
  const record: CaptchaHandoffRecord = {
    phase: "RUNNING",
    revision: 0,
    pageId: input.pageId,
    url: input.url,
    currentUrl: input.url,
    vendor: input.vendor,
    signals: [...input.signals].slice(0, 12),
    challengeStatus: input.challengeStatus,
    confidence: input.confidence,
    detectedAt: now,
    handoffStartedAt: null,
    deadline: now + Math.min(Math.max(input.timeoutMs, HANDOFF_LIMITS.handoffMinMs), HANDOFF_LIMITS.handoffMaxMs),
    lastCheckedAt: null,
    liveViewUrl: input.liveViewUrl,
    liveViewExpiresAtMs: input.liveViewExpiresAtMs,
    handoffId: input.handoffId,
    instructions: input.instructions.slice(0, 4_000),
    screenshotUrl: input.screenshotUrl,
    task: normaliseTask(input.task, sessionId, input.pageId, input.url),
    interaction: { detectedAt: null, cues: null, reasons: [], eventEmitted: false, platformSeenAt: null },
    events: [],
    failure: null,
    completedAt: null,
    resumedAt: null,
    terminatedAt: null,
  };
  // The first two transitions are the detection → handoff pair.
  transition(record, "CAPTCHA_DETECTED", "captcha_detected", {
    url: input.url,
    vendor: input.vendor,
    challenge: input.challengeStatus,
  });
  transition(record, "HUMAN_HANDOFF", "human_handoff_started", {
    pageId: input.pageId,
    liveView: Boolean(input.liveViewUrl),
    handoffId: input.handoffId,
    deadline: record.deadline,
  });
  record.handoffStartedAt = now;
  return record;
}

/** Move the record to `to`, validating the transition and appending the event. */
export function transition(record: CaptchaHandoffRecord, to: HandoffPhase, event?: HandoffEventName, detail?: HandoffEvent["detail"]): HandoffEvent | null {
  if (!canTransition(record.phase, to)) throw new HandoffTransitionError(record.phase, to);
  record.phase = to;
  record.revision += 1;
  if (TERMINAL_PHASES.includes(to)) record.terminatedAt = Date.now();
  return event ? pushEvent(record, event, detail) : null;
}

export function pushEvent(record: CaptchaHandoffRecord, event: HandoffEventName, detail?: HandoffEvent["detail"]): HandoffEvent {
  const entry: HandoffEvent = { at: Date.now(), event, phase: record.phase };
  if (detail) entry.detail = detail;
  record.events.push(entry);
  if (record.events.length > HANDOFF_LIMITS.maxEvents) {
    record.events.splice(0, record.events.length - HANDOFF_LIMITS.maxEvents);
  }
  return entry;
}

/** Terminal transition helpers keep the reason wording consistent. */
export function failHandoff(record: CaptchaHandoffRecord, reason: string, event: HandoffEventName, detail?: HandoffEvent["detail"]): void {
  record.failure = { reason, detail: detail ? JSON.stringify(detail).slice(0, 500) : null };
  transition(record, event === "captcha_timeout" ? "TIMEOUT" : event === "browser_session_lost" ? "SESSION_LOST" : event === "human_handoff_cancelled" ? "CANCELLED" : "FAILED", event, detail);
}

/** True when the challenge verdict no longer blocks automation. */
export function challengeCleared(status: string): boolean {
  return status !== "captcha" && status !== "bot_check" && status !== "login_required" && status !== "consent_required";
}

/** Map a record + verdict to the outcome a monitor tick reports. */
export function outcomeFor(record: CaptchaHandoffRecord | null): HandoffOutcome {
  if (!record) return "no_handoff";
  switch (record.phase) {
    case "RUNNING":
      return record.resumedAt ? "completed_and_resumed" : "no_handoff";
    case "CAPTCHA_DETECTED":
    case "HUMAN_HANDOFF":
    case "USER_INTERACTING":
    case "CAPTCHA_COMPLETED":
    case "RESUMING":
      return "waiting_for_human";
    case "FAILED":
      return "failed";
    case "TIMEOUT":
      return "timed_out";
    case "CANCELLED":
      return "cancelled";
    case "SESSION_LOST":
      return "session_lost";
  }
}

/**
 * Tool-facing projection of the record: honest status, task context and event
 * names only — never challenge contents, page text or anything typed by the
 * human during the handoff.
 */
export function projectHandoff(record: CaptchaHandoffRecord | null, sessionId: string): {
  sessionId: string;
  active: boolean;
  phase: HandoffPhase;
  outcome: HandoffOutcome;
  pageId: string | null;
  url: string | null;
  currentUrl: string | null;
  vendor: string | null;
  signals: string[];
  challengeStatus: string | null;
  detectedAt: number | null;
  deadline: number | null;
  lastCheckedAt: number | null;
  liveViewUrl: string | null;
  handoffId: string | null;
  screenshotUrl: string | null;
  userNotice: string | null;
  task: ResumableTask | null;
  interaction: { detectedAt: number | null; reasons: string[] };
  failure: { reason: string; detail: string | null } | null;
  completedAt: number | null;
  resumedAt: number | null;
  events: HandoffEvent[];
  safetyNote: string;
} {
  if (!record) {
    return {
      sessionId,
      active: false,
      phase: "RUNNING",
      outcome: "no_handoff",
      pageId: null,
      url: null,
      currentUrl: null,
      vendor: null,
      signals: [],
      challengeStatus: null,
      detectedAt: null,
      deadline: null,
      lastCheckedAt: null,
      liveViewUrl: null,
      handoffId: null,
      screenshotUrl: null,
      userNotice: null,
      task: null,
      interaction: { detectedAt: null, reasons: [] },
      failure: null,
      completedAt: null,
      resumedAt: null,
      events: [],
      safetyNote: SAFETY_NOTE,
    };
  }
  const active = isActivePhase(record.phase);
  return {
    sessionId,
    active,
    phase: record.phase,
    outcome: outcomeFor(record),
    pageId: record.pageId,
    url: record.url,
    currentUrl: record.currentUrl,
    vendor: record.vendor,
    signals: [...record.signals],
    challengeStatus: record.challengeStatus,
    detectedAt: record.detectedAt,
    deadline: record.deadline,
    lastCheckedAt: record.lastCheckedAt,
    liveViewUrl: record.liveViewUrl,
    handoffId: record.handoffId,
    screenshotUrl: record.screenshotUrl,
    userNotice: active ? HANDOFF_USER_NOTICE : null,
    task: record.task,
    interaction: { detectedAt: record.interaction.detectedAt, reasons: [...record.interaction.reasons] },
    failure: record.failure,
    completedAt: record.completedAt,
    resumedAt: record.resumedAt,
    events: record.events.map((entry) => ({ ...entry })),
    safetyNote: SAFETY_NOTE,
  };
}

export const SAFETY_NOTE =
  "DEMO never solves, bypasses or circumvents CAPTCHAs. The human completes the challenge in the live browser session; Demo only detects, waits and resumes.";

/* ------------------------------------------------- in-page cue collection -- */

/**
 * Serialised page function (runs inside the browser via `page.evaluate`).
 * Returns coarse interaction cues only: focus, changed-DOM fingerprints and
 * challenge-marker counts. No text contents, no field values.
 */
export function collectHandoffCues(): HandoffInteractionCues {
  const doc = document;
  const body = doc.body;
  let markerCount = 0;
  const markerSelectors = [
    ".g-recaptcha",
    ".h-captcha",
    ".cf-turnstile",
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='turnstile']",
    "iframe[src*='challenges.cloudflare']",
    "[class*='captcha']",
    "[id*='captcha']",
  ];
  for (const selector of markerSelectors) {
    try {
      markerCount += doc.querySelectorAll(selector).length;
    } catch {
      /* invalid selector in this document — ignore */
    }
  }
  let checkedBoxes = 0;
  try {
    checkedBoxes = doc.querySelectorAll("input[type='checkbox']:checked").length;
  } catch {
    /* ignore */
  }
  return {
    pageFocused: typeof doc.hasFocus === "function" ? doc.hasFocus() : false,
    activeTag: doc.activeElement && doc.activeElement !== body ? doc.activeElement.tagName : null,
    checkedBoxes,
    markerCount,
    title: doc.title ?? "",
    textLength: (body?.textContent ?? "").length,
  };
}

/** Coarse fingerprint used to notice that the human is doing something. */
export function cuesFingerprint(cues: HandoffInteractionCues): string {
  return [cues.title, cues.textLength, cues.markerCount, cues.checkedBoxes, cues.activeTag ?? ""].join("|");
}

export function cuesChanged(before: HandoffInteractionCues | null, after: HandoffInteractionCues): boolean {
  if (!before) return false;
  return cuesFingerprint(before) !== cuesFingerprint(after);
}

/** Compare fresh cues against the baseline recorded at pause. */
export function detectInteraction(before: HandoffInteractionCues | null, after: HandoffInteractionCues, platformHandoffActive: boolean): { interacting: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (platformHandoffActive) reasons.push("platform-handoff-active");
  if (after.pageFocused) reasons.push("page-focused");
  if (after.activeTag && after.activeTag !== "BODY") reasons.push("element-focused");
  if (cuesChanged(before, after)) reasons.push("page-changed");
  return { interacting: reasons.length > 0, reasons };
}
