/**
 * Cloudflare Browser Run provider (Workers binding).
 *
 * Uses the official `@cloudflare/puppeteer` fork:
 *
 *   - `puppeteer.launch(env.BROWSER, { keep_alive })` acquires a session and
 *     keeps it alive (10s … 600s) so later MCP calls can re-attach.
 *   - `puppeteer.connect(env.BROWSER, sessionId)` re-attaches to a session.
 *   - `puppeteer.limits(env.BROWSER)` exposes account concurrency.
 *   - `Cloudflare.getLiveView` / `Cloudflare.handoff` provide Live View URLs
 *     and structured human-in-the-loop handoff.
 *
 * No Node.js APIs, no filesystem, no persistent process, no local Chrome.
 */

import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { BrowserError } from "../../core/errors.js";
import { LIMITS, clampKeepAlive } from "../../core/limits.js";
import { safeLog } from "../../core/redact.js";
import type {
  BrowserHandle,
  BrowserProvider,
  LaunchOptions,
  ProviderCapabilities,
  ProviderLimits,
  ProviderSessionInfo,
} from "../types.js";
import { PuppeteerBrowserHandle, type PuppeteerLikeBrowser } from "./puppeteer-adapter.js";

export interface CloudflareProviderOptions {
  /** Hard cap on sessions this deployment will keep; advisory (platform limits still apply). */
  maxConcurrentSessions?: number;
}

export class CloudflareBrowserProvider implements BrowserProvider {
  readonly name = "cloudflare" as const;

  constructor(
    private readonly binding: BrowserWorker | undefined | null,
    private readonly options: CloudflareProviderOptions = {},
  ) {}

  isAvailable(): boolean {
    return Boolean(this.binding && typeof (this.binding as BrowserWorker).fetch === "function");
  }

  unavailableReason(): string | null {
    if (this.isAvailable()) return null;
    return "Cloudflare Browser Run is not configured for this Worker. Add a `browser` binding (`\"browser\": { \"binding\": \"BROWSER\" }`) to wrangler.jsonc and deploy on a Workers plan that includes Browser Run.";
  }

  capabilities(): ProviderCapabilities {
    return {
      sessions: true,
      liveView: true,
      handoff: true,
      fullPageScreenshot: true,
      clipScreenshot: true,
      accessibilitySnapshot: true,
      videoFrames: true,
      guardrails: true,
    };
  }

  private assertBinding(): BrowserWorker {
    if (!this.isAvailable()) {
      throw new BrowserError("capability_unavailable", this.unavailableReason() ?? "Browser binding missing.", {
        capability: "cloudflare_browser_run",
      });
    }
    return this.binding as BrowserWorker;
  }

  async launch(options: LaunchOptions): Promise<BrowserHandle> {
    const binding = this.assertBinding();
    const limits = await this.limits();
    if (limits && limits.allowedBrowserAcquisitions === 0) {
      throw new BrowserError(
        "rate_limited",
        `Browser Run concurrency limit reached (${limits.activeSessions}/${limits.maxConcurrentSessions} sessions active).`,
        {
          retryable: true,
          hint: `Retry in ~${Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000)}s, or close idle sessions with browser_session/close.`,
          data: { limits },
        },
      );
    }
    if (this.options.maxConcurrentSessions && limits && limits.activeSessions >= this.options.maxConcurrentSessions) {
      throw new BrowserError(
        "rate_limited",
        `DEMO session cap reached (${limits.activeSessions}/${this.options.maxConcurrentSessions}).`,
        { retryable: true, hint: "Close an existing session or raise BROWSER_MAX_SESSIONS." },
      );
    }

    const keepAlive = clampKeepAlive(options.keepAliveMs);
    const browser = await puppeteer.launch(binding, {
      keep_alive: keepAlive,
      ...(options.guardrails ? { guardrails: options.guardrails } : {}),
    });
    const sessionId = safeSessionId(browser, "");
    safeLog("log", "launch", { sessionId, keepAliveMs: keepAlive, guardrails: Boolean(options.guardrails) });
    const handle = new PuppeteerBrowserHandle(browser as unknown as PuppeteerLikeBrowser, sessionId);
    if (options.viewport) {
      const page = await firstPage(handle);
      if (page) await page.setViewport(options.viewport);
    }
    return handle;
  }

  async connect(sessionId: string, options?: LaunchOptions): Promise<BrowserHandle> {
    const binding = this.assertBinding();
    if (!sessionId) throw new BrowserError("session_not_found", "No browser session id to reconnect to.");
    const browser = await puppeteer.connect(binding, sessionId);
    return new PuppeteerBrowserHandle(browser as unknown as PuppeteerLikeBrowser, sessionId);
  }

  async sessions(): Promise<ProviderSessionInfo[]> {
    if (!this.isAvailable()) return [];
    try {
      const list = await puppeteer.sessions(this.binding as BrowserWorker);
      return list.map((entry) => ({
        sessionId: entry.sessionId,
        startTime: entry.startTime,
        connected: Boolean(entry.connectionId),
      }));
    } catch (error) {
      safeLog("warn", "sessions-failed", String(error));
      return [];
    }
  }

  async limits(): Promise<ProviderLimits | null> {
    if (!this.isAvailable()) return null;
    try {
      const raw = await puppeteer.limits(this.binding as BrowserWorker);
      return {
        activeSessions: raw.activeSessions?.length ?? 0,
        maxConcurrentSessions: raw.maxConcurrentSessions ?? LIMITS.maxSessionsPerAccountHint,
        allowedBrowserAcquisitions: raw.allowedBrowserAcquisitions ?? 1,
        timeUntilNextAllowedBrowserAcquisition: raw.timeUntilNextAllowedBrowserAcquisition ?? 0,
      };
    } catch (error) {
      safeLog("warn", "limits-failed", String(error));
      return null;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.isAvailable() || !sessionId) return;
    try {
      const browser = await puppeteer.connect(this.binding as BrowserWorker, sessionId);
      await browser.close();
      safeLog("log", "session-closed", { sessionId });
    } catch (error) {
      // Session already gone: nothing to do.
      safeLog("warn", "session-close-failed", { sessionId, error: String(error) });
    }
  }

  async ping(sessionId: string): Promise<boolean> {
    if (!this.isAvailable() || !sessionId) return false;
    try {
      const browser = await puppeteer.connect(this.binding as BrowserWorker, sessionId);
      await browser.version();
      await browser.disconnect();
      return true;
    } catch {
      return false;
    }
  }
}

function safeSessionId(browser: unknown, fallback: string): string {
  try {
    const value = (browser as { sessionId?: () => string })?.sessionId?.();
    return value || fallback;
  } catch {
    return fallback;
  }
}

async function firstPage(handle: BrowserHandle) {
  try {
    const pages = await handle.pages();
    return pages[0] ?? null;
  } catch {
    return null;
  }
}

export type { BrowserWorker };
