/**
 * Shared isolate-local rate limiting for the extended public capabilities.
 *
 * Mirrors the pattern already proven by the video pipeline (`charge(operation,
 * input)` over a minute window): it bounds *this isolate's* work per source,
 * which is the correct granularity for a stateless Worker — the upstream
 * service applies its own global limits, and every capability that talks to one
 * still caps redirects, bytes and time independently.
 *
 * The limiter never counts users, IPs or identities; the key is always the
 * operation plus the public target being fetched, so it cannot become a
 * tracking facility. Window maps are bounded so a long-lived isolate cannot
 * grow memory through abuse.
 */

import { BrowserError } from "./errors.js";

export interface RateWindow {
  startedAt: number;
  count: number;
}

export class WindowedRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  constructor(
    private readonly limitFor: (env: Record<string, unknown> | undefined) => number,
    private readonly envKey: string,
    private readonly defaultLimit: number,
    private readonly minLimit = 1,
    private readonly maxLimit = 120,
    private readonly maxTracked = 1_000,
    private readonly windowMs = 60_000,
  ) {}

  private limit(env: Record<string, unknown> | undefined): number {
    const raw = env?.[this.envKey];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    const value = Number.isFinite(parsed) ? Math.floor(parsed) : this.defaultLimit;
    return Math.min(this.maxLimit, Math.max(this.minLimit, value));
  }

  /** Record one operation; throws a stable `rate_limited` error when over budget. */
  charge(env: Record<string, unknown> | undefined, operation: string, target: string): void {
    const limit = this.limit(env);
    const now = Date.now();
    const key = `${operation}:${target.slice(0, 500)}`;
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      // Bounded: evict the oldest entry when the tracker itself grows too large.
      if (this.windows.size > this.maxTracked) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      return;
    }
    if (current.count >= limit) {
      throw new BrowserError("rate_limited", `Public-source rate limit reached for ${operation} (${limit} per minute per target).`, {
        retryable: true,
        hint: "Wait a minute and retry; DEMO does not raise its own limits for pressure.",
      });
    }
    current.count++;
  }

  /** Test helper / operator reset. */
  reset(): void {
    this.windows.clear();
  }
}

/**
 * The shared budget for the extended read-only public capabilities (Internet
 * Archive, feeds, PDFs, images, web diff/monitor, OpenAPI, research). Kept in
 * one place so "existing rate limits are reused" is literally true — a new
 * capability opts into `TOOL_RATE_LIMIT_PER_MINUTE` instead of inventing a knob.
 */
export const publicToolRateLimiter = new WindowedRateLimiter(
  (env) => numberOrNull(env?.TOOL_RATE_LIMIT_PER_MINUTE) ?? 12,
  "TOOL_RATE_LIMIT_PER_MINUTE",
  12,
  1,
  120,
);

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return null;
}

export function configuredNumber(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = numberOrNull(value ?? undefined);
  return parsed === null ? fallback : Math.min(max, Math.max(min, parsed));
}
