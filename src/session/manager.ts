/**
 * SessionManager — the Worker-side entry point for every browser tool.
 *
 * Two backends, one interface:
 *
 *  - **Durable Object** (`BROWSER_SESSIONS` binding): sessions, tabs and
 *    human-in-the-loop pause state survive across MCP calls and across Worker
 *    isolates. This is the supported production path.
 *  - **In-process fallback**: used when the DO binding is missing (for example
 *    before the binding is deployed). Sessions then live only as long as the
 *    isolate; the tools report `sessionStorage: "memory"` so nobody mistakes it
 *    for durable state.
 *
 * One-shot legacy helpers go through `withRawPage`, which acquires a browser,
 * runs the work and always closes the session afterwards.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { safeLog } from "../core/redact.js";
import type { PuppeteerPageHandle } from "../browser/providers/puppeteer-adapter.js";
import type { SessionState } from "../browser/runtime.js";
import { SessionFacade, type SessionClient } from "./facade.js";
import {
  createBrowserDependencies,
  createRuntime,
  newSessionState,
  providerName,
  resolveScreenshotBase,
  type BrowserDependencies,
  type BrowserEnv,
} from "./factory.js";

export interface DurableNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): any;
}

export interface SessionManagerEnv extends BrowserEnv {
  BROWSER_SESSIONS?: DurableNamespaceLike;
}

/** Isolate-local fallback registry (bounded). */
const localSessions = new Map<string, SessionState>();
const MAX_LOCAL_SESSIONS = 12;

export interface BrowserCapabilities {
  provider: string;
  browserAvailable: boolean;
  reason: string | null;
  sessionStorage: "durable-object" | "memory";
  screenshots: boolean;
  screenshotReason: string | null;
  liveView: boolean;
  handoff: boolean;
  videoFrames: boolean;
  guardrails: boolean;
  accessibilitySnapshot: boolean;
  fullPageScreenshot: boolean;
  ssrfDnsCheck: boolean;
  keepAliveMs: number;
}

export class SessionManager {
  private dependencies: BrowserDependencies | null = null;

  constructor(
    private readonly env: SessionManagerEnv,
    private readonly requestUrl: string | null = null,
  ) {}

  private deps(): BrowserDependencies {
    if (!this.dependencies) {
      this.dependencies = createBrowserDependencies(this.env, resolveScreenshotBase(this.env, this.requestUrl));
    }
    return this.dependencies;
  }

  get durable(): boolean {
    return Boolean(this.env.BROWSER_SESSIONS);
  }

  capabilities(): BrowserCapabilities {
    const deps = this.deps();
    const provider = deps.provider;
    const available = provider.isAvailable();
    const caps = provider.capabilities();
    return {
      provider: provider.name,
      browserAvailable: available,
      reason: provider.unavailableReason(),
      sessionStorage: this.durable ? "durable-object" : "memory",
      screenshots: deps.managers.screenshots.available,
      screenshotReason: deps.managers.screenshots.unavailableReason(),
      // Platform capabilities only count when the browser binding is really usable.
      liveView: available && caps.liveView,
      handoff: available && caps.handoff,
      videoFrames: available && caps.videoFrames,
      guardrails: available && caps.guardrails,
      accessibilitySnapshot: available && caps.accessibilitySnapshot,
      fullPageScreenshot: available && caps.fullPageScreenshot,
      ssrfDnsCheck: String(this.env.SSRF_DNS_CHECK ?? "true").toLowerCase() !== "false",
      keepAliveMs: deps.keepAliveMs,
    };
  }

  /** Validate a caller supplied session id, or mint a fresh one. */
  sessionId(raw?: string | null): string {
    if (!raw) return `s-${randomToken(20)}`;
    const cleaned = String(raw).trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cleaned)) {
      throw new BrowserError("invalid_input", "session_id must be 1-64 characters using A-Z, a-z, 0-9, _ or -.", {
        hint: "Omit session_id to have DEMO create one, or reuse the value returned by browser_open.",
      });
    }
    return cleaned;
  }

  pageId(raw?: string | null): string | null {
    const cleaned = String(raw ?? "").trim();
    if (!cleaned) return null;
    if (!/^p\d{1,6}$/.test(cleaned)) {
      throw new BrowserError("invalid_input", "page_id must look like p1, p2, … (use browser_tabs to list them).");
    }
    return cleaned;
  }

  /** Resolve the session client for a (possibly new) session. */
  async client(sessionId: string): Promise<SessionClient> {
    const namespace = this.env.BROWSER_SESSIONS;
    if (namespace) {
      const stub = namespace.get(namespace.idFromName(sessionId));
      await stub.ensure(sessionId, { keepAliveMs: this.deps().keepAliveMs });
      return createDurableClient(stub);
    }
    return this.localClient(sessionId);
  }

  private localClient(sessionId: string): SessionClient {
    let state = localSessions.get(sessionId);
    if (!state) {
      if (localSessions.size >= MAX_LOCAL_SESSIONS) {
        const oldest = [...localSessions.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
        if (oldest) {
          void this.closeLocal(oldest[0]);
          localSessions.delete(oldest[0]);
        }
      }
      state = newSessionState(sessionId, this.env);
      localSessions.set(sessionId, state);
    }
    const deps = this.deps();
    const runtime = createRuntime(state, deps, {
      persist: async (next) => {
        localSessions.set(sessionId, next);
      },
    });
    return new SessionFacade(runtime);
  }

  private async closeLocal(sessionId: string): Promise<void> {
    const state = localSessions.get(sessionId);
    if (!state?.providerSessionId) return;
    try {
      await this.deps().provider.closeSession(state.providerSessionId);
    } catch (error) {
      safeLog("warn", "local-session-close-failed", String(error));
    }
  }

  /** Close and forget a session (both backends). */
  async closeSession(sessionId: string): Promise<{ sessionId: string; closed: boolean; storage: "durable-object" | "memory" }> {
    const namespace = this.env.BROWSER_SESSIONS;
    if (namespace) {
      const stub = namespace.get(namespace.idFromName(sessionId));
      const result = await stub.close();
      return { sessionId, ...result, storage: "durable-object" };
    }
    const client = this.localClient(sessionId);
    const result = await client.close();
    localSessions.delete(sessionId);
    return { sessionId, closed: result.closed, storage: "memory" };
  }

  /**
   * One-shot browser session for the legacy tools: acquire, run, always close.
   * The work function receives the raw Puppeteer page so existing behaviour is
   * preserved exactly.
   */
  async withRawPage<T>(work: (page: any) => Promise<T>, options: { keepAliveMs?: number } = {}): Promise<T> {
    const provider = this.deps().provider;
    if (!provider.isAvailable()) {
      throw new BrowserError("capability_unavailable", provider.unavailableReason() ?? "Browser unavailable.", {
        capability: "cloudflare_browser_run",
      });
    }
    const browser = await provider.launch({ keepAliveMs: options.keepAliveMs ?? LIMITS.keepAliveMinMs });
    try {
      const pages = await browser.pages();
      const page = pages[0] ?? (await browser.newPage());
      const raw = typeof (page as PuppeteerPageHandle).raw === "function" ? (page as PuppeteerPageHandle).raw() : page;
      return await work(raw);
    } finally {
      await browser.close().catch((error: unknown) => safeLog("warn", "ephemeral-close-failed", String(error)));
    }
  }

  provider(): BrowserDependencies {
    return this.deps();
  }
}

function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, length);
}

/**
 * Typed RPC proxy for the Durable Object. Every method call is forwarded to the
 * DO, so the tool layer is identical for both backends.
 */
function createDurableClient(stub: any): SessionClient {
  const cache = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy({} as SessionClient, {
    get(_target, property: string) {
      if (typeof property !== "string") return undefined;
      if (property === "then") return undefined;
      const cached = cache.get(property);
      if (cached) return cached;
      const method = (...args: unknown[]) => stub[property](...args);
      cache.set(property, method);
      return method;
    },
  });
}

export function providerLabel(env: SessionManagerEnv): string {
  return providerName(env);
}
