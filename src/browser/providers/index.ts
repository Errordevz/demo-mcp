/**
 * Provider factory.
 *
 * The Worker path always resolves to `CloudflareBrowserProvider`. The Node
 * provider is only constructed when a deployment explicitly opts in
 * (`BROWSER_PROVIDER=node`) *and* the code runs in Node.js; it is loaded through
 * a runtime-computed dynamic import so it never lands in the Cloudflare bundle.
 */

import { BrowserError } from "../../core/errors.js";
import type { BrowserProvider, LaunchOptions, ProviderCapabilities, ProviderName } from "../types.js";
import { CloudflareBrowserProvider } from "./cloudflare.js";

export interface ProviderEnv {
  BROWSER?: unknown;
  BROWSER_PROVIDER?: string;
  BROWSER_MAX_SESSIONS?: string | number;
  CHROME_PATH?: string;
}

/** Not statically analyzable: keeps the Node-only module out of Worker bundles. */
const NODE_PROVIDER_MODULE = ["../providers", "node.js"].join("/");

/**
 * Test seam: lets offline suites replace the provider factory (for example
 * with `FakeProvider`). Production code never sets it; passing `null` restores
 * the real factory. It is a runtime value, not an import, so it cannot pull
 * test-only code into the Worker bundle.
 */
let providerFactoryOverride: ((env: ProviderEnv) => BrowserProvider) | null = null;

export function setProviderFactory(factory: ((env: ProviderEnv) => BrowserProvider) | null): void {
  providerFactoryOverride = factory;
}

const DISABLED_CAPABILITIES: ProviderCapabilities = {
  sessions: false,
  liveView: false,
  handoff: false,
  fullPageScreenshot: false,
  clipScreenshot: false,
  accessibilitySnapshot: false,
  videoFrames: false,
  guardrails: false,
};

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && Boolean((process as { versions?: Record<string, string> }).versions?.node);
}

export function createProvider(env: ProviderEnv): BrowserProvider {
  if (providerFactoryOverride) return providerFactoryOverride(env);
  const requested = String(env.BROWSER_PROVIDER ?? "cloudflare").toLowerCase() as ProviderName;
  const maxConcurrentSessions = Number(env.BROWSER_MAX_SESSIONS ?? 0) || undefined;
  if (requested === "node") return new LazyNodeProvider(env);
  return new CloudflareBrowserProvider(env.BROWSER as never, { maxConcurrentSessions });
}

/**
 * Defers loading `providers/node.ts` until a browser operation is actually
 * requested, so importing this module in a Worker stays Node-free.
 */
class LazyNodeProvider implements BrowserProvider {
  readonly name = "node" as const;
  private cached: BrowserProvider | null = null;
  private failure: string | null = null;

  constructor(private readonly env: ProviderEnv) {}

  isAvailable(): boolean {
    if (this.cached) return this.cached.isAvailable();
    return isNodeRuntime();
  }

  unavailableReason(): string | null {
    if (this.failure) return this.failure;
    if (this.cached) return this.cached.unavailableReason();
    if (!isNodeRuntime()) {
      return "NodeBrowserProvider is disabled: this runtime is not Node.js. Remove BROWSER_PROVIDER=node and use Cloudflare Browser Run.";
    }
    return null;
  }

  capabilities(): ProviderCapabilities {
    return this.cached?.capabilities() ?? DISABLED_CAPABILITIES;
  }

  private async provider(): Promise<BrowserProvider> {
    if (this.cached) return this.cached;
    if (this.failure) throw new BrowserError("capability_unavailable", this.failure, { capability: "node_browser_provider" });
    if (!isNodeRuntime()) {
      this.failure = this.unavailableReason() ?? "Node provider unavailable.";
      throw new BrowserError("capability_unavailable", this.failure, { capability: "node_browser_provider" });
    }
    try {
      const mod: unknown = await import(/* @vite-ignore */ NODE_PROVIDER_MODULE);
      const factory = (mod as { createNodeProvider?: (options: { executablePath?: string }) => BrowserProvider }).createNodeProvider;
      if (typeof factory !== "function") throw new Error("node provider module did not export createNodeProvider()");
      this.cached = factory({ executablePath: this.env.CHROME_PATH });
      return this.cached;
    } catch (error) {
      this.failure =
        error instanceof Error && error.message.includes("puppeteer-core")
          ? error.message
          : `NodeBrowserProvider could not be loaded (${String(error)}). Install it with: npm install --no-save puppeteer-core`;
      throw new BrowserError("capability_unavailable", this.failure, { capability: "node_browser_provider" });
    }
  }

  async launch(options: LaunchOptions): Promise<never> {
    return (await this.provider()).launch(options) as never;
  }

  async connect(sessionId: string, options?: LaunchOptions) {
    return (await this.provider()).connect(sessionId, options);
  }

  async sessions() {
    return (await this.provider()).sessions();
  }

  async limits() {
    return (await this.provider()).limits();
  }

  async closeSession(sessionId: string): Promise<void> {
    return (await this.provider()).closeSession(sessionId);
  }

  async ping(sessionId: string): Promise<boolean> {
    return (await this.provider()).ping(sessionId);
  }
}

export { CloudflareBrowserProvider };
