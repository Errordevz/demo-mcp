/**
 * OPTIONAL Node.js provider — local development and tests only.
 *
 * This module is NEVER part of the Cloudflare Worker bundle:
 *
 *   - it is only reached when `BROWSER_PROVIDER=node` is set explicitly, and
 *   - it loads `puppeteer-core` through a dynamic import whose specifier is
 *     computed at runtime, so bundlers cannot resolve it into the Worker.
 *
 * It exists so the same tool surface can be exercised on a laptop (where a real
 * Chrome binary exists) without adding Node-only code to the deploy path.
 * `puppeteer-core` is an optional dependency and is not installed by default:
 *
 *   npm install --no-save puppeteer-core
 *   export CHROME_PATH=/path/to/chrome   # optional, auto-detected when possible
 *   export BROWSER_PROVIDER=node
 */

import { BrowserError } from "../../core/errors.js";
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

/** Local sessions kept alive inside this Node process (dev convenience only). */
const localSessions = new Map<string, { wsEndpoint: string; startedAt: number; browser: unknown }>();

/** Specifier is assembled at runtime so no bundler can statically resolve it. */
const PUPPETEER_CORE_SPECIFIER = ["puppeteer", "core"].join("-");

export function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && Boolean((process as { versions?: Record<string, string> }).versions?.node);
}

type PuppeteerCoreLike = {
  launch: (options: Record<string, unknown>) => Promise<unknown>;
  connect: (options: Record<string, unknown>) => Promise<unknown>;
};

async function loadPuppeteerCore(): Promise<PuppeteerCoreLike> {
  try {
    const mod: unknown = await import(/* @vite-ignore */ PUPPETEER_CORE_SPECIFIER);
    const candidate = (mod as { default?: PuppeteerCoreLike }).default ?? (mod as PuppeteerCoreLike);
    if (typeof candidate?.launch !== "function") throw new Error("puppeteer-core did not export launch()");
    return candidate;
  } catch (error) {
    throw new BrowserError(
      "capability_unavailable",
      "NodeBrowserProvider requires the optional `puppeteer-core` package (npm install --no-save puppeteer-core) and a local Chrome/Chromium binary.",
      { capability: "node_browser_provider", hint: `Set CHROME_PATH or install Chrome. Original error: ${String(error)}` },
    );
  }
}

export interface NodeProviderOptions {
  executablePath?: string;
  headless?: boolean;
}

/** Factory used by the lazy loader in `providers/index.ts`. */
export function createNodeProvider(options: NodeProviderOptions = {}): BrowserProvider {
  return new NodeBrowserProvider(options);
}

export class NodeBrowserProvider implements BrowserProvider {
  readonly name = "node" as const;

  constructor(private readonly options: NodeProviderOptions = {}) {}

  isAvailable(): boolean {
    return isNodeRuntime();
  }

  unavailableReason(): string | null {
    return this.isAvailable()
      ? null
      : "NodeBrowserProvider can only run inside Node.js. The deployed Worker uses CloudflareBrowserProvider instead.";
  }

  capabilities(): ProviderCapabilities {
    return {
      sessions: true,
      liveView: false, // Cloudflare-only feature
      handoff: false, // Cloudflare-only feature
      fullPageScreenshot: true,
      clipScreenshot: true,
      accessibilitySnapshot: true,
      videoFrames: true,
      guardrails: false,
    };
  }

  private async launchOptions(): Promise<Record<string, unknown>> {
    const executablePath = this.options.executablePath ?? process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
    return {
      headless: this.options.headless ?? true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    };
  }

  async launch(options: LaunchOptions): Promise<BrowserHandle> {
    if (!this.isAvailable()) throw new BrowserError("capability_unavailable", this.unavailableReason() ?? "Node runtime unavailable.", { capability: "node_browser_provider" });
    const core = await loadPuppeteerCore();
    const browser = (await core.launch(await this.launchOptions())) as { wsEndpoint?: () => string; close?: () => Promise<void> };
    const wsEndpoint = browser.wsEndpoint?.() ?? "";
    const sessionId = `node-${Math.random().toString(36).slice(2, 10)}`;
    localSessions.set(sessionId, { wsEndpoint, startedAt: Date.now(), browser });
    safeLog("log", "node-launch", { sessionId, viewport: options.viewport ?? null });
    return new PuppeteerBrowserHandle(browser as unknown as PuppeteerLikeBrowser, sessionId);
  }

  async connect(sessionId: string, options?: LaunchOptions): Promise<BrowserHandle> {
    const entry = localSessions.get(sessionId);
    if (!entry) {
      throw new BrowserError(
        "session_expired",
        `Local Node browser session "${sessionId}" is not available in this process.`,
        { retryable: true, hint: "Node sessions live only for the lifetime of the dev process. Re-open the page." },
      );
    }
    const core = await loadPuppeteerCore();
    const browser = (await core.connect({ browserWSEndpoint: entry.wsEndpoint })) as PuppeteerLikeBrowser;
    return new PuppeteerBrowserHandle(browser, sessionId);
  }

  async sessions(): Promise<ProviderSessionInfo[]> {
    return [...localSessions.entries()].map(([sessionId, entry]) => ({
      sessionId,
      startTime: entry.startedAt,
      connected: true,
    }));
  }

  async limits(): Promise<ProviderLimits | null> {
    return {
      activeSessions: localSessions.size,
      maxConcurrentSessions: 8,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = localSessions.get(sessionId);
    if (!entry) return;
    localSessions.delete(sessionId);
    const browser = entry.browser as { close?: () => Promise<void> };
    await browser.close?.().catch(() => undefined);
  }

  async ping(sessionId: string): Promise<boolean> {
    return localSessions.has(sessionId);
  }
}
