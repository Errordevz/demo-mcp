/**
 * Page-level operations shared by the session runtime (Durable Object) and the
 * one-shot legacy helpers. Everything here is transport agnostic: it only talks
 * to a `PageHandle`.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp, clampTimeout } from "../core/limits.js";
import { safeLog } from "../core/redact.js";
import { ChallengeManager, type ChallengeVerdict } from "./challenge.js";
import {
  annotateInteractive,
  collectPageState,
  collectChallengeSignals,
  type InteractiveElement,
  type PageStatePayload,
} from "./page-scripts.js";
import type { ScreenshotManager, StoredImage } from "./screenshot.js";
import { flattenAxTree, renderInteractiveSnapshot } from "./snapshot.js";
import type { ElementTarget, PageHandle, ScreenshotType, WaitUntil } from "./types.js";
import type { MediaInspector } from "./media.js";

export interface ManagerContext {
  screenshots: ScreenshotManager;
  challenge: ChallengeManager;
  media: MediaInspector;
}

/* ------------------------------------------------------------------ open -- */

export interface OpenOptions {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
  /** Extra settle time after the navigation event fires (dynamic pages). */
  settleMs?: number;
  /** Re-check once when the first look says the page is still loading. */
  recheckLoading?: boolean;
}

export interface OpenResult {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  redirected: boolean;
  title: string;
  durationMs: number;
  challenge: ChallengeVerdict;
  page: {
    readyState: string;
    textLength: number;
    linkCount: number;
    interactiveCount: number;
    videoCount: number;
    documentHeight: number;
  };
}

export async function openUrl(page: PageHandle, url: string, options: OpenOptions, ctx: ManagerContext): Promise<OpenResult> {
  const navigation = await page.goto(url, {
    waitUntil: options.waitUntil ?? "domcontentloaded",
    timeoutMs: clampTimeout(options.timeoutMs, LIMITS.navigationTimeoutDefaultMs, LIMITS.navigationTimeoutMaxMs),
  });
  await settle(options.settleMs ?? 750);

  let verdict = await ctx.challenge.inspect(page);
  if (options.recheckLoading !== false && (verdict.status === "loading" || verdict.confidence < 0.4)) {
    await settle(1_500);
    verdict = await ctx.challenge.inspect(page);
  }

  const state = await page.evaluate(collectPageState, {
    maxTextChars: 4_000,
    maxLinks: 0,
    includeHtml: false,
    maxHtmlChars: 0,
    maxInteractive: 0,
    maxHeadings: 0,
    maxJsonLd: 0,
    maxRawStateChars: 0,
    selector: null,
  });

  return {
    requestedUrl: url,
    finalUrl: navigation.finalUrl || page.url(),
    status: navigation.status,
    redirected: navigation.redirected,
    title: navigation.title || state.title,
    durationMs: navigation.durationMs,
    challenge: verdict,
    page: {
      readyState: state.readyState,
      textLength: state.textLength,
      linkCount: state.links.length,
      interactiveCount: state.interactive.length,
      videoCount: state.media.videoCount,
      documentHeight: state.scroll.documentHeight,
    },
  };
}

/* ------------------------------------------------------------ screenshot -- */

export interface CaptureOptions {
  type?: ScreenshotType;
  fullPage?: boolean;
  selector?: string | null;
  clip?: { x: number; y: number; width: number; height: number } | null;
  inline?: boolean;
  quality?: number;
  maxHeightPx?: number;
}

export interface CaptureResult {
  image: StoredImage;
  url: string;
  title: string;
  capturedAt: string;
  fullPage: boolean;
  truncatedToViewport: boolean;
  width: number;
  height: number;
  selector: string | null;
  inlineData: string | null;
}

export async function captureScreenshot(page: PageHandle, options: CaptureOptions, ctx: ManagerContext): Promise<CaptureResult> {
  const type: ScreenshotType = options.type ?? "png";
  const selector = options.selector ?? null;
  let clip = options.clip ?? null;
  let fullPage = Boolean(options.fullPage) && !clip;
  let truncatedToViewport = false;

  if (selector) {
    await page.waitForSelector(selector, 20_000, { visible: true });
    const rect = await elementRect(page, selector);
    if (!rect) throw new BrowserError("element_not_found", `Element "${selector}" has no visible box to capture.`);
    clip = rect;
    fullPage = false;
  }

  if (fullPage) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const maxHeight = options.maxHeightPx ?? LIMITS.fullPageMaxHeightPx;
    if (typeof height === "number" && height > maxHeight) {
      fullPage = false;
      truncatedToViewport = true;
      safeLog("warn", "full-page-truncated", { height, maxHeight });
    }
  }

  const bytes = await page.screenshot({
    type,
    fullPage,
    ...(clip ? { clip } : {}),
    ...(options.quality !== undefined && type !== "png" ? { quality: options.quality } : {}),
  });
  const image = await ctx.screenshots.store(bytes, type, {
    source: selector ? "browser_screenshot:selector" : fullPage ? "browser_screenshot:full" : "browser_screenshot:viewport",
    url: page.url(),
    title: await page.title(),
    fullPage,
    ...(selector ? { selector } : {}),
  });

  const size = clip ? { width: Math.round(clip.width), height: Math.round(clip.height) } : await viewportSize(page);
  return {
    image,
    url: page.url(),
    title: await page.title(),
    capturedAt: new Date().toISOString(),
    fullPage,
    truncatedToViewport,
    width: size.width,
    height: size.height,
    selector,
    inlineData: options.inline ? await inlineOrNull(bytes, type) : null,
  };
}

async function inlineOrNull(bytes: Uint8Array, type: ScreenshotType): Promise<string | null> {
  if (bytes.byteLength > LIMITS.inlineImageMaxBytes) return null;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function elementRect(page: PageHandle, selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.evaluate((sel: string) => {
    const element = document.querySelector(sel);
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    return {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.min(Math.ceil(box.width), window.innerWidth),
      height: Math.min(Math.ceil(box.height), window.innerHeight),
    };
  }, selector);
}

async function viewportSize(page: PageHandle): Promise<{ width: number; height: number }> {
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  return { width: Math.round(size.width ?? 0), height: Math.round(size.height ?? 0) };
}

/* ------------------------------------------------------------------ read -- */

export interface ReadOptions {
  selector?: string | null;
  maxTextChars?: number;
  maxLinks?: number;
  includeHtml?: boolean;
  format?: "text" | "structured" | "both";
}

export interface ReadResult {
  url: string;
  title: string;
  selector: string | null;
  selectorMatched: boolean;
  text: string;
  textLength: number;
  truncatedText: boolean;
  html: string | null;
  metadata: Record<string, string>;
  links: Array<{ text: string; href: string }>;
  headings: string[];
  interactive: InteractiveElement[];
  forms: { count: number; passwordFields: number; fileInputs: number };
  media: { videoCount: number; audioCount: number; imageCount: number; canvasCount: number };
  scroll: { x: number; y: number; viewportWidth: number; viewportHeight: number; documentWidth: number; documentHeight: number };
  challenge: ChallengeVerdict;
}

export async function readPage(page: PageHandle, options: ReadOptions, ctx: ManagerContext): Promise<ReadResult> {
  const maxTextChars = clamp(options.maxTextChars ?? LIMITS.maxReadTextChars, 200, LIMITS.maxTextChars);
  const payload: PageStatePayload = await page.evaluate(collectPageState, {
    maxTextChars,
    maxLinks: clamp(options.maxLinks ?? LIMITS.maxLinks, 0, LIMITS.maxLinks),
    includeHtml: Boolean(options.includeHtml),
    maxHtmlChars: LIMITS.maxHtmlChars,
    maxInteractive: LIMITS.maxInteractiveElements,
    maxHeadings: 30,
    maxJsonLd: 0,
    maxRawStateChars: 0,
    selector: options.selector ?? null,
  });
  const verdict = await ctx.challenge.inspect(page, async () => {
    const signals = await page.evaluate(collectChallengeSignals);
    return { ...signals, html: "" };
  });

  return {
    url: payload.url,
    title: payload.title,
    selector: payload.selector,
    selectorMatched: payload.selectorMatched,
    text: payload.text,
    textLength: payload.textLength,
    truncatedText: payload.textLength > payload.text.length,
    html: payload.html,
    metadata: payload.meta,
    links: payload.links,
    headings: payload.headings,
    interactive: payload.interactive,
    forms: payload.forms,
    media: payload.media,
    scroll: payload.scroll,
    challenge: verdict,
  };
}

/* -------------------------------------------------------------- snapshot -- */

export interface SnapshotOptions {
  mode?: "interactive" | "accessibility" | "both";
  maxNodes?: number;
  maxElements?: number;
  resetRefs?: boolean;
}

export interface SnapshotResultPayload {
  url: string;
  title: string;
  mode: string;
  text: string;
  nodes: Array<{ depth: number; role: string; name: string; value?: string; states: string[] }>;
  elements: InteractiveElement[];
  truncated: boolean;
  note: string;
}

export async function snapshotPage(page: PageHandle, options: SnapshotOptions): Promise<SnapshotResultPayload> {
  const mode = options.mode ?? "interactive";
  const blocks: string[] = [];
  let nodes: Array<{ depth: number; role: string; name: string; value?: string; states: string[] }> = [];
  let elements: InteractiveElement[] = [];
  let truncated = false;

  if (mode === "interactive" || mode === "both") {
    elements = await page.evaluate(annotateInteractive, {
      maxElements: clamp(options.maxElements ?? LIMITS.maxInteractiveElements, 1, LIMITS.maxInteractiveElements),
      reset: options.resetRefs !== false,
    });
    const rendered = renderInteractiveSnapshot(elements);
    blocks.push(`# Interactive elements (use ref:eN with browser_click / browser_type)\n${rendered.text || "(none found)"}`);
    truncated = truncated || rendered.truncated;
  }

  if (mode === "accessibility" || mode === "both") {
    const tree = await page.accessibilitySnapshot({ interestingOnly: true });
    const flattened = flattenAxTree(tree, {
      maxNodes: clamp(options.maxNodes ?? LIMITS.maxSnapshotNodes, 1, LIMITS.maxSnapshotNodes),
    });
    nodes = flattened.nodes;
    truncated = truncated || flattened.truncated;
    blocks.push(`# Accessibility tree\n${flattened.text}`);
  }

  return {
    url: page.url(),
    title: await page.title(),
    mode,
    text: blocks.join("\n\n"),
    nodes,
    elements,
    truncated,
    note: mode === "interactive" || mode === "both" ? "Refs are valid until the page navigates or the snapshot is retaken." : "",
  };
}

/* -------------------------------------------------------------- actions -- */

export async function clickTarget(page: PageHandle, target: ElementTarget, timeoutMs: number): Promise<{ url: string; title: string }> {
  const before = page.url();
  await page.click(target, clampTimeout(timeoutMs, 20_000, LIMITS.waitMaxMs));
  await settle(500);
  const after = page.url();
  if (after !== before) {
    // A click triggered navigation; give it a moment to settle.
    await settle(750);
  }
  return { url: page.url(), title: await page.title() };
}

export async function typeInto(
  page: PageHandle,
  target: ElementTarget,
  text: string,
  options: { secret?: boolean; clear?: boolean; submit?: boolean; delayMs?: number },
): Promise<{ url: string; title: string; typedCharacters: number; valueLogged: false }> {
  // The value is never written to logs, only its length.
  safeLog("log", "type", { target: target.kind, characters: text.length, secret: Boolean(options.secret) });
  await page.type(target, text, { clear: options.clear ?? true, submit: options.submit ?? false, delayMs: options.delayMs ?? 0 });
  await settle(300);
  return { url: page.url(), title: await page.title(), typedCharacters: text.length, valueLogged: false };
}

export type ScrollDirection = "down" | "up" | "top" | "bottom" | "left" | "right";

export async function scrollPage(
  page: PageHandle,
  direction: ScrollDirection,
  amount: number,
): Promise<{ x: number; y: number; documentHeight: number; viewportHeight: number; atBottom: boolean }> {
  const distance = clamp(amount, 1, 100_000);
  if (direction === "top" || direction === "bottom") {
    await page.evaluate((toBottom: boolean) => {
      window.scrollTo({ top: toBottom ? document.documentElement.scrollHeight : 0, behavior: "auto" });
    }, direction === "bottom");
  } else {
    const dx = direction === "left" ? -distance : direction === "right" ? distance : 0;
    const dy = direction === "down" ? distance : direction === "up" ? -distance : 0;
    await page.scroll(dx, dy);
  }
  await settle(350);
  return await page.evaluate(() => ({
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    documentHeight: Math.round(document.documentElement.scrollHeight),
    viewportHeight: Math.round(window.innerHeight),
    atBottom: Math.round(window.scrollY + window.innerHeight) >= Math.round(document.documentElement.scrollHeight) - 4,
  }));
}

export type WaitSpec =
  | { kind: "delay"; ms: number }
  | { kind: "selector"; selector: string; timeoutMs?: number }
  | { kind: "text"; text: string; timeoutMs?: number }
  | { kind: "url"; url?: string; timeoutMs?: number }
  | { kind: "networkidle"; timeoutMs?: number; idleMs?: number };

export async function waitOn(page: PageHandle, spec: WaitSpec): Promise<{ kind: string; url: string; title: string; matched: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  switch (spec.kind) {
    case "delay": {
      const ms = clamp(spec.ms, 0, LIMITS.waitMaxMs);
      await page.waitForTimeout(ms);
      break;
    }
    case "selector": {
      await page.waitForSelector(spec.selector, clampTimeout(spec.timeoutMs, 15_000, LIMITS.waitMaxMs), { visible: true });
      break;
    }
    case "text": {
      await page.waitForText(spec.text, clampTimeout(spec.timeoutMs, 15_000, LIMITS.waitMaxMs));
      break;
    }
    case "url": {
      const timeout = clampTimeout(spec.timeoutMs, 15_000, LIMITS.waitMaxMs);
      if (!spec.url) {
        await page.waitForUrlChange(page.url(), timeout);
        break;
      }
      const deadline = Date.now() + timeout;
      let matched = false;
      while (Date.now() < deadline) {
        if (page.url().includes(spec.url)) {
          matched = true;
          break;
        }
        await settle(300);
      }
      if (!matched) {
        throw new BrowserError("timeout", `The page URL never contained "${spec.url}" (still at ${page.url()}).`, { retryable: true });
      }
      break;
    }
    case "networkidle": {
      await page.waitForNetworkIdle(clampTimeout(spec.timeoutMs, 10_000, LIMITS.waitMaxMs), clamp(spec.idleMs ?? 500, 100, 10_000));
      break;
    }
    default:
      throw new BrowserError("invalid_input", "Unsupported wait specification.");
  }
  await settle(250);
  return { kind: spec.kind, url: page.url(), title: await page.title(), matched: true, elapsedMs: Date.now() - startedAt };
}

export function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
