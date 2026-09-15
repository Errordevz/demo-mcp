/**
 * `BrowserSession` Durable Object.
 *
 * Browser state must survive between MCP calls (open a URL, then click, then
 * screenshot) while the Worker itself stays stateless. The Durable Object holds
 * the Browser Run session id, the tab registry and the paused-for-human state;
 * every call re-attaches to the platform session through
 * `provider.connect(sessionId)` and detaches when the operation finishes, so
 * the browser survives according to its `keep_alive` window (up to 10 minutes)
 * without any process staying alive.
 *
 * The DO also runs the heartbeat alarm that keeps a paused session warm while a
 * human completes a CAPTCHA or login — and it gracefully stops when the pause
 * window expires.
 */

import { DurableObject } from "cloudflare:workers";
import type { ElementTarget, ScreenshotType, WaitUntil } from "../browser/types.js";
import type { FrameSamplingOptions } from "../browser/media.js";
import type { CaptureOptions, OpenOptions, ReadOptions, ScrollDirection, SnapshotOptions, WaitSpec } from "../browser/ops.js";
import type { SessionState } from "../browser/runtime.js";
import { LIMITS, clampKeepAlive } from "../core/limits.js";
import { safeLog } from "../core/redact.js";
import { encodeForRpc } from "../core/errors.js";
import { SessionFacade } from "./facade.js";
import {
  createBrowserDependencies,
  createRuntime,
  newSessionState,
  resolveScreenshotBase,
  type BrowserDependencies,
  type BrowserEnv,
} from "./factory.js";

export type BrowserSessionEnv = BrowserEnv;

const STATE_KEY = "session";
const HEARTBEAT_MS = LIMITS.heartbeatIntervalMs;

export class BrowserSession extends DurableObject<BrowserSessionEnv> {
  private cached: SessionState | null = null;
  private dependencies: BrowserDependencies | null = null;

  private deps(): BrowserDependencies {
    if (!this.dependencies) {
      this.dependencies = createBrowserDependencies(this.env, resolveScreenshotBase(this.env, null));
    }
    return this.dependencies;
  }

  private async load(sessionId?: string | null): Promise<SessionState> {
    if (this.cached) {
      if (sessionId && this.cached.sessionId !== sessionId) this.cached.sessionId = sessionId;
      return this.cached;
    }
    const stored = (await this.ctx.storage.get<SessionState>(STATE_KEY)) ?? null;
    if (stored) {
      this.cached = stored;
      if (sessionId && stored.sessionId !== sessionId) {
        stored.sessionId = sessionId;
        await this.save();
      }
      return stored;
    }
    const created = newSessionState(sessionId ?? this.ctx.id.toString(), this.env);
    if (this.deps().guardrails) created.guardrails = this.deps().guardrails;
    this.cached = created;
    await this.save();
    return created;
  }

  private async save(): Promise<void> {
    if (this.cached) await this.ctx.storage.put(STATE_KEY, this.cached);
  }

  private async facade(sessionId?: string | null): Promise<SessionFacade> {
    const state = await this.load(sessionId);
    const deps = this.deps();
    const runtime = createRuntime(state, deps, {
      persist: async (next) => {
        this.cached = next;
        await this.save();
      },
      scheduleHeartbeat: async (atMs) => {
        await this.ctx.storage.setAlarm(atMs);
      },
    });
    return new SessionFacade(runtime);
  }

  private async run<T>(sessionId: string | null | undefined, work: (facade: SessionFacade) => Promise<T>): Promise<T> {
    const facade = await this.facade(sessionId);
    let result!: T;
    let failure: unknown = null;
    // Serialise operations for this session: two concurrent MCP calls must never
    // mutate the tab registry at the same time.
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        result = await work(facade);
      } catch (error) {
        failure = error;
      }
    });
    await this.save();
    if (failure) {
      // RPC strips the error class, so carry the structured details across.
      throw encodeForRpc(failure);
    }
    return result;
  }

  /* ------------------------------------------------------------- lifecycle */

  async ensure(sessionId: string, options: { keepAliveMs?: number } = {}) {
    const state = await this.load(sessionId);
    if (options.keepAliveMs) state.keepAliveMs = clampKeepAlive(options.keepAliveMs);
    await this.save();
    return { ...(await this.facade(sessionId).then((facade) => facade.summary())), storage: "durable-object" as const };
  }

  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state?.paused || !state.providerSessionId) return;
    if (Date.now() > state.paused.pauseUntil) {
      safeLog("log", "pause-expired", { sessionId: state.sessionId, pageId: state.paused.pageId });
      state.paused = null;
      await this.save();
      return;
    }
    const facade = await this.facade();
    const { alive } = await facade.heartbeat();
    if (!alive) {
      await this.save();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  /* ------------------------------------------------------------------ RPC */

  async summary() {
    return await this.run(null, (facade) => facade.summary());
  }

  async open(pageId: string | null | undefined, url: string, options: OpenOptions = {}) {
    return await this.run(null, (facade) => facade.open(pageId, url, options));
  }

  async screenshot(pageId: string | null | undefined, options: CaptureOptions = {}) {
    return await this.run(null, (facade) => facade.screenshot(pageId, options));
  }

  async read(pageId: string | null | undefined, options: ReadOptions = {}) {
    return await this.run(null, (facade) => facade.read(pageId, options));
  }

  async snapshot(pageId: string | null | undefined, options: SnapshotOptions = {}) {
    return await this.run(null, (facade) => facade.snapshot(pageId, options));
  }

  async click(pageId: string | null | undefined, target: ElementTarget, options: { timeoutMs?: number; screenshotAfter?: boolean } = {}) {
    return await this.run(null, (facade) => facade.click(pageId, target, options));
  }

  async type(pageId: string | null | undefined, target: ElementTarget, text: string, options: { secret?: boolean; clear?: boolean; submit?: boolean } = {}) {
    return await this.run(null, (facade) => facade.type(pageId, target, text, options));
  }

  async scroll(pageId: string | null | undefined, direction: ScrollDirection, amount: number) {
    return await this.run(null, (facade) => facade.scroll(pageId, direction, amount));
  }

  async wait(pageId: string | null | undefined, spec: WaitSpec) {
    return await this.run(null, (facade) => facade.wait(pageId, spec));
  }

  async mediaInfo(pageId: string | null | undefined, options: { selector?: string | null } = {}) {
    return await this.run(null, (facade) => facade.mediaInfo(pageId, options));
  }

  async videoFrames(pageId: string | null | undefined, options: FrameSamplingOptions = {}) {
    return await this.run(null, (facade) => facade.videoFrames(pageId, options));
  }

  async challengeStatus(pageId: string | null | undefined, options: { screenshot?: boolean; type?: ScreenshotType } = {}) {
    return await this.run(null, (facade) => facade.challengeStatus(pageId, options));
  }

  async pauseForHuman(
    pageId: string | null | undefined,
    options: { instructions?: string; timeoutMs?: number; screenshot?: boolean; mode?: "tab" | "devtools" | "full" } = {},
  ) {
    return await this.run(null, (facade) => facade.pauseForHuman(pageId, options));
  }

  async resume(pageId: string | null | undefined, options: { screenshot?: boolean; reload?: boolean; waitMs?: number } = {}) {
    return await this.run(null, (facade) => facade.resume(pageId, options));
  }

  async listTabs() {
    return await this.run(null, (facade) => facade.listTabs());
  }

  async newTab(url: string | null, options: { waitUntil?: WaitUntil; timeoutMs?: number } = {}) {
    return await this.run(null, (facade) => facade.newTab(url, options));
  }

  async closeTab(pageId: string) {
    return await this.run(null, (facade) => facade.closeTab(pageId));
  }

  async selectTab(pageId: string) {
    return await this.run(null, (facade) => facade.selectTab(pageId));
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.run(null, (facade) => facade.setViewport(width, height).then(() => undefined));
  }

  async close() {
    return await this.run(null, (facade) => facade.close());
  }

  async heartbeat() {
    return await this.run(null, (facade) => facade.heartbeat());
  }

  async destroy(): Promise<{ destroyed: boolean }> {
    await this.run(null, (facade) => facade.close());
    await this.ctx.storage.deleteAll();
    this.cached = null;
    return { destroyed: true };
  }
}

export default BrowserSession;
