import { describe, expect, it } from "vitest";
import { BrowserError, asBrowserError, describeError, encodeForRpc } from "../src/core/errors.js";

describe("error classification", () => {
  it("reports local-mode Browser Rendering failures as a capability problem", () => {
    const error = asBrowserError(new Error("Failed to launch local browser via miniflare loopback (/browser/launch): upstream returned 500 Internal Server Error"));
    expect(error.code).toBe("capability_unavailable");
    expect(error.retryable).toBe(false);
    expect(error.hint).toMatch(/wrangler dev --remote/);
  });

  it("classifies rate limits as retryable", () => {
    const error = asBrowserError(new Error("429 Too Many Requests from Browser Run"));
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
  });

  it("classifies timeouts, navigation failures and dead sessions", () => {
    expect(describeError(new Error("Navigation timeout of 45000 ms exceeded")).code).toBe("timeout");
    expect(describeError(new Error("net::ERR_CONNECTION_REFUSED at https://x.test/")).code).toBe("navigation_failed");
    expect(describeError(new Error("Session 123 not found")).code).toBe("session_expired");
    expect(describeError(new Error("No node found for selector: #nope")).code).toBe("element_not_found");
    expect(describeError(new Error("something odd")).code).toBe("internal");
  });

  it("keeps existing BrowserErrors untouched", () => {
    const original = new BrowserError("blocked_url", "nope", { hint: "use https" });
    expect(asBrowserError(original)).toBe(original);
  });

  it("survives the Durable Object RPC boundary", () => {
    // RPC strips the error class, so the details travel inside the message.
    const original = new BrowserError("blocked_url", "private address", { hint: "use a public URL", capability: "navigation" });
    const transported = encodeForRpc(original);
    expect(transported).not.toBeInstanceOf(BrowserError);
    const decoded = describeError(transported);
    expect(decoded.code).toBe("blocked_url");
    expect(decoded.hint).toBe("use a public URL");
    expect(asBrowserError(transported).code).toBe("blocked_url");
  });
});
