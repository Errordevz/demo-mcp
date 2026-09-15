/**
 * Puppeteer-backed implementation of the provider interfaces.
 *
 * This adapter is deliberately written against a *structural* subset of the
 * Puppeteer API so the same class can drive:
 *
 *  - `@cloudflare/puppeteer` (Worker path, Cloudflare Browser Run), and
 *  - `puppeteer-core` (optional local development path).
 *
 * Only type-level imports are used, so nothing from Puppeteer is required at
 * runtime by modules that merely import the abstraction.
 */

import type { AxNode, BrowserHandle, ElementTarget, HandoffRequest, HandoffResult, HandoffState, LiveViewLink, NavigationResult, PageHandle, ScreenshotOptions, Viewport, WaitUntil } from "../types.js";

/** The minimal shape of a Puppeteer page this adapter relies on. */
export interface PuppeteerLikePage {
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  content(): Promise<string>;
  close(): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number; referer?: string }): Promise<{ status(): number } | null>;
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array | ArrayBuffer | string>;
  setViewport(viewport: Record<string, unknown>): Promise<void>;
  evaluate(pageFunction: unknown, ...args: unknown[]): Promise<unknown>;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForFunction(pageFunction: unknown, options?: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
  waitForNetworkIdle(options?: Record<string, unknown>): Promise<unknown>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  focus?(selector: string): Promise<void>;
  keyboard: { type(text: string, options?: Record<string, unknown>): Promise<void>; press(key: string): Promise<void> };
  createCDPSession(): Promise<PuppeteerLikeCDPSession>;
  target(): { url(): string; _targetId?: string };
  accessibility?: { snapshot(options?: Record<string, unknown>): Promise<AxNode | null> };
}

export interface PuppeteerLikeCDPSession {
  send(method: string, params?: unknown): Promise<unknown>;
  detach(): Promise<void>;
  once?(event: string, listener: (payload: unknown) => void): unknown;
}

export interface PuppeteerLikeBrowser {
  version(): Promise<string>;
  pages(): Promise<PuppeteerLikePage[]>;
  newPage(): Promise<PuppeteerLikePage>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  sessionId?(): string;
}

function toBytes(value: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof value === "string") {
    // Puppeteer returns base64 for `encoding: 'base64'`; not used here but kept
    // for completeness with the Node provider.
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

function asSelector(target: ElementTarget): string {
  switch (target.kind) {
    case "selector":
      return target.value;
    case "text": {
      const escaped = target.value.replace(/"/g, '\\"');
      if (target.exact === false) return `::-p-text(${escaped})`;
      return `::-p-text(${escaped})`;
    }
    case "role": {
      const role = target.value.replace(/"/g, '\\"');
      const name = target.name ? `[name="${target.name.replace(/"/g, '\\"')}"]` : "";
      return `::-p-aria(${role}${name})`;
    }
    case "ref":
      return `[data-demo-ref="${target.value.replace(/"/g, '\\"')}"]`;
    default:
      return String((target as { value?: string }).value ?? "");
  }
}

export class PuppeteerPageHandle implements PageHandle {
  constructor(private readonly page: PuppeteerLikePage) {}

  raw(): PuppeteerLikePage {
    return this.page;
  }

  async targetId(): Promise<string | null> {
    try {
      const cdp = await this.page.createCDPSession();
      try {
        const result = (await cdp.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } } | null;
        if (result?.targetInfo?.targetId) return result.targetInfo.targetId;
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch {
      // Fall through to the internal target id.
    }
    return this.page.target()?._targetId ?? null;
  }

  url(): string {
    try {
      return this.page.url();
    } catch {
      return "";
    }
  }

  async title(): Promise<string> {
    try {
      return await this.page.title();
    } catch {
      return "";
    }
  }

  async goto(url: string, options?: { waitUntil?: WaitUntil; timeoutMs?: number }): Promise<NavigationResult> {
    const startedAt = Date.now();
    const requested = url;
    const response = await this.page.goto(url, {
      waitUntil: options?.waitUntil ?? "domcontentloaded",
      timeout: options?.timeoutMs ?? 45_000,
    });
    const finalUrl = this.url();
    let status: number | null = null;
    try {
      status = response?.status() ?? null;
    } catch {
      status = null;
    }
    return {
      url: requested,
      finalUrl,
      status,
      redirected: finalUrl !== requested,
      title: await this.title(),
      durationMs: Date.now() - startedAt,
    };
  }

  async content(): Promise<string> {
    return await this.page.content();
  }

  async evaluate<T, A>(pageFunction: (arg: A) => T, arg: A): Promise<T>;
  async evaluate<T>(pageFunction: () => T): Promise<T>;
  async evaluate<T, A>(pageFunction: ((arg: A) => T) | (() => T), arg?: A): Promise<T> {
    const fn = pageFunction as unknown;
    const result = arg === undefined ? await this.page.evaluate(fn) : await this.page.evaluate(fn, arg);
    return result as T;
  }

  async screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    const payload: Record<string, unknown> = { type: options.type, fullPage: options.fullPage };
    if (options.quality !== undefined && options.type !== "png") payload.quality = options.quality;
    if (options.clip) payload.clip = options.clip;
    if (options.omitBackground) payload.omitBackground = true;
    if (options.clip) payload.captureBeyondViewport = false;
    return toBytes(await this.page.screenshot(payload));
  }

  async accessibilitySnapshot(options?: { interestingOnly?: boolean }): Promise<AxNode | null> {
    if (!this.page.accessibility) return null;
    return await this.page.accessibility.snapshot({ interestingOnly: options?.interestingOnly ?? true });
  }

  viewport(): Viewport {
    return { width: 1280, height: 900 };
  }

  async setViewport(viewport: Viewport): Promise<void> {
    await this.page.setViewport({
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    });
  }

  async click(target: ElementTarget, timeoutMs: number): Promise<void> {
    const selector = asSelector(target);
    await this.page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
    await this.page.click(selector, { timeout: timeoutMs });
  }

  async type(target: ElementTarget, text: string, options?: { delayMs?: number; clear?: boolean; submit?: boolean }): Promise<void> {
    const selector = asSelector(target);
    await this.page.waitForSelector(selector, { timeout: 20_000, visible: true });
    await this.page.click(selector);
    if (options?.clear !== false) {
      await this.page.evaluate((sel: string) => {
        const element = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!element) return;
        if (typeof element.select === "function") element.select();
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, selector);
    }
    await this.page.keyboard.type(text, { delay: options?.delayMs ?? 0 });
    if (options?.submit) await this.page.keyboard.press("Enter");
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.page.evaluate(
      (arg: { x: number; y: number }) => {
        window.scrollBy({ top: arg.y, left: arg.x, behavior: "auto" });
      },
      { x: deltaX, y: deltaY },
    );
  }

  async waitForSelector(selector: string, timeoutMs: number, options?: { visible?: boolean }): Promise<void> {
    await this.page.waitForSelector(selector, { timeout: timeoutMs, visible: options?.visible ?? true });
  }

  async waitForText(text: string, timeoutMs: number): Promise<void> {
    await this.page.waitForFunction(
      (needle: string) => (document.body?.innerText ?? "").toLowerCase().includes(needle.toLowerCase()),
      { timeout: timeoutMs, polling: 500 },
      text,
    );
  }

  async waitForNetworkIdle(timeoutMs: number, idleMs: number): Promise<void> {
    await this.page.waitForNetworkIdle({ idleTime: idleMs, timeout: timeoutMs });
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForUrlChange(fromUrl: string, timeoutMs: number): Promise<string> {
    await this.page.waitForFunction(
      (previous: string) => location.href !== previous,
      { timeout: timeoutMs, polling: 500 },
      fromUrl,
    );
    return this.url();
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

export class PuppeteerBrowserHandle implements BrowserHandle {
  constructor(
    private readonly browser: PuppeteerLikeBrowser,
    private readonly id: string,
  ) {}

  raw(): PuppeteerLikeBrowser {
    return this.browser;
  }

  sessionId(): string {
    if (this.id) return this.id;
    try {
      return this.browser.sessionId?.() ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  async pages(): Promise<PageHandle[]> {
    const pages = await this.browser.pages();
    return pages.filter((page) => !page.isClosed()).map((page) => new PuppeteerPageHandle(page));
  }

  async newPage(): Promise<PageHandle> {
    return new PuppeteerPageHandle(await this.browser.newPage());
  }

  async disconnect(): Promise<void> {
    await this.browser.disconnect();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  async version(): Promise<string> {
    return await this.browser.version();
  }

  private async withCdp<T>(page: PageHandle, fn: (cdp: PuppeteerLikeCDPSession) => Promise<T>): Promise<T | null> {
    const raw = page instanceof PuppeteerPageHandle ? page.raw() : undefined;
    if (!raw) return null;
    let cdp: PuppeteerLikeCDPSession | undefined;
    try {
      cdp = await raw.createCDPSession();
      return await fn(cdp);
    } catch {
      // Cloudflare-only CDP domain: unsupported on plain Chromium or older
      // platform builds. Callers degrade gracefully.
      return null;
    } finally {
      if (cdp) await cdp.detach().catch(() => undefined);
    }
  }

  async liveView(page: PageHandle, options?: { mode?: "tab" | "devtools" | "full"; expiresInMs?: number }): Promise<LiveViewLink | null> {
    const expiresInMs = options?.expiresInMs ?? 300_000;
    const mode = options?.mode ?? "tab";
    return await this.withCdp(page, async (cdp) => {
      const result = (await cdp.send("Cloudflare.getLiveView", { mode, expiresInMs })) as {
        devtoolsFrontendUrl?: string;
        id?: string;
      } | null;
      if (!result?.devtoolsFrontendUrl) return null;
      return {
        url: result.devtoolsFrontendUrl,
        targetId: result.id ?? null,
        expiresAtMs: Date.now() + expiresInMs,
        mode,
      };
    });
  }

  async requestHandoff(page: PageHandle, request: HandoffRequest): Promise<HandoffResult | null> {
    return await this.withCdp(page, async (cdp) => {
      const result = (await cdp.send("Cloudflare.handoff", {
        instructions: request.instructions.slice(0, 4096),
        timeout: Math.min(request.timeoutMs, 1_800_000),
      })) as { handoffId?: string; targetId?: string } | null;
      if (!result?.handoffId) return null;
      return { handoffId: result.handoffId, targetId: result.targetId ?? null };
    });
  }

  async handoffState(page: PageHandle): Promise<HandoffState | null> {
    return await this.withCdp(page, async (cdp) => {
      const result = (await cdp.send("Cloudflare.getHandoffState")) as HandoffState | null;
      return result ?? null;
    });
  }
}
