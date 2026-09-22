/**
 * Browser session runtime.
 *
 * Owns the lifecycle of one browser session: acquire/reconnect the Browser Run
 * session, keep a registry of tabs, run page operations and hand pages to a
 * human when a challenge appears.
 *
 * It is used by the `BrowserSession` Durable Object (durable, multi-call) and
 * by `runEphemeral` (one-shot legacy helpers). It never assumes a persistent
 * process: every call re-attaches to the platform session through
 * `provider.connect(sessionId)` and detaches afterwards, which keeps the
 * browser alive according to its `keep_alive` window.
 */

import { BrowserError, asBrowserError, isBrowserError } from "../core/errors.js";
import { LIMITS, clamp, clampKeepAlive, clampTimeout } from "../core/limits.js";
import { safeLog } from "../core/redact.js";
import type { ChallengeStatus, ChallengeVerdict } from "./challenge.js";
import {
  collectHandoffCues,
  createHandoffRecord,
  detectInteraction,
  challengeCleared,
  failHandoff,
  isHandoffTrigger,
  isActivePhase,
  outcomeFor,
  projectHandoff,
  pushEvent,
  transition,
  HANDOFF_LIMITS,
  type CaptchaHandoffRecord,
  type HandoffOutcome,
} from "./handoff.js";
import type { MediaInspector, FrameSamplingOptions, MediaReport } from "./media.js";
import * as ops from "./ops.js";
import type { ScreenshotManager } from "./screenshot.js";
import type {
  BrowserHandle,
  BrowserProvider,
  ElementTarget,
  PageHandle,
  ProviderName,
  ScreenshotType,
  WaitUntil,
} from "./types.js";

export interface TabRecord {
  /** Stable DEMO id for this tab (`p1`, `p2`, …). */
  id: string;
  /** Provider target id when available. */
  targetId: string | null;
  index: number;
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PauseRecord {
  status: ChallengeStatus;
  url: string;
  pageId: string;
  detectedAt: number;
  handoffId: string | null;
  liveViewUrl: string | null;
  liveViewExpiresAtMs: number | null;
  instructions: string | null;
  pauseUntil: number;
  screenshotUrl: string | null;
}

export interface SessionState {
  sessionId: string;
  provider: ProviderName;
  providerSessionId: string | null;
  createdAt: number;
  lastUsedAt: number;
  keepAliveMs: number;
  tabCounter: number;
  tabs: TabRecord[];
  activeTabId: string | null;
  paused: PauseRecord | null;
  /** Active (or finished) CAPTCHA human-handoff state machine record. */
  captchaHandoff: CaptchaHandoffRecord | null;
  guardrails: { allowedDomains?: string[]; allowedDomainSets?: string[] } | null;
  lastError: string | null;
}

/**
 * Fill fields added after a session state was persisted by an older version.
 * Called on every load path so a stored pre-handoff state keeps working.
 */
export function normaliseSessionState(state: SessionState): SessionState {
  if (!state.captchaHandoff) state.captchaHandoff = null;
  return state;
}

/* ------------------------------------------------- captcha handoff types -- */

export type CaptchaHandoffProjection = ReturnType<typeof projectHandoff>;

export interface CaptchaHandoffStartResult extends CaptchaHandoffProjection {
  action: "handoff_started" | "already_active" | "no_challenge_detected" | "not_handoff_eligible";
  tab: TabRecord | null;
  next: string;
}

export interface CaptchaHandoffPollResult extends CaptchaHandoffProjection {
  waitedMs: number;
  next: string;
}

export interface CaptchaHandoffCancelResult extends CaptchaHandoffProjection {
  action: "cancelled" | "no_active_handoff";
  next: string;
}

export interface RuntimeHooks {
  /** Persist the mutated session state (Durable Object storage or in-memory). */
  persist(state: SessionState): Promise<void>;
  /** Validate + normalise a URL before navigating (SSRF guard). */
  validateUrl(url: string): Promise<string>;
  /** Schedule a wake-up (DO alarm) or no-op for ephemeral sessions. */
  scheduleHeartbeat?(atMs: number): Promise<void>;
}

export interface TabSummary extends TabRecord {
  active: boolean;
}

export interface SessionSummary {
  sessionId: string;
  provider: ProviderName;
  providerSessionId: string | null;
  createdAt: number;
  lastUsedAt: number;
  keepAliveMs: number;
  activeTabId: string | null;
  tabs: TabSummary[];
  paused: PauseRecord | null;
  captchaHandoff: { phase: string; outcome: HandoffOutcome; pageId: string | null; url: string | null; liveViewUrl: string | null; deadline: number | null } | null;
  lastError: string | null;
  capabilities: ReturnType<BrowserProvider["capabilities"]>;
  limits: Awaited<ReturnType<BrowserProvider["limits"]>> | null;
}

export function createSessionState(sessionId: string, provider: ProviderName, keepAliveMs: number): SessionState {
  const now = Date.now();
  return {
    sessionId,
    provider,
    providerSessionId: null,
    createdAt: now,
    lastUsedAt: now,
    keepAliveMs: clampKeepAlive(keepAliveMs),
    tabCounter: 0,
    tabs: [],
    activeTabId: null,
    paused: null,
    captchaHandoff: null,
    guardrails: null,
    lastError: null,
  };
}

interface TabEntry {
  page: PageHandle;
  tab: TabRecord;
}

type TabWork<T> = (context: { page: PageHandle; tab: TabRecord; browser: BrowserHandle }) => Promise<T>;

export class BrowserRuntime {
  constructor(
    private readonly provider: BrowserProvider,
    private state: SessionState,
    private readonly managers: ops.ManagerContext,
    private readonly hooks: RuntimeHooks,
  ) {
    normaliseSessionState(this.state);
  }

  get sessionState(): SessionState {
    return this.state;
  }

  private async persist(): Promise<void> {
    this.state.lastUsedAt = Date.now();
    await this.hooks.persist(this.state);
  }

  /* ----------------------------------------------------------- lifecycle -- */

  private async connect(): Promise<BrowserHandle> {
    if (!this.provider.isAvailable()) {
      throw new BrowserError("capability_unavailable", this.provider.unavailableReason() ?? "Browser provider unavailable.", {
        capability: `${this.provider.name}_browser`,
      });
    }
    if (this.state.providerSessionId) {
      try {
        const browser = await this.provider.connect(this.state.providerSessionId);
        await browser.version();
        return browser;
      } catch (error) {
        safeLog("warn", "session-reconnect-failed", { sessionId: this.state.providerSessionId, error: String(error) });
        this.state.providerSessionId = null;
        this.state.tabs = [];
        this.state.activeTabId = null;
        this.state.paused = null;
        if (this.state.captchaHandoff && isActivePhase(this.state.captchaHandoff.phase)) {
          failHandoff(this.state.captchaHandoff, "The browser session expired while the CAPTCHA handoff was open.", "browser_session_lost");
          safeLog("warn", "browser_session_lost", { sessionId: this.state.sessionId, pageId: this.state.captchaHandoff.pageId });
        }
        this.state.lastError = "Previous browser session expired; a new one will be acquired.";
      }
    }
    const browser = await this.provider
      .launch({
        keepAliveMs: this.state.keepAliveMs,
        ...(this.state.guardrails ? { guardrails: this.state.guardrails } : {}),
      })
      .catch((error: unknown) => {
        throw asBrowserError(error);
      });
    this.state.providerSessionId = browser.sessionId();
    this.state.tabs = [];
    this.state.activeTabId = null;
    this.state.paused = null;
    this.state.lastError = null;
    safeLog("log", "session-acquired", { session: this.state.providerSessionId, keepAliveMs: this.state.keepAliveMs });
    await this.persist();
    return browser;
  }

  private async detach(browser: BrowserHandle): Promise<void> {
    try {
      await browser.disconnect();
    } catch (error) {
      safeLog("warn", "session-detach-failed", String(error));
    }
  }

  /** Terminate the platform session immediately and clear all state. */
  async close(): Promise<{ sessionId: string; closed: boolean; reason?: string }> {
    const providerSessionId = this.state.providerSessionId;
    if (!providerSessionId) {
      this.state.tabs = [];
      this.state.activeTabId = null;
      this.state.paused = null;
      await this.persist();
      return { sessionId: this.state.sessionId, closed: false, reason: "No live browser session was attached." };
    }
    try {
      const browser = await this.provider.connect(providerSessionId);
      await browser.close();
    } catch (error) {
      await this.provider.closeSession(providerSessionId);
      safeLog("warn", "session-close-error", String(error));
    }
    this.state.providerSessionId = null;
    this.state.tabs = [];
    this.state.activeTabId = null;
    this.state.paused = null;
    await this.persist();
    return { sessionId: this.state.sessionId, closed: true };
  }

  /** Heartbeat used while paused: proves the session is still alive. */
  async heartbeat(): Promise<{ alive: boolean; sessionId: string | null }> {
    const providerSessionId = this.state.providerSessionId;
    if (!providerSessionId) return { alive: false, sessionId: null };
    const alive = await this.provider.ping(providerSessionId);
    if (!alive) {
      this.state.providerSessionId = null;
      this.state.paused = null;
      this.state.tabs = [];
      this.state.activeTabId = null;
      this.state.lastError = "Browser session expired while waiting for a human.";
      if (this.state.captchaHandoff && isActivePhase(this.state.captchaHandoff.phase)) {
        failHandoff(this.state.captchaHandoff, "The browser session ended while waiting for the challenge to be completed.", "browser_session_lost");
        safeLog("warn", "browser_session_lost", { sessionId: this.state.sessionId, pageId: this.state.captchaHandoff.pageId });
      }
      await this.persist();
    }
    return { alive, sessionId: providerSessionId };
  }

  async summary(): Promise<SessionSummary> {
    const handoff = this.state.captchaHandoff
      ? {
          phase: this.state.captchaHandoff.phase,
          outcome: outcomeFor(this.state.captchaHandoff),
          pageId: this.state.captchaHandoff.pageId,
          url: this.state.captchaHandoff.url,
          liveViewUrl: this.state.captchaHandoff.liveViewUrl,
          deadline: this.state.captchaHandoff.deadline,
        }
      : null;
    return {
      sessionId: this.state.sessionId,
      provider: this.state.provider,
      providerSessionId: this.state.providerSessionId,
      createdAt: this.state.createdAt,
      lastUsedAt: this.state.lastUsedAt,
      keepAliveMs: this.state.keepAliveMs,
      activeTabId: this.state.activeTabId,
      tabs: this.state.tabs.map((tab) => ({ ...tab, active: tab.id === this.state.activeTabId })),
      paused: this.state.paused,
      captchaHandoff: handoff,
      lastError: this.state.lastError,
      capabilities: this.provider.capabilities(),
      limits: await this.provider.limits(),
    };
  }

  /* ----------------------------------------------------------- tab logic -- */

  private async entries(browser: BrowserHandle): Promise<TabEntry[]> {
    const pages = await browser.pages();
    const targetIds: Array<string | null> = [];
    for (const page of pages) {
      targetIds.push(await page.targetId().catch(() => null));
    }

    const entries: TabEntry[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const targetId = targetIds[i];
      let tab =
        (targetId ? this.state.tabs.find((candidate) => candidate.targetId === targetId) : undefined) ??
        this.state.tabs.find((candidate) => candidate.index === i) ??
        null;
      if (!tab) {
        this.state.tabCounter += 1;
        const now = Date.now();
        tab = {
          id: `p${this.state.tabCounter}`,
          targetId,
          index: i,
          url: page.url(),
          title: "",
          createdAt: now,
          updatedAt: now,
        };
      }
      tab.index = i;
      if (targetId) tab.targetId = targetId;
      entries.push({ page, tab });
    }

    // Drop records for pages that no longer exist (closed tabs).
    this.state.tabs = entries.map((entry) => entry.tab);
    if (!this.state.activeTabId || !this.state.tabs.some((tab) => tab.id === this.state.activeTabId)) {
      this.state.activeTabId = this.state.tabs[0]?.id ?? null;
    }
    return entries;
  }

  private select(entries: TabEntry[], pageId: string | null | undefined): TabEntry | null {
    if (entries.length === 0) return null;
    if (pageId) {
      const found = entries.find((entry) => entry.tab.id === pageId);
      if (found) return found;
      return null;
    }
    const active = entries.find((entry) => entry.tab.id === this.state.activeTabId);
    return active ?? entries[0];
  }

  private async refreshTab(entry: TabEntry): Promise<void> {
    try {
      entry.tab.url = entry.page.url();
      entry.tab.title = await entry.page.title();
      entry.tab.updatedAt = Date.now();
    } catch {
      /* page may have been closed by the operation */
    }
  }

  async withTab<T>(
    pageId: string | null | undefined,
    work: TabWork<T>,
    options: { createIfMissing?: boolean; markActive?: boolean; keepAliveMs?: number } = {},
  ): Promise<{ result: T; tab: TabRecord; tabs: TabSummary[] }> {
    if (options.keepAliveMs) this.state.keepAliveMs = clampKeepAlive(options.keepAliveMs);
    const browser = await this.connect();
    try {
      const entries = await this.entries(browser);
      let entry = this.select(entries, pageId);
      if (!entry) {
        if (pageId && entries.length > 0) {
          throw new BrowserError("page_not_found", `Tab "${pageId}" is not open in this session.`, {
            hint: "Call browser_tabs to list the open tabs.",
            data: { availableTabs: entries.map((candidate) => candidate.tab.id) },
          });
        }
        if (options.createIfMissing === false) {
          throw new BrowserError("page_not_found", "No tab is open in this session.", { hint: "Call browser_open first." });
        }
        const page = await browser.newPage();
        const created = await this.entries(browser);
        entry = created.find((candidate) => candidate.page === page) ?? created[created.length - 1];
        if (!entry) throw new BrowserError("page_not_found", "A new tab could not be created.");
      }
      if (options.markActive !== false) this.state.activeTabId = entry.tab.id;

      let result: T;
      try {
        result = await work({ page: entry.page, tab: entry.tab, browser });
      } catch (error) {
        throw asBrowserError(error);
      }
      await this.refreshTab(entry);
      await this.persist();
      return {
        result,
        tab: entry.tab,
        tabs: this.state.tabs.map((tab) => ({ ...tab, active: tab.id === this.state.activeTabId })),
      };
    } finally {
      await this.detach(browser);
    }
  }

  async listTabs(): Promise<{ tabs: TabSummary[]; activeTabId: string | null; sessionId: string }> {
    const browser = await this.connect();
    try {
      const entries = await this.entries(browser);
      for (const entry of entries) await this.refreshTab(entry);
      await this.persist();
      return {
        tabs: this.state.tabs.map((tab) => ({ ...tab, active: tab.id === this.state.activeTabId })),
        activeTabId: this.state.activeTabId,
        sessionId: this.state.sessionId,
      };
    } finally {
      await this.detach(browser);
    }
  }

  async newTab(url: string | null, options: { waitUntil?: WaitUntil; timeoutMs?: number } = {}): Promise<{ tab: TabRecord; navigation: ops.OpenResult | null }> {
    const target = url ? await this.hooks.validateUrl(url) : null;
    const browser = await this.connect();
    try {
      const page = await browser.newPage();
      const entries = await this.entries(browser);
      const entry = entries.find((candidate) => candidate.page === page) ?? entries[entries.length - 1];
      if (!entry) throw new BrowserError("page_not_found", "A new tab could not be created.");
      this.state.activeTabId = entry.tab.id;
      let navigation: ops.OpenResult | null = null;
      if (target) {
        navigation = await ops.openUrl(page, target, { waitUntil: options.waitUntil, timeoutMs: options.timeoutMs }, this.managers);
        await this.assertFinalUrlAllowed(navigation.finalUrl);
      }
      await this.refreshTab(entry);
      await this.persist();
      return { tab: entry.tab, navigation };
    } finally {
      await this.detach(browser);
    }
  }

  async selectTab(pageId: string): Promise<{ activeTabId: string | null; tabs: TabSummary[] }> {
    const browser = await this.connect();
    try {
      const entries = await this.entries(browser);
      const entry = entries.find((candidate) => candidate.tab.id === pageId);
      if (!entry) throw new BrowserError("page_not_found", `Tab "${pageId}" is not open in this session.`, { hint: "Call browser_tabs to list the open tabs." });
      this.state.activeTabId = pageId;
      await this.refreshTab(entry);
      await this.persist();
      return {
        activeTabId: this.state.activeTabId,
        tabs: this.state.tabs.map((tab) => ({ ...tab, active: tab.id === this.state.activeTabId })),
      };
    } finally {
      await this.detach(browser);
    }
  }

  async closeTab(pageId: string): Promise<{ closed: string; tabs: TabSummary[]; activeTabId: string | null }> {
    const browser = await this.connect();
    try {
      const entries = await this.entries(browser);
      const entry = entries.find((candidate) => candidate.tab.id === pageId);
      if (!entry) throw new BrowserError("page_not_found", `Tab "${pageId}" is not open in this session.`);
      await entry.page.close();
      const remaining = (await this.entries(browser)).filter((candidate) => candidate.tab.id !== pageId);
      if (this.state.activeTabId === pageId) this.state.activeTabId = remaining[0]?.tab.id ?? null;
      await this.persist();
      return {
        closed: pageId,
        tabs: this.state.tabs.map((tab) => ({ ...tab, active: tab.id === this.state.activeTabId })),
        activeTabId: this.state.activeTabId,
      };
    } finally {
      await this.detach(browser);
    }
  }

  /* --------------------------------------------------------------- tools -- */

  async open(pageId: string | undefined | null, url: string, options: ops.OpenOptions = {}): Promise<ops.OpenResult & { sessionId: string; tab: TabRecord; tabs: TabSummary[] }> {
    const target = await this.hooks.validateUrl(url);
    const { result, tab, tabs } = await this.withTab(pageId ?? null, async ({ page }) => {
      const opened = await ops.openUrl(page, target, options, this.managers);
      await this.assertFinalUrlAllowed(opened.finalUrl);
      return opened;
    });
    return { ...result, sessionId: this.state.sessionId, tab, tabs };
  }

  async screenshot(
    pageId: string | undefined | null,
    options: ops.CaptureOptions = {},
  ): Promise<ops.CaptureResult & { sessionId: string; tab: TabRecord; challenge: ChallengeVerdict }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page }) => {
      const capture = await ops.captureScreenshot(page, options, this.managers);
      return { capture, challenge: await this.managers.challenge.inspect(page) };
    });
    return { ...result.capture, sessionId: this.state.sessionId, tab, challenge: result.challenge };
  }

  async read(pageId: string | undefined | null, options: ops.ReadOptions = {}): Promise<ops.ReadResult & { sessionId: string; tab: TabRecord }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page }) => ops.readPage(page, options, this.managers));
    return { ...result, sessionId: this.state.sessionId, tab };
  }

  async snapshot(pageId: string | undefined | null, options: ops.SnapshotOptions = {}): Promise<ops.SnapshotResultPayload & { sessionId: string; tab: TabRecord; challenge: ChallengeVerdict }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page }) => {
      const snapshot = await ops.snapshotPage(page, options);
      return { snapshot, challenge: await this.managers.challenge.inspect(page) };
    });
    return { ...result.snapshot, sessionId: this.state.sessionId, tab, challenge: result.challenge };
  }

  async click(
    pageId: string | undefined | null,
    target: ElementTarget,
    options: { timeoutMs?: number; screenshotAfter?: boolean } = {},
  ): Promise<{ url: string; title: string; sessionId: string; tab: TabRecord; challenge: ChallengeVerdict; screenshot?: ops.CaptureResult }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page }) => {
      const before = page.url();
      const clicked = await ops.clickTarget(page, target, options.timeoutMs ?? 20_000);
      if (page.url() !== before) await this.assertFinalUrlAllowed(page.url());
      const challenge = await this.managers.challenge.inspect(page);
      const screenshot = options.screenshotAfter ? await ops.captureScreenshot(page, {}, this.managers) : undefined;
      return { clicked: { navigated: page.url() !== before, ...clicked }, challenge, screenshot };
    });
    return {
      url: result.clicked.url,
      title: result.clicked.title,
      sessionId: this.state.sessionId,
      tab,
      challenge: result.challenge,
      ...(result.screenshot ? { screenshot: result.screenshot } : {}),
    };
  }

  async type(
    pageId: string | undefined | null,
    target: ElementTarget,
    text: string,
    options: { secret?: boolean; clear?: boolean; submit?: boolean; screenshotAfter?: boolean } = {},
  ): Promise<{ url: string; title: string; typedCharacters: number; valueLogged: false; sessionId: string; tab: TabRecord }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page }) => {
      const typed = await ops.typeInto(page, target, text, options);
      const screenshot = options.screenshotAfter ? await ops.captureScreenshot(page, {}, this.managers) : undefined;
      return { typed, screenshot };
    });
    return {
      url: result.typed.url,
      title: result.typed.title,
      typedCharacters: result.typed.typedCharacters,
      valueLogged: false,
      sessionId: this.state.sessionId,
      tab,
    };
  }

  async scroll(pageId: string | undefined | null, direction: ops.ScrollDirection, amount: number): Promise<Awaited<ReturnType<typeof ops.scrollPage>> & { sessionId: string; tab: TabRecord }> {
    const { result, tab } = await this.withTab(pageId ?? null, ({ page }) => ops.scrollPage(page, direction, amount));
    return { ...result, sessionId: this.state.sessionId, tab };
  }

  async wait(pageId: string | undefined | null, spec: ops.WaitSpec): Promise<Awaited<ReturnType<typeof ops.waitOn>> & { sessionId: string; tab: TabRecord; challenge: ChallengeVerdict }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page }) => {
      const waited = await ops.waitOn(page, spec);
      return { waited, challenge: await this.managers.challenge.inspect(page) };
    });
    return { ...result.waited, sessionId: this.state.sessionId, tab, challenge: result.challenge };
  }

  async mediaInfo(pageId: string | undefined | null, options: { selector?: string | null } = {}): Promise<MediaReport & { sessionId: string; tab: TabRecord }> {
    const { result, tab } = await this.withTab(pageId ?? null, ({ page }) => this.managers.media.inspect(page, options));
    return { ...result, sessionId: this.state.sessionId, tab };
  }

  async videoFrames(
    pageId: string | undefined | null,
    options: FrameSamplingOptions = {},
  ): Promise<Awaited<ReturnType<MediaInspector["sampleFrames"]>> & { sessionId: string; tab: TabRecord; url: string; title: string }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page }) => ({
      report: await this.managers.media.sampleFrames(page, options),
      url: page.url(),
      title: await page.title(),
    }));
    return { ...result.report, sessionId: this.state.sessionId, tab, url: result.url, title: result.title };
  }

  async challengeStatus(
    pageId: string | undefined | null,
    options: { screenshot?: boolean; type?: ScreenshotType } = {},
  ): Promise<{
    sessionId: string;
    tab: TabRecord;
    url: string;
    title: string;
    challenge: ChallengeVerdict;
    paused: PauseRecord | null;
    screenshot: { url: string; mimeType: string; bytes: number } | null;
    handoff: { active: boolean; handoffId?: string; durationMs?: number } | null;
    liveViewUrl: string | null;
  }> {
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page, browser, tab: currentTab }) => {
      const challenge = await this.managers.challenge.inspect(page);
      let screenshot: ops.CaptureResult | null = null;
      if (options.screenshot !== false && this.managers.screenshots.available) {
        try {
          screenshot = await ops.captureScreenshot(page, { type: options.type ?? "png", fullPage: false }, this.managers);
        } catch (error) {
          safeLog("warn", "challenge-screenshot-failed", String(error));
        }
      }
      const pausedForTab = this.state.paused && this.state.paused.pageId === currentTab.id ? this.state.paused : null;
      let handoff: { active: boolean; handoffId?: string; durationMs?: number } | null = null;
      let liveViewUrl: string | null = pausedForTab?.liveViewUrl ?? null;
      if (this.state.paused && this.provider.capabilities().handoff) {
        const state = await browser.handoffState(page);
        if (state) handoff = { active: Boolean(state.active), ...(state.handoffId ? { handoffId: state.handoffId } : {}), ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}) };
      }
      if (!liveViewUrl || (pausedForTab?.liveViewExpiresAtMs && pausedForTab.liveViewExpiresAtMs < Date.now() + 30_000)) {
        const link = await browser.liveView(page, { mode: "tab", expiresInMs: 300_000 });
        if (link) {
          liveViewUrl = link.url;
          if (pausedForTab) {
            pausedForTab.liveViewUrl = link.url;
            pausedForTab.liveViewExpiresAtMs = link.expiresAtMs;
          }
        }
      }
      return {
        challenge,
        screenshot,
        paused: pausedForTab,
        handoff,
        liveViewUrl,
        url: page.url(),
        title: await page.title(),
      };
    });
    await this.persist();
    return {
      sessionId: this.state.sessionId,
      tab,
      url: result.url,
      title: result.title,
      challenge: result.challenge,
      paused: result.paused,
      screenshot: result.screenshot ? { url: result.screenshot.image.url, mimeType: result.screenshot.image.mimeType, bytes: result.screenshot.image.bytes } : null,
      handoff: result.handoff,
      liveViewUrl: result.liveViewUrl,
    };
  }

  /**
   * Pause for a human. Never solves or bypasses anything: it reports the
   * challenge, keeps the session alive, and exposes a Live View URL so a person
   * can complete the step themselves.
   */
  async pauseForHuman(
    pageId: string | undefined | null,
    options: { instructions?: string; timeoutMs?: number; screenshot?: boolean; mode?: "tab" | "devtools" | "full" } = {},
  ): Promise<{
    status: "challenge_required" | "paused_for_human" | "no_challenge_detected";
    sessionId: string;
    tab: TabRecord;
    url: string;
    title: string;
    challenge: ChallengeVerdict;
    liveViewUrl: string | null;
    liveViewExpiresAtMs: number | null;
    handoffId: string | null;
    instructions: string;
    screenshotUrl: string | null;
    pauseUntil: number;
    waitingForHuman: boolean;
    note: string;
  }> {
    const pauseMs = clamp(options.timeoutMs ?? LIMITS.pauseDefaultMs, 30_000, LIMITS.pauseMaxMs);
    const { result, tab } = await this.withTab(pageId ?? null, async ({ page, browser, tab: currentTab }) => {
      const challenge = await this.managers.challenge.inspect(page);
      let screenshotUrl: string | null = null;
      if (options.screenshot !== false && this.managers.screenshots.available) {
        try {
          const capture = await ops.captureScreenshot(page, { type: "png", fullPage: false }, this.managers);
          screenshotUrl = capture.image.url;
        } catch (error) {
          safeLog("warn", "pause-screenshot-failed", String(error));
        }
      }

      const url = page.url();
      const title = await page.title();
      const instructions = options.instructions?.trim() || this.managers.challenge.buildInstructions(challenge, url);

      let liveViewUrl: string | null = null;
      let liveViewExpiresAtMs: number | null = null;
      if (this.provider.capabilities().liveView) {
        const link = await browser.liveView(page, { mode: options.mode ?? "tab", expiresInMs: 300_000 });
        if (link) {
          liveViewUrl = link.url;
          liveViewExpiresAtMs = link.expiresAtMs;
        }
      }

      let handoffId: string | null = null;
      if (this.provider.capabilities().handoff) {
        const handoff = await browser.requestHandoff(page, { instructions, timeoutMs: pauseMs });
        if (handoff) handoffId = handoff.handoffId;
      }

      const pauseUntil = Date.now() + pauseMs;
      this.state.paused = {
        status: challenge.status,
        url,
        pageId: currentTab.id,
        detectedAt: Date.now(),
        handoffId,
        liveViewUrl,
        liveViewExpiresAtMs,
        instructions,
        pauseUntil,
        screenshotUrl,
      };
      // Keep the session warm while a human works: the platform closes idle
      // browsers, so schedule heartbeats inside the keep-alive window.
      this.state.keepAliveMs = clampKeepAlive(Math.max(this.state.keepAliveMs, LIMITS.keepAliveMaxMs));
      if (this.hooks.scheduleHeartbeat) {
        await this.hooks.scheduleHeartbeat(Date.now() + Math.min(LIMITS.heartbeatIntervalMs, Math.max(30_000, this.state.keepAliveMs - 60_000)));
      }

      return { challenge, screenshotUrl, liveViewUrl, liveViewExpiresAtMs, handoffId, instructions, pauseUntil, url, title };
    });
    await this.persist();

    const status = result.challenge.status === "normal" ? "no_challenge_detected" : "challenge_required";
    return {
      status: status === "no_challenge_detected" ? "no_challenge_detected" : "challenge_required",
      sessionId: this.state.sessionId,
      tab,
      url: result.url,
      title: result.title,
      challenge: result.challenge,
      liveViewUrl: result.liveViewUrl,
      liveViewExpiresAtMs: result.liveViewExpiresAtMs,
      handoffId: result.handoffId,
      instructions: result.instructions,
      screenshotUrl: result.screenshotUrl,
      pauseUntil: result.pauseUntil,
      waitingForHuman: true,
      note: result.liveViewUrl
        ? "DEMO does not solve or bypass challenges. Open the live view URL, complete the step yourself, then call browser_resume. The session is kept alive while you work."
        : "DEMO does not solve or bypass challenges. This environment does not expose Live View, so complete the step in your own browser and re-open the page here afterwards.",
    };
  }

  /** Re-check the page after a human finished (or gave up on) a challenge. */
  async resume(
    pageId: string | undefined | null,
    options: { screenshot?: boolean; reload?: boolean; waitMs?: number } = {},
  ): Promise<{
    status: "resumed" | "still_blocked" | "waiting_for_human" | "session_expired";
    sessionId: string;
    tab: TabRecord;
    url: string;
    title: string;
    challenge: ChallengeVerdict;
    handoff: { active: boolean; handoffId?: string; durationMs?: number } | null;
    screenshotUrl: string | null;
    textPreview: string | null;
    note: string;
  }> {
    if (!this.state.providerSessionId) {
      return {
        status: "session_expired",
        sessionId: this.state.sessionId,
        tab: this.state.tabs[0] ?? ({} as TabRecord),
        url: "",
        title: "",
        challenge: { status: "unknown", confidence: 0, reason: "The browser session is no longer available.", signals: [], requiresHuman: false, recommendedAction: "Re-open the page with browser_open." },
        handoff: null,
        screenshotUrl: null,
        textPreview: null,
        note: "The browser session expired before the challenge was completed. Re-open the page and pause for a human again.",
      };
    }

    const { result, tab } = await this.withTab(pageId ?? null, async ({ page, browser }) => {
      if (options.reload) {
        await page.goto(page.url(), { waitUntil: "domcontentloaded", timeoutMs: LIMITS.navigationTimeoutDefaultMs });
        await ops.settle(750);
      }
      if (options.waitMs) await ops.settle(clamp(options.waitMs, 0, 10_000));

      let handoff: { active: boolean; handoffId?: string; durationMs?: number } | null = null;
      if (this.state.paused && this.provider.capabilities().handoff) {
        const state = await browser.handoffState(page);
        if (state) handoff = { active: Boolean(state.active), ...(state.handoffId ? { handoffId: state.handoffId } : {}), ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}) };
      }

      const challenge = await this.managers.challenge.inspect(page);
      let screenshotUrl: string | null = null;
      let textPreview: string | null = null;
      if (options.screenshot !== false && this.managers.screenshots.available) {
        try {
          const capture = await ops.captureScreenshot(page, { type: "png", fullPage: false }, this.managers);
          screenshotUrl = capture.image.url;
        } catch (error) {
          safeLog("warn", "resume-screenshot-failed", String(error));
        }
      }
      try {
        const read = await ops.readPage(page, { maxTextChars: 1_500, maxLinks: 0, format: "text" }, this.managers);
        textPreview = read.text.slice(0, 1_500);
      } catch {
        textPreview = null;
      }

      const handoffStillActive = Boolean(handoff?.active);
      const cleared = !handoffStillActive && challenge.status !== "captcha" && challenge.status !== "bot_check" && challenge.status !== "login_required" && challenge.status !== "consent_required";
      if (cleared) {
        this.state.paused = null;
      } else if (this.state.paused) {
        this.state.paused.status = challenge.status;
        this.state.paused.detectedAt = Date.now();
      }

      return { challenge, handoff, screenshotUrl, textPreview, handoffStillActive, url: page.url(), title: await page.title() };
    });
    await this.persist();

    const status = result.handoffStillActive
      ? "waiting_for_human"
      : result.challenge.status === "normal" || result.challenge.status === "unknown"
        ? "resumed"
        : "still_blocked";

    return {
      status,
      sessionId: this.state.sessionId,
      tab,
      url: result.url,
      title: result.title,
      challenge: result.challenge,
      handoff: result.handoff,
      screenshotUrl: result.screenshotUrl,
      textPreview: result.textPreview,
      note:
        status === "resumed"
          ? "No blocking challenge is detected any more. DEMO did not bypass anything: a human completed the step, or the page changed on its own."
          : status === "waiting_for_human"
            ? "The human handoff is still open. Finish the step in the live view, then call browser_resume again."
            : "The page still looks blocked. DEMO will not attempt to bypass it; a human can use browser_pause_for_human.",
    };
  }

  /* ------------------------------------------------- captcha human handoff -- */

  /**
   * CAPTCHA / bot-verification human handoff — start.
   *
   * Detects a challenge on the current tab, immediately suspends automation,
   * preserves the *existing* session/tab/page state plus a resumable task
   * snapshot, opens a Live View for the user and returns the handoff state
   * machine. The session is never rotated and the page is never reloaded to
   * shake the challenge off; the human completes it in the live browser.
   */
  async captchaHandoffStart(
    pageId: string | undefined | null,
    options: {
      instructions?: string;
      timeoutMs?: number;
      screenshot?: boolean;
      mode?: "tab" | "devtools" | "full";
      task?: { workflow?: string; step?: string; context?: Record<string, string> } | null;
    } = {},
  ): Promise<CaptchaHandoffStartResult> {
    const timeoutMs = clamp(options.timeoutMs ?? HANDOFF_LIMITS.handoffDefaultMs, HANDOFF_LIMITS.handoffMinMs, HANDOFF_LIMITS.handoffMaxMs);

    const existing = this.state.captchaHandoff;
    if (existing && isActivePhase(existing.phase)) {
      return {
        ...projectHandoff(existing, this.state.sessionId),
        action: "already_active",
        tab: this.state.tabs.find((candidate) => candidate.id === existing.pageId) ?? null,
        next: "A CAPTCHA handoff is already running for this session. Call browser_captcha_wait to monitor it, or browser_captcha_cancel to abandon it.",
      };
    }

    const { result, tab } = await this.withTab(pageId ?? null, async ({ page, browser, tab: currentTab }) => {
      const challenge = await this.managers.challenge.inspect(page);
      if (!isHandoffTrigger(challenge.status)) {
        return { started: false as const, challenge, tabId: currentTab.id };
      }

      let screenshotUrl: string | null = null;
      if (options.screenshot !== false && this.managers.screenshots.available) {
        try {
          const capture = await ops.captureScreenshot(page, { type: "png", fullPage: false }, this.managers);
          screenshotUrl = capture.image.url;
        } catch (error) {
          safeLog("warn", "handoff-screenshot-failed", String(error));
        }
      }

      const url = page.url();
      const instructions = options.instructions?.trim() || this.managers.challenge.buildInstructions(challenge, url);

      let liveViewUrl: string | null = null;
      let liveViewExpiresAtMs: number | null = null;
      if (this.provider.capabilities().liveView) {
        const link = await browser.liveView(page, { mode: options.mode ?? "tab", expiresInMs: 300_000 }).catch(() => null);
        if (link) {
          liveViewUrl = link.url;
          liveViewExpiresAtMs = link.expiresAtMs;
        }
      }

      let handoffId: string | null = null;
      if (this.provider.capabilities().handoff) {
        const handoff = await browser.requestHandoff(page, { instructions, timeoutMs }).catch(() => null);
        if (handoff) handoffId = handoff.handoffId;
      }

      // Baseline interaction cues so we can tell, later, that a human is working.
      const cues = await page.evaluate(collectHandoffCues).catch(() => null);

      const record = createHandoffRecord(
        {
          pageId: currentTab.id,
          url,
          vendor: challenge.vendor ?? null,
          signals: challenge.signals,
          challengeStatus: challenge.status,
          confidence: challenge.confidence,
          timeoutMs,
          liveViewUrl,
          liveViewExpiresAtMs,
          handoffId,
          instructions,
          screenshotUrl,
          task: options.task ?? null,
        },
        this.state.sessionId,
      );
      record.interaction.cues = cues;
      this.state.captchaHandoff = record;
      // Keep the legacy pause bookkeeping in sync: the alarm uses it to keep the
      // platform session warm while the human works.
      this.state.paused = {
        status: challenge.status,
        url,
        pageId: currentTab.id,
        detectedAt: Date.now(),
        handoffId,
        liveViewUrl,
        liveViewExpiresAtMs,
        instructions,
        pauseUntil: record.deadline,
        screenshotUrl,
      };
      this.state.keepAliveMs = clampKeepAlive(Math.max(this.state.keepAliveMs, LIMITS.keepAliveMaxMs));
      if (this.hooks.scheduleHeartbeat) {
        await this.hooks.scheduleHeartbeat(Date.now() + Math.min(LIMITS.heartbeatIntervalMs, Math.max(30_000, this.state.keepAliveMs - 60_000)));
      }
      safeLog("log", "captcha_detected", { sessionId: this.state.sessionId, pageId: currentTab.id, challenge: challenge.status, ...(challenge.vendor ? { vendor: challenge.vendor } : {}) });
      return { started: true as const, challenge, tabId: currentTab.id };
    });
    await this.persist();

    if (!result.started) {
      const eligible = result.challenge.requiresHuman;
      return {
        ...projectHandoff(null, this.state.sessionId),
        action: eligible ? "not_handoff_eligible" : "no_challenge_detected",
        tab,
        next: eligible
          ? "This blocking state (login/consent) is not a CAPTCHA: use browser_pause_for_human, or dismiss it with browser_click where appropriate."
          : result.challenge.status === "loading"
            ? "The page may still be loading. Call browser_wait, then try browser_captcha_handoff again."
            : "No CAPTCHA or bot-verification detected. Continue automation normally.",
      };
    }

    const record = this.state.captchaHandoff!;
    return {
      ...projectHandoff(record, this.state.sessionId),
      action: "handoff_started",
      tab,
      next: "Give the liveViewUrl to the user. Monitor with browser_captcha_wait (repeat until a terminal outcome); Demo resumes the task automatically once the challenge is gone. The user can also signal completion with browser_resume, or abandon with browser_captcha_cancel.",
    };
  }

  /**
   * Monitor the handoff for up to `waitMs` (bounded window): polls session
   * liveness, page cues and the challenge verdict until the challenge is gone
   * (automatic resume), the platform handoff fails, the deadline passes or the
   * session dies. Never reloads the page and never rotates the session.
   */
  async captchaHandoffPoll(
    pageId: string | undefined | null,
    options: { waitMs?: number; intervalMs?: number } = {},
  ): Promise<CaptchaHandoffPollResult> {
    const startedAt = Date.now();
    const record = this.state.captchaHandoff;
    if (!record) {
      return {
        ...projectHandoff(null, this.state.sessionId),
        waitedMs: 0,
        next: "No CAPTCHA handoff exists for this session. Call browser_captcha_handoff when a challenge appears.",
      };
    }
    const targetPageId = pageId ?? record.pageId;
    const windowMs = clamp(options.waitMs ?? HANDOFF_LIMITS.monitorWindowDefaultMs, 0, HANDOFF_LIMITS.monitorWindowMaxMs);
    const intervalMs = clamp(options.intervalMs ?? HANDOFF_LIMITS.pollIntervalMs, HANDOFF_LIMITS.pollIntervalMinMs, HANDOFF_LIMITS.pollIntervalMaxMs);
    const windowDeadline = startedAt + windowMs;

    let projection = await this.captchaHandoffTick(targetPageId);
    while (projection.outcome === "waiting_for_human" && Date.now() < windowDeadline) {
      await ops.settle(Math.min(intervalMs, Math.max(0, windowDeadline - Date.now())));
      projection = await this.captchaHandoffTick(targetPageId);
    }
    await this.persist();

    const next =
      projection.outcome === "completed_and_resumed"
        ? "Challenge cleared and control is back. Continue the original task from the stored task step — the tab, session, cookies and page state were preserved."
        : projection.outcome === "waiting_for_human"
          ? "The challenge is still on the page. Call browser_captcha_wait again to keep monitoring until the deadline, or browser_captcha_cancel to abandon."
          : projection.outcome === "failed"
            ? "The human attempt ended without clearing the challenge. A new browser_captcha_handoff can be started once, explicitly — Demo never retries on its own."
            : projection.outcome === "timed_out"
              ? "The handoff deadline passed. Start a new browser_captcha_handoff if the user wants another window, or close the session."
              : projection.outcome === "cancelled"
                ? "The handoff was abandoned by the user. The session is still usable for other work."
                : "The browser session is gone. Re-open the page with browser_open to start fresh; the task context above describes where the old session stopped.";
    return { ...projection, waitedMs: Date.now() - startedAt, next };
  }

  /** One completion check. Cheap enough for the Durable Object alarm. */
  async captchaHandoffTick(pageId: string | undefined | null): Promise<CaptchaHandoffProjection> {
    const record = this.state.captchaHandoff;
    if (!record) return projectHandoff(null, this.state.sessionId);
    if (!isActivePhase(record.phase)) return projectHandoff(record, this.state.sessionId);
    const targetPageId = pageId ?? record.pageId;

    // 1) Liveness first: a dead session can never resume.
    const providerSessionId = this.state.providerSessionId;
    const alive = providerSessionId ? await this.provider.ping(providerSessionId).catch(() => false) : false;
    if (!providerSessionId || !alive) {
      failHandoff(record, "The browser session ended while waiting for the challenge to be completed.", "browser_session_lost");
      this.state.providerSessionId = null;
      this.state.paused = null;
      this.state.tabs = [];
      this.state.activeTabId = null;
      this.state.lastError = "Browser session expired while waiting for a human (CAPTCHA handoff).";
      safeLog("warn", "browser_session_lost", { sessionId: this.state.sessionId, pageId: record.pageId });
      await this.persist();
      return projectHandoff(record, this.state.sessionId);
    }

    try {
      await this.withTab(targetPageId, async ({ page, browser }) => {
        // 2) Coarse interaction cues + challenge verdict. No reload: the human
        // completes the challenge in the live page, and repeatedly reloading to
        // evict a challenge is exactly the evasion Demo refuses to do.
        const cues = await page.evaluate(collectHandoffCues).catch(() => null);
        const challenge = await this.managers.challenge.inspect(page);
        record.currentUrl = page.url();
        record.lastCheckedAt = Date.now();

        let platformActive = false;
        if (record.handoffId && this.provider.capabilities().handoff) {
          const state = await browser.handoffState(page).catch(() => null);
          platformActive = Boolean(state?.active);
        }
        if (platformActive && record.interaction.platformSeenAt === null) {
          record.interaction.platformSeenAt = Date.now();
        }

        // 3) Human visible? Flip to USER_INTERACTING once, carrying the
        // `human_handoff_active` event.
        if (cues) {
          const interaction = detectInteraction(record.interaction.cues, cues, platformActive);
          if (interaction.interacting) {
            record.interaction.cues = cues;
            record.interaction.detectedAt = record.interaction.detectedAt ?? Date.now();
            record.interaction.reasons = interaction.reasons;
            if (record.phase === "HUMAN_HANDOFF") {
              transition(record, "USER_INTERACTING", "human_handoff_active", { reasons: interaction.reasons.slice(0, 4).join(",") });
              record.interaction.eventEmitted = true;
            } else if (!record.interaction.eventEmitted) {
              pushEvent(record, "human_handoff_active", { reasons: interaction.reasons.slice(0, 4).join(",") });
              record.interaction.eventEmitted = true;
            }
          }
        }

        // 4) Completion check: verdict no longer blocking (this covers both an
        // in-place solve and the page having navigated past the challenge).
        if (challengeCleared(challenge.status)) {
          record.challengeStatus = challenge.status;
          record.completedAt = Date.now();
          transition(record, "CAPTCHA_COMPLETED", "captcha_completed", { url: record.currentUrl });
          transition(record, "RESUMING", "automation_resumed");
          record.resumedAt = Date.now();
          transition(record, "RUNNING");
          this.state.paused = null;
          safeLog("log", "captcha_completed", { sessionId: this.state.sessionId, pageId: record.pageId, url: record.currentUrl });
          return;
        }

        record.challengeStatus = challenge.status;
        if (challenge.vendor) record.vendor = challenge.vendor;

        // 5) Failure: a human was seen on the platform handoff, the handoff
        // closed again, and the challenge is still there.
        if (record.interaction.platformSeenAt !== null && record.handoffId && this.provider.capabilities().handoff && !platformActive) {
          failHandoff(record, "The human handoff ended but the challenge is still on the page.", "captcha_failed", { challenge: challenge.status, url: record.currentUrl });
          this.state.paused = null;
          safeLog("warn", "captcha_failed", { sessionId: this.state.sessionId, pageId: record.pageId, challenge: challenge.status });
          return;
        }

        // 6) Timeout: deadline passed, challenge still present.
        if (Date.now() >= record.deadline) {
          failHandoff(record, "Timed out waiting for the challenge to be completed.", "captcha_timeout", { waitedMs: Date.now() - record.detectedAt, url: record.currentUrl });
          this.state.paused = null;
          safeLog("warn", "captcha_timeout", { sessionId: this.state.sessionId, pageId: record.pageId });
        }
      });
    } catch (error) {
      // The handoff tab disappearing (closed by the human, crashed, navigated
      // into a dead page) is a terminal outcome, not a reason to retry.
      if (isBrowserError(error) && (error.code === "page_not_found" || error.code === "session_not_found")) {
        failHandoff(record, "The handoff tab is no longer open in the browser session.", "captcha_failed", { pageId: targetPageId });
        this.state.paused = null;
        safeLog("warn", "captcha_failed", { sessionId: this.state.sessionId, pageId: targetPageId, reason: "tab_lost" });
      } else {
        safeLog("warn", "handoff-tick-failed", String(error));
      }
    }
    await this.persist();
    return projectHandoff(record, this.state.sessionId);
  }

  /** Read-only view of the handoff state machine (plus liveness). */
  async captchaHandoffStatus(): Promise<CaptchaHandoffProjection & { sessionAlive: boolean }> {
    const record = this.state.captchaHandoff;
    const providerSessionId = this.state.providerSessionId;
    const sessionAlive = providerSessionId ? await this.provider.ping(providerSessionId).catch(() => false) : false;
    return { ...projectHandoff(record, this.state.sessionId), sessionAlive };
  }

  /**
   * Explicit user fallback: abandon the handoff. The session, tab and page
   * state stay untouched — only automation control is returned.
   */
  async captchaHandoffCancel(options: { reason?: string } = {}): Promise<CaptchaHandoffCancelResult> {
    const record = this.state.captchaHandoff;
    if (!record || !isActivePhase(record.phase)) {
      return {
        ...projectHandoff(record ?? null, this.state.sessionId),
        action: "no_active_handoff",
        next: "There is no active CAPTCHA handoff to cancel.",
      };
    }
    failHandoff(record, options.reason?.trim() || "The user cancelled the handoff.", "human_handoff_cancelled");
    this.state.paused = null;
    safeLog("log", "human_handoff_cancelled", { sessionId: this.state.sessionId, pageId: record.pageId });
    await this.persist();
    return {
      ...projectHandoff(record, this.state.sessionId),
      action: "cancelled",
      next: "Handoff cancelled. The browser session and its tabs are still open; you can continue other automation or start a new handoff explicitly.",
    };
  }

  /* --------------------------------------------------------------- utils -- */

  /**
   * Redirect targets are validated too: a page may redirect into a private
   * range even when the requested URL was public.
   */
  private async assertFinalUrlAllowed(url: string): Promise<void> {
    if (!url || url === "about:blank") return;
    await this.hooks.validateUrl(url);
  }

  async setViewport(width: number, height: number): Promise<void> {
    const browser = await this.connect();
    try {
      const entries = await this.entries(browser);
      for (const entry of entries) {
        await entry.page.setViewport({ width: clamp(width, 320, 3840), height: clamp(height, 320, 4320) });
      }
      await this.persist();
    } finally {
      await this.detach(browser);
    }
  }

  async setTimeoutProbe(): Promise<number> {
    return clampTimeout(undefined, LIMITS.navigationTimeoutDefaultMs, LIMITS.navigationTimeoutMaxMs);
  }
}
