/**
 * `RobloxAuth` Durable Object.
 *
 * One instance per deployment (see `ROBLOX_AUTH_DO_NAME`) holding the three kinds
 * of state the OAuth flow cannot keep in an isolate:
 *
 *  1. pending authorizations (state hash → PKCE verifier + bindings), which must
 *     be redeemable exactly once and only from the browser that started them;
 *  2. the linked account record, whose token material arrives already encrypted,
 *     so this object never sees plaintext tokens;
 *  3. fixed-window rate counters and a refresh lease.
 *
 * A Durable Object rather than KV because the /start and /callback requests are
 * seconds apart and can land on different isolates, and because single-use
 * refresh tokens make a lost race unrecoverable. `storage.list` powers the
 * expiry sweep, run from an alarm so nothing has to trust a request to arrive.
 */

import { DurableObject } from "cloudflare:workers";
import { DurableKv, USED_TOMBSTONE_SECONDS, AccountVault } from "./store.js";
import type { PendingAuthorization, RobloxAuthEnv } from "./types.js";

interface LimitEntry {
  startedAt: number;
  count: number;
}

interface LeaseEntry {
  owner: string;
  expiresAt: number;
}

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export class RobloxAuth extends DurableObject<RobloxAuthEnv> {
  /**
   * The generic storage surface `AccountVault` runs on. Kept deliberately dumb:
   * the policy lives in `AccountVault`, so there is one implementation of the
   * rules instead of two that can drift.
   */
  private get kv(): DurableKv {
    return new DurableKv({
      get: async (key: string) => (await this.ctx.storage.get(key)) ?? null,
      put: async (key: string, value: unknown) => {
        await this.ctx.storage.put(key, value);
      },
      delete: async (key: string) => await this.ctx.storage.delete(key),
      list: async (options: { prefix?: string; limit?: number }) => {
        const listed = await this.ctx.storage.list(options);
        const out = new Map<string, unknown>();
        for (const [key, value] of listed) out.set(key, value);
        return out;
      },
    });
  }

  /* --------------------------------------------------------------- storage */

  async read(key: string): Promise<unknown> {
    return (await this.ctx.storage.get(key)) ?? null;
  }

  async write(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
    this.ensureAlarm();
  }

  async remove(key: string): Promise<boolean> {
    return await this.ctx.storage.delete(key);
  }

  async scan(prefix: string, limit: number): Promise<Array<{ key: string; value: unknown }>> {
    return await this.kv.list({ prefix, limit });
  }

  /* --------------------------------------------------- atomic OAuth actions */

  /**
   * Fetch **and** invalidate a pending authorization in one serialized step.
   * Two isolates racing on the same state therefore cannot both redeem it.
   */
  async takePending(stateHash: string): Promise<{ pending: PendingAuthorization | null; tombstone: { usedAt: number } | null }> {
    let result: { pending: PendingAuthorization | null; tombstone: { usedAt: number } | null } = { pending: null, tombstone: null };
    await this.ctx.blockConcurrencyWhile(async () => {
      const pending = ((await this.ctx.storage.get(AccountVault.pendingKey(stateHash))) ?? null) as PendingAuthorization | null;
      if (pending) {
        await this.ctx.storage.delete(AccountVault.pendingKey(stateHash));
        await this.ctx.storage.put(AccountVault.usedKey(stateHash), { usedAt: Date.now() });
        result = { pending, tombstone: null };
        return;
      }
      const tombstone = ((await this.ctx.storage.get(AccountVault.usedKey(stateHash))) ?? null) as { usedAt: number } | null;
      result = { pending: null, tombstone };
    });
    this.ensureAlarm();
    return result;
  }

  /** Fixed-window counter, serialized so concurrent requests cannot slip past the limit. */
  async charge(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number }> {
    let outcome: { allowed: boolean; count: number; retryAfterSeconds: number } = { allowed: true, count: 1, retryAfterSeconds: 0 };
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const current = ((await this.ctx.storage.get(key)) ?? null) as LimitEntry | null;
      if (!current || now - current.startedAt >= windowMs) {
        await this.ctx.storage.put(key, { startedAt: now, count: 1 } satisfies LimitEntry);
        outcome = { allowed: true, count: 1, retryAfterSeconds: 0 };
        return;
      }
      if (current.count >= limit) {
        outcome = { allowed: false, count: current.count, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)) };
        return;
      }
      await this.ctx.storage.put(key, { startedAt: current.startedAt, count: current.count + 1 } satisfies LimitEntry);
      outcome = { allowed: true, count: current.count + 1, retryAfterSeconds: 0 };
    });
    return outcome;
  }

  /**
   * Single-flight refresh. Roblox refresh tokens are consumed on use, so two
   * racing refreshes would throw one of the two results away and leave the
   * account with a stale token. The loser waits for the winner's write.
   */
  async acquireRefreshLease(accountKey: string, owner: string, ttlMs = 30_000): Promise<{ acquired: boolean; retryAfterMs: number }> {
    const key = `lease:${accountKey}`;
    const now = Date.now();
    const current = ((await this.ctx.storage.get(key)) ?? null) as LeaseEntry | null;
    if (current && current.expiresAt > now && current.owner !== owner) {
      return { acquired: false, retryAfterMs: Math.max(100, current.expiresAt - now) };
    }
    await this.ctx.storage.put(key, { owner, expiresAt: now + ttlMs } satisfies LeaseEntry);
    return { acquired: true, retryAfterMs: 0 };
  }

  async releaseRefreshLease(accountKey: string, owner: string): Promise<void> {
    const key = `lease:${accountKey}`;
    const current = ((await this.ctx.storage.get(key)) ?? null) as LeaseEntry | null;
    if (current && current.owner === owner) await this.ctx.storage.delete(key);
  }

  /** Wipe everything for an account slot (logout with revocation). */
  async forgetAccount(accountKey: string): Promise<{ removed: number }> {
    let removed = 0;
    await this.ctx.blockConcurrencyWhile(async () => {
      const accounts = await this.ctx.storage.list({ prefix: AccountVault.accountKey(accountKey) });
      for (const [key] of accounts) {
        await this.ctx.storage.delete(key);
        removed++;
      }
      await this.ctx.storage.delete(`lease:${accountKey}`);
    });
    return { removed };
  }

  /* -------------------------------------------------------------- lifecycle */

  private alarmScheduled = false;

  private ensureAlarm(): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    void this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS).catch(() => {
      this.alarmScheduled = false;
    });
  }

  /** Purge expired pending states, tombstones, sessions, leases and counters. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const sweep = await new AccountVault(this.kv, null, "durable-object").sweep(now, 400);
    for (const [key, value] of await this.ctx.storage.list({ prefix: "used:", limit: 400 })) {
      const entry = value as { usedAt?: number };
      if (entry?.usedAt && entry.usedAt + USED_TOMBSTONE_SECONDS * 1000 <= now) await this.ctx.storage.delete(key);
    }
    for (const [key, value] of await this.ctx.storage.list({ prefix: "lease:", limit: 100 })) {
      const entry = value as LeaseEntry;
      if (!entry?.expiresAt || entry.expiresAt <= now) await this.ctx.storage.delete(key);
    }
    void sweep;
    void this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  async debugSummary(): Promise<{ keys: number; prefixes: Record<string, number> }> {
    const listed = await this.ctx.storage.list({ limit: 1000 });
    const prefixes: Record<string, number> = {};
    let keys = 0;
    for (const [key] of listed) {
      keys++;
      const bucket = key.split(":")[0] ?? "other";
      prefixes[bucket] = (prefixes[bucket] ?? 0) + 1;
    }
    return { keys, prefixes };
  }
}
