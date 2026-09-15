/**
 * BrowserProvider abstraction.
 *
 * The MCP tools, the Durable Object session runtime and the legacy one-shot
 * helpers all talk to this interface only. Two implementations exist:
 *
 *  - `CloudflareBrowserProvider` — Cloudflare Browser Run (Workers binding).
 *    Always available in the Worker path.
 *  - `NodeBrowserProvider` — optional, local development only. It is loaded
 *    through a dynamic import with a runtime-computed specifier so it never
 *    enters the Worker bundle and never requires Node APIs at deploy time.
 */

export type ProviderName = "cloudflare" | "node";

export interface ProviderCapabilities {
  /** Persistent, re-attachable browser sessions. */
  sessions: boolean;
  /** Live View URLs (Cloudflare `Cloudflare.getLiveView`). */
  liveView: boolean;
  /** Structured human handoff (Cloudflare `Cloudflare.handoff`). */
  handoff: boolean;
  /** Full-page screenshots beyond the viewport. */
  fullPageScreenshot: boolean;
  /** Screenshot of a single element / clip region. */
  clipScreenshot: boolean;
  /** Accessibility tree snapshots. */
  accessibilitySnapshot: boolean;
  /** Sampling rendered video frames. */
  videoFrames: boolean;
  /** Platform-side egress policy (`guardrails`). */
  guardrails: boolean;
}

export interface AxNode {
  role: string;
  name?: string;
  value?: string | number | boolean;
  description?: string;
  keyshortcuts?: string;
  roledescription?: string;
  valuetext?: string;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  checked?: boolean;
  pressed?: boolean;
  level?: number;
  invalid?: string;
  children?: AxNode[];
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface LaunchOptions {
  /** Browser Run `keep_alive` in ms (10_000 … 600_000). */
  keepAliveMs: number;
  /** Platform-side egress policy, latched for the session lifetime. */
  guardrails?: { allowedDomains?: string[]; allowedDomainSets?: string[] };
  viewport?: Viewport;
  userAgent?: string;
  /** Attach to an existing session instead of acquiring a new one. */
  sessionId?: string;
}

export interface NavigationResult {
  url: string;
  finalUrl: string;
  status: number | null;
  redirected: boolean;
  title: string;
  /** Milliseconds spent navigating. */
  durationMs: number;
}

export type ScreenshotType = "png" | "jpeg" | "webp";

export interface ScreenshotOptions {
  type: ScreenshotType;
  fullPage: boolean;
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number };
  /** Omit the default background for transparent captures. */
  omitBackground?: boolean;
}

export interface LiveViewLink {
  url: string;
  targetId: string | null;
  expiresAtMs: number | null;
  mode: string;
}

export interface HandoffRequest {
  instructions: string;
  timeoutMs: number;
}

export interface HandoffResult {
  handoffId: string;
  targetId: string | null;
}

export interface HandoffState {
  active: boolean;
  handoffId?: string;
  instructions?: string;
  durationMs?: number;
}

export interface PageHandle {
  /** Stable-ish provider id for the underlying target (CDP target id when available). */
  targetId(): Promise<string | null>;
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: WaitUntil; timeoutMs?: number }): Promise<NavigationResult>;
  content(): Promise<string>;
  evaluate<T, A>(pageFunction: (arg: A) => T, arg: A): Promise<T>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  screenshot(options: ScreenshotOptions): Promise<Uint8Array>;
  accessibilitySnapshot(options?: { interestingOnly?: boolean }): Promise<AxNode | null>;
  viewport(): Viewport;
  setViewport(viewport: Viewport): Promise<void>;
  click(target: ElementTarget, timeoutMs: number): Promise<void>;
  type(target: ElementTarget, text: string, options?: { delayMs?: number; clear?: boolean; submit?: boolean }): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  waitForSelector(selector: string, timeoutMs: number, options?: { visible?: boolean }): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<void>;
  waitForNetworkIdle(timeoutMs: number, idleMs: number): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  /** Resolve once the page URL changes away from `fromUrl`. */
  waitForUrlChange(fromUrl: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserHandle {
  /** Platform session id (Browser Run session id). */
  sessionId(): string;
  pages(): Promise<PageHandle[]>;
  newPage(): Promise<PageHandle>;
  /** Detach without terminating the session (keeps it alive per keep_alive). */
  disconnect(): Promise<void>;
  /** Terminate the session immediately. */
  close(): Promise<void>;
  version(): Promise<string>;
  liveView(page: PageHandle, options?: { mode?: "tab" | "devtools" | "full"; expiresInMs?: number }): Promise<LiveViewLink | null>;
  requestHandoff(page: PageHandle, request: HandoffRequest): Promise<HandoffResult | null>;
  handoffState(page: PageHandle): Promise<HandoffState | null>;
}

export interface ProviderSessionInfo {
  sessionId: string;
  startTime: number;
  connected: boolean;
}

export interface ProviderLimits {
  activeSessions: number;
  maxConcurrentSessions: number;
  allowedBrowserAcquisitions: number;
  timeUntilNextAllowedBrowserAcquisition: number;
}

export interface BrowserProvider {
  readonly name: ProviderName;
  /** True when the runtime can actually drive a browser. */
  isAvailable(): boolean;
  /** Why the provider cannot run (null when it can). Surfaced to the model verbatim. */
  unavailableReason(): string | null;
  capabilities(): ProviderCapabilities;
  launch(options: LaunchOptions): Promise<BrowserHandle>;
  connect(sessionId: string, options?: LaunchOptions): Promise<BrowserHandle>;
  sessions(): Promise<ProviderSessionInfo[]>;
  limits(): Promise<ProviderLimits | null>;
  /** Best-effort termination of a platform session we no longer hold. */
  closeSession(sessionId: string): Promise<void>;
  /** Cheap liveness probe (sends one devtools command). */
  ping(sessionId: string): Promise<boolean>;
}

export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

/** How an element is addressed from MCP input. */
export type ElementTarget =
  | { kind: "selector"; value: string }
  | { kind: "text"; value: string; exact?: boolean }
  | { kind: "role"; value: string; name?: string }
  | { kind: "ref"; value: string };

/**
 * Parse a user supplied target string into a structured target.
 *
 * Supported prefixes: `text:`, `role:` (optionally `role:button:Name`),
 * `ref:e12` (snapshot reference), otherwise treated as a CSS selector.
 */
export function parseElementTarget(input: string): ElementTarget {
  const value = input.trim();
  if (!value) throw new Error("Empty element target");
  const lower = value.toLowerCase();
  if (lower.startsWith("text:")) return { kind: "text", value: value.slice(5).trim() };
  if (lower.startsWith("ref:")) return { kind: "ref", value: value.slice(4).trim() };
  if (lower.startsWith("role:")) {
    const rest = value.slice(5).trim();
    const separator = rest.indexOf(":");
    if (separator === -1) return { kind: "role", value: rest };
    return { kind: "role", value: rest.slice(0, separator).trim(), name: rest.slice(separator + 1).trim() };
  }
  return { kind: "selector", value };
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  sessions: false,
  liveView: false,
  handoff: false,
  fullPageScreenshot: true,
  clipScreenshot: true,
  accessibilitySnapshot: true,
  videoFrames: true,
  guardrails: false,
};
