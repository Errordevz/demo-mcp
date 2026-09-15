import { JSDOM } from "jsdom";
import vm from "node:vm";
import type {
  AxNode,
  BrowserHandle,
  BrowserProvider,
  ElementTarget,
  LaunchOptions,
  NavigationResult,
  PageHandle,
  ProviderCapabilities,
  ProviderLimits,
  ProviderSessionInfo,
  ScreenshotOptions,
  Viewport,
} from "../../src/browser/types.js";

/**
 * A fake `BrowserProvider` used by the runtime tests.
 *
 * Only the transport is faked: page functions are still serialised with
 * `Function.prototype.toString()` and executed inside a real DOM (jsdom), so
 * `evaluate`, the challenge heuristics, media inspection and the tab/session
 * logic all run exactly as they do against Cloudflare Browser Run.
 */

export interface FakeRoute {
  status?: number;
  html?: string;
  title?: string;
  /** Redirect to another URL in the route table. */
  redirect?: string;
  /** Throw this error message when navigated to (used for timeout tests). */
  failWith?: string;
  /**
   * Scripts run against the loaded DOM window after every navigation that
   * lands on this route (constructor load included). Used to make fake media
   * elements behave like decodable ones (duration, seeked events).
   */
  scripts?: Array<(window: any) => void>;
}

export interface FakeProviderOptions {
  routes?: Record<string, FakeRoute>;
  liveView?: boolean;
  handoff?: boolean;
  /** PNG-ish bytes returned by screenshots. */
  screenshotBytes?: Uint8Array;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

export class FakePage implements PageHandle {
  dom: JSDOM;
  closed = false;
  viewportSize: Viewport = { width: 1280, height: 900 };
  private currentUrl: string;
  private readonly routeTable: Record<string, FakeRoute>;
  private readonly bytes: Uint8Array;

  constructor(
    url: string,
    html: string,
    options: { id: string; routes: Record<string, FakeRoute>; bytes: Uint8Array },
  ) {
    this.currentUrl = url;
    this.routeTable = options.routes;
    this.bytes = options.bytes;
    this.targetIdValue = options.id;
    this.dom = new JSDOM(html || "<html><body></body></html>", { url, runScripts: "outside-only", pretendToBeVisual: true });
    this.applyRouteScripts();
  }

  /** Run the scripts registered for the route currently loaded in the DOM. */
  private applyRouteScripts(): void {
    const scripts = this.routeTable[this.currentUrl]?.scripts ?? [];
    for (const script of scripts) script(this.dom.window);
  }

  private targetIdValue: string;

  async targetId(): Promise<string | null> {
    return this.targetIdValue;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.dom.window.document.title ?? "";
  }

  async goto(url: string, options?: { waitUntil?: string; timeoutMs?: number }): Promise<NavigationResult> {
    const startedAt = Date.now();
    let target = url;
    let status: number | null = null;
    for (let hop = 0; hop < 5; hop++) {
      const route = this.routeTable[target];
      if (!route) {
        this.currentUrl = target;
        this.load("<html><head><title>Not found</title></head><body>Page not found</body></html>", target);
        status = 404;
        return { url, finalUrl: target, status, redirected: target !== url, title: "Not found", durationMs: Date.now() - startedAt };
      }
      if (route.failWith) throw new Error(route.failWith);
      if (route.redirect) {
        target = route.redirect;
        continue;
      }
      status = route.status ?? 200;
      this.currentUrl = target;
      this.load(route.html ?? "", target);
      return {
        url,
        finalUrl: target,
        status,
        redirected: target !== url,
        title: route.title ?? this.dom.window.document.title,
        durationMs: Date.now() - startedAt,
      };
    }
    throw new Error("Too many redirects");
  }

  load(html: string, url: string): void {
    this.dom.window.close();
    this.dom = new JSDOM(html || "<html><body></body></html>", { url, runScripts: "outside-only", pretendToBeVisual: true });
    this.applyRouteScripts();
  }

  async content(): Promise<string> {
    return this.dom.window.document.documentElement.outerHTML;
  }

  async evaluate<T, A>(pageFunction: (arg: A) => T, arg: A): Promise<T>;
  async evaluate<T>(pageFunction: () => T): Promise<T>;
  async evaluate<T, A>(pageFunction: ((arg: A) => T) | (() => T), arg?: A): Promise<T> {
    const context = this.dom.getInternalVMContext();
    const source = arg === undefined ? `(${pageFunction.toString()})()` : `(${pageFunction.toString()})(${JSON.stringify(arg)})`;
    const result = new vm.Script(source).runInContext(context);
    return result as T;
  }

  async screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    void options;
    return this.bytes;
  }

  async accessibilitySnapshot(): Promise<AxNode | null> {
    return {
      role: "RootWebArea",
      name: await this.title(),
      children: [
        { role: "heading", name: "Hello", level: 1 },
        { role: "button", name: "Play" },
        { role: "link", name: "More", children: [] },
      ],
    };
  }

  viewport(): Viewport {
    return this.viewportSize;
  }

  async setViewport(viewport: Viewport): Promise<void> {
    this.viewportSize = viewport;
  }

  async click(target: ElementTarget, timeoutMs: number): Promise<void> {
    void timeoutMs;
    if (target.kind === "selector" && !this.dom.window.document.querySelector(target.value)) {
      throw new Error(`No node found for selector: ${target.value}`);
    }
    if (target.kind === "selector" && target.value.startsWith("http")) {
      await this.goto(target.value, {});
    }
  }

  async type(target: ElementTarget, text: string): Promise<void> {
    void text;
    if (target.kind === "selector" && !this.dom.window.document.querySelector(target.value)) {
      throw new Error(`No node found for selector: ${target.value}`);
    }
  }

  async scroll(): Promise<void> {
    /* no-op in the fake DOM */
  }

  async waitForSelector(selector: string, timeoutMs: number): Promise<void> {
    if (!this.dom.window.document.querySelector(selector)) {
      throw new Error(`Waiting for selector \`${selector}\` failed: timeout ${timeoutMs}ms exceeded`);
    }
  }

  async waitForText(text: string, timeoutMs: number): Promise<void> {
    const body = this.dom.window.document.body?.textContent ?? "";
    if (!body.toLowerCase().includes(text.toLowerCase())) {
      throw new Error(`Waiting for text \`${text}\` failed: timeout ${timeoutMs}ms exceeded`);
    }
  }

  async waitForNetworkIdle(): Promise<void> {
    /* no-op */
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50)));
  }

  async waitForUrlChange(fromUrl: string): Promise<string> {
    if (this.currentUrl === fromUrl) throw new Error("URL did not change");
    return this.currentUrl;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.dom.window.close();
  }
}

export class FakeBrowser implements BrowserHandle {
  pages$: FakePage[] = [];
  disconnected = false;
  closed = false;
  private counter = 0;

  constructor(
    private readonly id: string,
    initial: FakePage | null,
    private readonly options: { liveView: boolean; handoff: boolean; routes: Record<string, FakeRoute>; screenshotBytes?: Uint8Array },
  ) {
    if (initial) this.pages$.push(initial);
  }

  sessionId(): string {
    return this.id;
  }

  async pages(): Promise<PageHandle[]> {
    return this.pages$.filter((page) => !page.closed) as unknown as PageHandle[];
  }

  async newPage(): Promise<PageHandle> {
    this.counter += 1;
    const page = new FakePage("about:blank", "<html><body></body></html>", {
      id: `target-${this.id}-${this.counter}`,
      routes: this.options.routes,
      bytes: this.options.screenshotBytes ?? PNG_BYTES,
    });
    this.pages$.push(page);
    return page as unknown as PageHandle;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async version(): Promise<string> {
    return "Chrome/131.0.0.0 (fake)";
  }

  async liveView(): Promise<{ url: string; targetId: string | null; expiresAtMs: number; mode: string } | null> {
    if (!this.options.liveView) return null;
    return { url: `https://live.browser.run/session/${this.id}?tab=1`, targetId: "target-1", expiresAtMs: Date.now() + 300_000, mode: "tab" };
  }

  async requestHandoff(): Promise<{ handoffId: string; targetId: string | null } | null> {
    if (!this.options.handoff) return null;
    return { handoffId: `handoff-${this.id}`, targetId: "target-1" };
  }

  async handoffState(): Promise<{ active: boolean; handoffId?: string; durationMs?: number } | null> {
    if (!this.options.handoff) return null;
    return { active: FakeBrowser.handoffActive, handoffId: `handoff-${this.id}`, durationMs: 1_000 };
  }

  static handoffActive = true;
}

export class FakeProvider implements BrowserProvider {
  readonly name = "cloudflare" as const;
  launches = 0;
  connects = 0;
  browsers: FakeBrowser[] = [];
  /** Set to false to simulate an environment without the Browser Run binding. */
  available = true;
  /** Set to a string to make every launch fail (e.g. rate limiting). */
  launchError: string | null = null;

  constructor(private readonly options: FakeProviderOptions = {}) {}

  isAvailable(): boolean {
    return this.available;
  }

  unavailableReason(): string | null {
    return this.available ? null : "Cloudflare Browser Run is not configured for this Worker.";
  }

  capabilities(): ProviderCapabilities {
    return {
      sessions: true,
      liveView: this.options.liveView ?? true,
      handoff: this.options.handoff ?? true,
      fullPageScreenshot: true,
      clipScreenshot: true,
      accessibilitySnapshot: true,
      videoFrames: true,
      guardrails: true,
    };
  }

  async launch(options: LaunchOptions): Promise<BrowserHandle> {
    void options;
    if (!this.available) throw new Error("Browser binding missing");
    if (this.launchError) throw new Error(this.launchError);
    this.launches += 1;
    const browser = new FakeBrowser(`session-${this.launches}`, null, {
      liveView: this.options.liveView ?? true,
      handoff: this.options.handoff ?? true,
      routes: this.options.routes ?? {},
      screenshotBytes: this.options.screenshotBytes,
    });
    this.browsers.push(browser);
    return browser;
  }

  async connect(sessionId: string): Promise<BrowserHandle> {
    this.connects += 1;
    const found = this.browsers.find((browser) => browser.sessionId() === sessionId);
    if (!found) throw new Error(`Unable to connect to existing session ${sessionId}`);
    return found;
  }

  async sessions(): Promise<ProviderSessionInfo[]> {
    return this.browsers.map((browser) => ({ sessionId: browser.sessionId(), startTime: Date.now(), connected: !browser.disconnected }));
  }

  async limits(): Promise<ProviderLimits | null> {
    return { activeSessions: this.browsers.length, maxConcurrentSessions: 30, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
  }

  async closeSession(sessionId: string): Promise<void> {
    const found = this.browsers.find((browser) => browser.sessionId() === sessionId);
    if (found) await found.close();
  }

  async ping(sessionId: string): Promise<boolean> {
    return this.browsers.some((browser) => browser.sessionId() === sessionId && !browser.closed);
  }
}

/** In-memory stand-in for the R2 bucket. */
export class FakeObjectStore {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { customMetadata?: Record<string, string> }): Promise<void> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes, metadata: options?.customMetadata ?? {} });
  }
}
