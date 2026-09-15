/**
 * Challenge detection and human-in-the-loop management.
 *
 * DEMO never solves, bypasses or pre-empts a CAPTCHA, bot check or login wall.
 * It detects them, reports an honest status, keeps the browser session alive
 * and hands the page to a human through Cloudflare Live View. Whether the
 * challenge is completed is decided by the human, never claimed by DEMO.
 */

import { BrowserError } from "../core/errors.js";
import { collectChallengeSignals, type ChallengeSignalsPayload } from "./page-scripts.js";
import type { BrowserProvider, PageHandle } from "./types.js";

export type ChallengeStatus =
  | "normal"
  | "loading"
  | "login_required"
  | "consent_required"
  | "captcha"
  | "bot_check"
  | "access_denied"
  | "unavailable"
  | "unknown";

export interface ChallengeSignals {
  url?: string;
  title?: string;
  text?: string;
  html?: string;
  status?: number | null;
  readyState?: string;
  hasPasswordField?: boolean;
  hasCaptchaWidget?: boolean;
  hasConsentBanner?: boolean;
  bodyTextLength?: number;
  iframeHosts?: string[];
}

export interface ChallengeVerdict {
  status: ChallengeStatus;
  confidence: number;
  reason: string;
  signals: string[];
  vendor?: string;
  requiresHuman: boolean;
  recommendedAction: string;
}

interface Rule {
  status: ChallengeStatus;
  weight: number;
  signal: string;
  vendor?: string;
  pattern?: RegExp;
  test?: (signals: NormalisedSignals) => boolean;
}

interface NormalisedSignals {
  haystack: string;
  url: string;
  title: string;
  text: string;
  status: number | null;
  readyState: string;
  bodyTextLength: number;
  hasPasswordField: boolean;
  hasCaptchaWidget: boolean;
  hasConsentBanner: boolean;
  iframeHosts: string[];
}

const CAPTCHA_RULES: Rule[] = [
  { status: "captcha", weight: 5, signal: "google-recaptcha", vendor: "google-recaptcha", pattern: /\b(g-?recaptcha|grecaptcha|recaptcha)\b/i },
  { status: "captcha", weight: 5, signal: "hcaptcha", vendor: "hcaptcha", pattern: /\bh-?captcha\b/i },
  { status: "captcha", weight: 5, signal: "cloudflare-turnstile", vendor: "cloudflare-turnstile", pattern: /\b(cf-?turnstile|challenges\.cloudflare\.com)\b/i },
  { status: "captcha", weight: 5, signal: "cloudflare-challenge", vendor: "cloudflare", pattern: /(__cf_chl|cf_chl_opt|cdn-cgi\/challenge|cf-browser-verification)/i },
  { status: "captcha", weight: 5, signal: "arkose-funcaptcha", vendor: "arkose", pattern: /\b(arkoselabs|funcaptcha)\b/i },
  { status: "captcha", weight: 4, signal: "perimeterx", vendor: "perimeterx", pattern: /\b(px-?captcha|perimeterx|_px(e|cid)?\b)/i },
  { status: "captcha", weight: 4, signal: "datadome", vendor: "datadome", pattern: /\b(datadome|captcha-delivery\.com)\b/i },
  { status: "captcha", weight: 4, signal: "imperva-incapsula", vendor: "imperva", pattern: /\b(incapsula|_incapsula_resource|imperva)\b/i },
  { status: "captcha", weight: 4, signal: "geetest", vendor: "geetest", pattern: /\bgeetest\b/i },
  { status: "captcha", weight: 4, signal: "generic-captcha", pattern: /\bcaptcha\b/i },
  { status: "captcha", weight: 4, signal: "captcha-widget", vendor: "unknown-captcha", test: (s) => s.hasCaptchaWidget },
  { status: "captcha", weight: 4, signal: "human-verification-copy", pattern: /(verify (that )?you('| a)?re (a )?(human|not a robot)|are you a robot|prove you'?re human|human verification)/i },
  { status: "captcha", weight: 3, signal: "image-selection-instructions", pattern: /(select all (the )?(images|squares|photos)|click (on )?(every|all) (image|square))/i },
];

const BOT_RULES: Rule[] = [
  { status: "bot_check", weight: 5, signal: "cloudflare-interstitial", vendor: "cloudflare", pattern: /(just a moment|checking your browser before accessing|attention required.{0,20}(cloudflare)?|enable javascript and cookies to continue)/i },
  { status: "bot_check", weight: 4, signal: "cloudflare-error-code", vendor: "cloudflare", pattern: /error code:\s*(10(05|09|10|15|16|20|21|23)|1015)/i },
  { status: "bot_check", weight: 4, signal: "bot-traffic-copy", pattern: /(unusual traffic|automated (traffic|requests|access)|bot (detected|traffic)|request (was )?blocked|pardon our interruption|please wait while we verify|one more step)/i },
  { status: "bot_check", weight: 3, signal: "browser-verification-copy", pattern: /(verifying you are human|ddos protection|performance & security by|ray id)/i },
];

const LOGIN_RULES: Rule[] = [
  { status: "login_required", weight: 4, signal: "login-wall-copy", pattern: /(sign in to continue|log in to continue|login required|authentication required|please (log|sign) in|you (must|need to) (be )?(logged|signed) in|sign up to continue|members only|subscribers only)/i },
  { status: "login_required", weight: 3, signal: "authwall-marker", pattern: /\b(authwall|login-?wall|login-?modal|signin-?modal)\b/i },
  { status: "login_required", weight: 3, signal: "password-field", test: (s) => s.hasPasswordField },
  {
    status: "login_required",
    weight: 3,
    signal: "login-url-and-thin-page",
    test: (s) => /\/(login|signin|sign-in|auth|session\/new|passport|i\/flow\/login)(\b|\/|\?)/i.test(s.url) && s.bodyTextLength < 4000,
  },
];

const CONSENT_RULES: Rule[] = [
  { status: "consent_required", weight: 4, signal: "consent-banner-element", test: (s) => s.hasConsentBanner },
  {
    status: "consent_required",
    weight: 3,
    signal: "consent-copy",
    pattern: /(cookie (consent|banner|preferences|policy notice)|we use cookies|accept all cookies|manage (your )?cookies|by clicking .{0,40}(agree|accept)|your privacy choices|gdpr|ccpa)/i,
  },
  { status: "consent_required", weight: 4, signal: "cmp-vendor", vendor: "cmp", pattern: /\b(onetrust|didomi|cookiebot|quantcast|trustarc|consentmanager|cookie-?consent-?(sdk|banner)|sp-message-container)\b/i },
];

const ACCESS_RULES: Rule[] = [
  { status: "access_denied", weight: 4, signal: "http-401-403", test: (s) => s.status === 401 || s.status === 403 },
  { status: "access_denied", weight: 4, signal: "access-denied-copy", pattern: /(access denied|you (do|don't|do not) have permission|not authorised|not authorized|forbidden|blocked in your (region|country)|not available in your (region|country))/i },
];

const UNAVAILABLE_RULES: Rule[] = [
  { status: "unavailable", weight: 5, signal: "http-404-410", test: (s) => s.status === 404 || s.status === 410 },
  { status: "unavailable", weight: 4, signal: "http-5xx", test: (s) => typeof s.status === "number" && s.status >= 500 },
  { status: "unavailable", weight: 3, signal: "missing-content-copy", pattern: /(page not found|this page (is|isn't|is not) available|content (is|isn't) available|video unavailable|couldn't find (this|that)|something went wrong|please try again later)/i },
];

const LOADING_RULES: Rule[] = [
  {
    status: "loading",
    weight: 2,
    signal: "document-still-loading",
    test: (s) => s.readyState !== "complete" && s.bodyTextLength < 500,
  },
  { status: "loading", weight: 3, signal: "loading-placeholder", pattern: /^\s*(loading|please wait|just a second)[\s.…!]*/i },
];

const ALL_RULES: Rule[] = [...CAPTCHA_RULES, ...BOT_RULES, ...LOGIN_RULES, ...CONSENT_RULES, ...ACCESS_RULES, ...UNAVAILABLE_RULES, ...LOADING_RULES];

const STATUS_PRIORITY: ChallengeStatus[] = ["captcha", "bot_check", "login_required", "consent_required", "access_denied", "unavailable", "loading", "unknown", "normal"];

function normalise(signals: ChallengeSignals): NormalisedSignals {
  const url = signals.url ?? "";
  const title = signals.title ?? "";
  const text = signals.text ?? "";
  const html = signals.html ?? "";
  const bodyTextLength = signals.bodyTextLength ?? text.length;
  return {
    url,
    title,
    text,
    status: signals.status ?? null,
    readyState: signals.readyState ?? "complete",
    bodyTextLength,
    hasPasswordField: Boolean(signals.hasPasswordField),
    hasCaptchaWidget: Boolean(signals.hasCaptchaWidget),
    hasConsentBanner: Boolean(signals.hasConsentBanner),
    iframeHosts: signals.iframeHosts ?? [],
    haystack: `${title}\n${text}\n${url}\n${html}`.slice(0, 400_000),
  };
}

/**
 * Pure, dependency-free classifier. Exported so it can be unit tested without
 * a browser.
 */
export function detectChallenge(input: ChallengeSignals): ChallengeVerdict {
  const signals = normalise(input);
  const matched: Array<{ rule: Rule; weight: number }> = [];

  for (const rule of ALL_RULES) {
    const hit = rule.pattern ? rule.pattern.test(signals.haystack) : Boolean(rule.test?.(signals));
    if (!hit) continue;
    let weight = rule.weight;
    if (rule.signal === "password-field" && signals.hasCaptchaWidget) weight += 1;
    if (rule.signal === "generic-captcha" && signals.hasCaptchaWidget) weight += 1;
    matched.push({ rule, weight });
  }

  if (matched.length === 0) {
    return {
      status: "normal",
      confidence: 0.2,
      reason: "No login wall, consent dialog, CAPTCHA or bot-check signals detected.",
      signals: [],
      requiresHuman: false,
      recommendedAction: "Continue automation.",
    };
  }

  matched.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return STATUS_PRIORITY.indexOf(a.rule.status) - STATUS_PRIORITY.indexOf(b.rule.status);
  });

  const best = matched[0];
  const topWeight = best.weight;
  const topStatus = best.rule.status;
  if (topStatus === "loading" && topWeight < 3) {
    return {
      status: "loading",
      confidence: 0.4,
      reason: "The page is still loading; content may not be final yet.",
      signals: matched.map((m) => m.rule.signal),
      requiresHuman: false,
      recommendedAction: "Wait for a selector or network idle (browser_wait), then read the page again.",
    };
  }
  if (topWeight < 3) {
    return {
      status: "unknown",
      confidence: 0.35,
      reason: "Weak signals detected; the page state could not be classified with confidence.",
      signals: matched.map((m) => m.rule.signal),
      requiresHuman: false,
      recommendedAction: "Take a screenshot (browser_screenshot) to inspect the page visually.",
    };
  }

  const sameStatus = matched.filter((m) => m.rule.status === topStatus);
  const vendor = sameStatus.find((m) => m.rule.vendor)?.rule.vendor;
  const confidence = Math.min(0.98, 0.45 + 0.1 * topWeight + 0.05 * (sameStatus.length - 1));

  return {
    status: topStatus,
    confidence: Number(confidence.toFixed(2)),
    reason: REASONS[topStatus],
    signals: [...new Set(sameStatus.map((m) => m.rule.signal))],
    ...(vendor ? { vendor } : {}),
    requiresHuman: topStatus === "captcha" || topStatus === "bot_check" || topStatus === "login_required" || topStatus === "consent_required",
    recommendedAction: ACTIONS[topStatus],
  };
}

const REASONS: Record<ChallengeStatus, string> = {
  normal: "The page looks like ordinary content.",
  loading: "The page is still loading.",
  login_required: "The page is asking for credentials or an authenticated session.",
  consent_required: "The page is blocked behind a cookie/consent dialog.",
  captcha: "A CAPTCHA challenge is present on the page.",
  bot_check: "An anti-bot / browser-verification interstitial is present.",
  access_denied: "The site refused to serve this page to the browser session.",
  unavailable: "The page is missing or the server returned an error.",
  unknown: "The page state could not be classified with confidence.",
};

const ACTIONS: Record<ChallengeStatus, string> = {
  normal: "Continue automation.",
  loading: "Wait (browser_wait) and re-read the page.",
  login_required: "Pause for a human: call browser_pause_for_human, sign in through the Live View URL, then browser_resume. Do not send credentials to this tool.",
  consent_required: "Dismiss the dialog (browser_click on the accept/agree button) or pause for a human with browser_pause_for_human.",
  captcha: "Pause for a human: call browser_pause_for_human, solve the CAPTCHA in the Live View URL, then browser_resume. DEMO does not solve CAPTCHAs.",
  bot_check: "Pause for a human with browser_pause_for_human. DEMO does not bypass bot protection; a human may complete the verification and then resume.",
  access_denied: "Stop. The site blocked this request; retrying with different fingerprints or proxies is not attempted by DEMO.",
  unavailable: "Verify the URL, or retry later.",
  unknown: "Capture a screenshot to inspect the page visually.",
};

export const HUMAN_STATUSES: ChallengeStatus[] = ["captcha", "bot_check", "login_required", "consent_required"];

export function isBlockingStatus(status: ChallengeStatus): boolean {
  return status === "captcha" || status === "bot_check" || status === "login_required" || status === "consent_required" || status === "access_denied";
}

/**
 * Glue between the classifier and a live page.
 */
export class ChallengeManager {
  constructor(private readonly provider: BrowserProvider) {}

  detect(signals: ChallengeSignals): ChallengeVerdict {
    return detectChallenge(signals);
  }

  /** Collect signals from the live page, then classify. */
  async inspect(page: PageHandle, collector?: (page: PageHandle) => Promise<ChallengeSignalsPayload>): Promise<ChallengeVerdict> {
    const payload = collector ? await collector(page) : await defaultSignalCollector(page);
    return detectChallenge({
      url: page.url(),
      title: payload.title ?? (await page.title().catch(() => "")) ?? "",
      text: payload.text ?? "",
      html: payload.html ?? "",
      status: payload.status ?? null,
      readyState: payload.readyState,
      hasPasswordField: payload.hasPasswordField,
      hasCaptchaWidget: payload.hasCaptchaWidget,
      hasConsentBanner: payload.hasConsentBanner,
      bodyTextLength: payload.text?.length ?? 0,
      iframeHosts: payload.iframeHosts ?? [],
    });
  }

  /** Human-readable instructions handed to the operator in Live View. */
  buildInstructions(verdict: ChallengeVerdict, url: string): string {
    const base = verdict.status === "login_required"
      ? `Sign in on ${url} using your own credentials. DEMO never receives or stores your password.`
      : verdict.status === "consent_required"
        ? `Accept or dismiss the consent/cookie dialog on ${url}.`
        : verdict.status === "bot_check"
          ? `Complete the verification shown on ${url} in this live browser.`
          : `Complete the CAPTCHA shown on ${url} in this live browser.`;
    return `${base} When finished, select Done in Live View, then call browser_resume. ${verdict.vendor ? `Detected: ${verdict.vendor}.` : ""}`.trim();
  }

  get capabilities() {
    return { liveView: this.provider.capabilities().liveView, handoff: this.provider.capabilities().handoff };
  }
}

async function defaultSignalCollector(page: PageHandle): Promise<ChallengeSignalsPayload> {
  return await page.evaluate(collectChallengeSignals);
}

export function challengeRequiredError(verdict: ChallengeVerdict, context: { url: string; sessionId?: string; pageId?: string; screenshotUrl?: string | null; liveViewUrl?: string | null }): BrowserError {
  return new BrowserError("challenge_required", `${verdict.status.replace(/_/g, " ")} — ${verdict.reason}`, {
    hint: verdict.recommendedAction,
    data: {
      challenge: {
        status: verdict.status,
        confidence: verdict.confidence,
        signals: verdict.signals,
        ...(verdict.vendor ? { vendor: verdict.vendor } : {}),
      },
      url: context.url,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.pageId ? { pageId: context.pageId } : {}),
      ...(context.screenshotUrl ? { screenshot: context.screenshotUrl } : {}),
      ...(context.liveViewUrl ? { liveViewUrl: context.liveViewUrl } : {}),
    },
  });
}
