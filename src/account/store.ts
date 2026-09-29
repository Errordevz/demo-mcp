/**
 * Strongly consistent storage for DEMO user accounts.
 *
 * One Durable Object (`DemoAccounts`) holds the whole account surface:
 *
 *   user:{userId}                    → account record (email, password hash, flags)
 *   email:{normalizedEmail}          → userId (uniqueness index)
 *   dname:{normalizedDisplayName}    → userId (uniqueness index; only when set)
 *   sess:{userId}:{tokenHash}        → session record (revocable, expiring)
 *   vcode:{userId}                   → pending email-verification code (hash only)
 *   vtok:{tokenHash}                 → userId index for a verification *link* token
 *   rtok:{tokenHash}                 → pending password-reset token (single use, hash only)
 *   limit:{bucket}:{key}             → rate-limit counters
 *
 * Secrets discipline: only password *hashes*, session token *hashes* and code/token
 * *hashes* are ever stored. Raw session tokens, verification codes and reset tokens
 * exist only in the response/cookie that created them. Durable Object storage keeps
 * registration, login, consumption and revocation atomic across Worker isolates.
 */

export const ACCOUNTS_DO_NAME = "demo-accounts";
const MAX_SESSION_SECONDS = 60 * 60 * 24 * 90;
const MAX_CODE_SECONDS = 60 * 60;
const MAX_RESET_SECONDS = 60 * 60;

export interface AccountUserRecord {
  version: 1;
  id: string;
  /** Display form as registered (may keep case). */
  email: string;
  /** Lowercase uniqueness key. */
  emailNormalized: string;
  /**
   * Optional public handle. Records written before display names existed simply
   * omit it, so every read path must treat `undefined` as "not set".
   */
  displayName?: string | null;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  verifiedAt: number | null;
}

export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 32;

/**
 * Validate and normalise a display name.
 *
 * A display name is a *public handle*, never a credential: it is not used to
 * sign in, and uniqueness is enforced only so two accounts cannot share a
 * visible identity. Returns `null` for anything unusable, and the normalised
 * (lowercased) form for the uniqueness index.
 */
export function normalizeDisplayName(value: unknown): { display: string; normalized: string } | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length < DISPLAY_NAME_MIN || collapsed.length > DISPLAY_NAME_MAX) return null;
  // Letters, digits, spaces, and . _ - only: no markup, no control characters,
  // no confusable punctuation that could be used to impersonate another handle.
  if (!/^[A-Za-z0-9 ._-]+$/.test(collapsed)) return null;
  if (!/[A-Za-z0-9]/.test(collapsed)) return null;
  return { display: collapsed, normalized: collapsed.toLowerCase() };
}

export interface AccountSessionRecord {
  version: 1;
  userId: string;
  createdAt: number;
  expiresAt: number;
  /** Truncated user-agent for the sessions list; never a credential. */
  label: string;
}

export interface AccountSessionView {
  /** First 8 chars of the token hash — a stable, safe identifier for revocation. */
  id: string;
  createdAt: number;
  expiresAt: number;
  label: string;
}

export interface VerificationRecord {
  /** SHA-256 of the 8-character code the user types. */
  hash: string;
  /** SHA-256 of the opaque token carried by the one-click verification link. */
  linkHash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
}

export interface ResetRecord {
  userId: string;
  expiresAt: number;
}

export interface ChargeResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export type ConsumeCodeOutcome = "ok" | "none" | "expired" | "mismatch" | "too_many_attempts";

export type UpdateUserPatch = Partial<Pick<AccountUserRecord, "passwordHash" | "verifiedAt" | "updatedAt">>;

export type DisplayNameOutcome = "ok" | "taken" | "missing";

export interface AccountStoreApi {
  createUser(record: AccountUserRecord): Promise<"ok" | "exists">;
  getUser(userId: string): Promise<AccountUserRecord | null>;
  getUserByEmail(emailNormalized: string): Promise<AccountUserRecord | null>;
  getUserByDisplayName(displayNameNormalized: string): Promise<AccountUserRecord | null>;
  /** Atomically claim/release a unique display name. `null` clears it. */
  setDisplayName(userId: string, displayName: string | null, displayNameNormalized: string | null): Promise<DisplayNameOutcome>;
  updateUser(userId: string, patch: UpdateUserPatch): Promise<boolean>;
  deleteUser(userId: string): Promise<boolean>;
  putSession(tokenHash: string, record: AccountSessionRecord): Promise<void>;
  getSession(tokenHash: string, now: number): Promise<AccountSessionRecord | null>;
  touchSession(tokenHash: string, expiresAt: number): Promise<void>;
  deleteSession(tokenHash: string): Promise<boolean>;
  /** Revoke one of a user's sessions addressed by the public 8-char hash prefix. */
  deleteSessionByPrefix(userId: string, hashPrefix: string): Promise<boolean>;
  listSessions(userId: string, now: number): Promise<AccountSessionView[]>;
  deleteOtherSessions(userId: string, keepTokenHash: string): Promise<number>;
  deleteUserSessions(userId: string): Promise<number>;
  putVerificationCode(userId: string, record: VerificationRecord): Promise<void>;
  getVerificationState(userId: string): Promise<{ sentAt: number } | null>;
  consumeVerificationCode(userId: string, hash: string, now: number): Promise<ConsumeCodeOutcome>;
  /** Resolve a one-click verification link token to its user, single use. */
  consumeVerificationToken(tokenHash: string, now: number): Promise<{ userId: string } | "expired" | "none">;
  putResetToken(tokenHash: string, record: ResetRecord): Promise<void>;
  consumeResetToken(tokenHash: string, now: number): Promise<ResetRecord | null>;
  charge(bucket: string, key: string, limit: number, windowMs: number, now: number): Promise<ChargeResult>;
}

/** Worker RPC surface implemented by the DEMO_ACCOUNTS Durable Object. */
export class AccountStore implements AccountStoreApi {
  constructor(private readonly stub: AccountStoreApi) {}
  createUser(record: AccountUserRecord) { return this.stub.createUser(record); }
  getUser(userId: string) { return this.stub.getUser(userId); }
  getUserByEmail(emailNormalized: string) { return this.stub.getUserByEmail(emailNormalized); }
  getUserByDisplayName(displayNameNormalized: string) { return this.stub.getUserByDisplayName(displayNameNormalized); }
  setDisplayName(userId: string, displayName: string | null, displayNameNormalized: string | null) { return this.stub.setDisplayName(userId, displayName, displayNameNormalized); }
  updateUser(userId: string, patch: UpdateUserPatch) { return this.stub.updateUser(userId, patch); }
  deleteUser(userId: string) { return this.stub.deleteUser(userId); }
  putSession(tokenHash: string, record: AccountSessionRecord) { return this.stub.putSession(tokenHash, record); }
  getSession(tokenHash: string, now: number) { return this.stub.getSession(tokenHash, now); }
  touchSession(tokenHash: string, expiresAt: number) { return this.stub.touchSession(tokenHash, expiresAt); }
  deleteSession(tokenHash: string) { return this.stub.deleteSession(tokenHash); }
  deleteSessionByPrefix(userId: string, hashPrefix: string) { return this.stub.deleteSessionByPrefix(userId, hashPrefix); }
  listSessions(userId: string, now: number) { return this.stub.listSessions(userId, now); }
  deleteOtherSessions(userId: string, keepTokenHash: string) { return this.stub.deleteOtherSessions(userId, keepTokenHash); }
  deleteUserSessions(userId: string) { return this.stub.deleteUserSessions(userId); }
  putVerificationCode(userId: string, record: VerificationRecord) { return this.stub.putVerificationCode(userId, record); }
  getVerificationState(userId: string) { return this.stub.getVerificationState(userId); }
  consumeVerificationCode(userId: string, hash: string, now: number) { return this.stub.consumeVerificationCode(userId, hash, now); }
  consumeVerificationToken(tokenHash: string, now: number) { return this.stub.consumeVerificationToken(tokenHash, now); }
  putResetToken(tokenHash: string, record: ResetRecord) { return this.stub.putResetToken(tokenHash, record); }
  consumeResetToken(tokenHash: string, now: number) { return this.stub.consumeResetToken(tokenHash, now); }
  charge(bucket: string, key: string, limit: number, windowMs: number, now: number) { return this.stub.charge(bucket, key, limit, windowMs, now); }
}

export interface AccountNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): AccountStoreApi;
}

/** Return null rather than silently placing production accounts in isolate memory. */
export function resolveAccountStore(env: Record<string, unknown>): AccountStore | null {
  const namespace = env.DEMO_ACCOUNTS as AccountNamespaceLike | undefined;
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return null;
  try {
    return new AccountStore(namespace.get(namespace.idFromName(ACCOUNTS_DO_NAME)));
  } catch {
    return null;
  }
}

export function accountStoreAvailable(env: Record<string, unknown>): boolean {
  const namespace = env.DEMO_ACCOUNTS as AccountNamespaceLike | undefined;
  return Boolean(namespace && typeof namespace.idFromName === "function" && typeof namespace.get === "function");
}

/**
 * Cloudflare Durable Object RPC class. Consume operations (verification codes,
 * reset tokens) and uniqueness claims are serialized inside the object, so they
 * are single-use/atomic across isolates.
 */
import { DurableObject } from "cloudflare:workers";
import { encodeForRpc } from "../core/errors.js";
// Aliased: the Durable Object methods below are the RPC surface and share these
// names, and inside a method body a matching identifier resolves to the method
// itself, not to the imported helper.
import {
  collabApply as applyWorkspaceOperation,
  collabGet as readWorkspace,
  collabList as listWorkspaces,
  collabOpen as openWorkspace,
  collabSummary as summarizeStoredWorkspace,
  type CollabStorageLike,
  type OpenWorkspaceInput,
  type WorkspaceIndexEntry,
} from "../collab/store.js";
import type { ApplyContext, CollabOperation, CollabWorkspace, OperationResult, WorkspaceSummary } from "../collab/model.js";

export class DemoAccounts extends DurableObject<Record<string, unknown>> {
  private alarmPending = false;

  private get storage(): DurableObjectStorageLike {
    return this.ctx.storage as unknown as DurableObjectStorageLike;
  }

  async createUser(record: AccountUserRecord): Promise<"ok" | "exists"> {
    let created = false;
    await this.serial(async () => {
      const emailKey = `email:${record.emailNormalized}`;
      if (await this.storage.get(emailKey)) return;
      const displayName = normalizeDisplayName(record.displayName ?? null);
      const displayKey = displayName ? `dname:${displayName.normalized}` : null;
      if (displayKey && await this.storage.get(displayKey)) return;
      await this.storage.put(emailKey, record.id);
      if (displayKey) await this.storage.put(displayKey, record.id);
      await this.storage.put(`user:${record.id}`, { ...record, displayName: displayName?.display ?? null });
      created = true;
    });
    if (created) this.ensureAlarm(Date.now() + 24 * 60 * 60 * 1000);
    return created ? "ok" : "exists";
  }

  async getUser(userId: string): Promise<AccountUserRecord | null> {
    if (!/^usr_[A-Za-z0-9_-]{8,64}$/.test(userId)) return null;
    return ((await this.storage.get(`user:${userId}`)) as AccountUserRecord | undefined) ?? null;
  }

  async getUserByEmail(emailNormalized: string): Promise<AccountUserRecord | null> {
    const userId = await this.storage.get(`email:${emailNormalized}`);
    return typeof userId === "string" ? this.getUser(userId) : null;
  }

  async getUserByDisplayName(displayNameNormalized: string): Promise<AccountUserRecord | null> {
    const userId = await this.storage.get(`dname:${displayNameNormalized}`);
    return typeof userId === "string" ? this.getUser(userId) : null;
  }

  /**
   * Claim, replace or release the caller's display name in one serialised step,
   * so two concurrent registrations can never both take the same handle.
   */
  async setDisplayName(userId: string, displayName: string | null, displayNameNormalized: string | null): Promise<DisplayNameOutcome> {
    let outcome: DisplayNameOutcome = "missing";
    await this.serial(async () => {
      const key = `user:${userId}`;
      const record = (await this.storage.get(key)) as AccountUserRecord | undefined;
      if (!record) return;
      const current = normalizeDisplayName(record.displayName ?? null);
      if (displayName === null) {
        if (current) await this.storage.delete(`dname:${current.normalized}`);
        await this.storage.put(key, { ...record, displayName: null });
        outcome = "ok";
        return;
      }
      const next = normalizeDisplayName(displayName);
      if (!next || !displayNameNormalized || next.normalized !== displayNameNormalized) return;
      if (current && current.normalized === next.normalized) {
        await this.storage.put(key, { ...record, displayName: next.display });
        outcome = "ok";
        return;
      }
      const claimed = await this.storage.get(`dname:${next.normalized}`);
      if (typeof claimed === "string" && claimed !== userId) {
        outcome = "taken";
        return;
      }
      if (current) await this.storage.delete(`dname:${current.normalized}`);
      await this.storage.put(`dname:${next.normalized}`, userId);
      await this.storage.put(key, { ...record, displayName: next.display });
      outcome = "ok";
    });
    return outcome;
  }

  async updateUser(userId: string, patch: UpdateUserPatch): Promise<boolean> {
    let updated = false;
    await this.serial(async () => {
      const record = (await this.storage.get(`user:${userId}`)) as AccountUserRecord | undefined;
      if (!record) return;
      await this.storage.put(`user:${userId}`, { ...record, ...patch, id: record.id, emailNormalized: record.emailNormalized });
      updated = true;
    });
    return updated;
  }

  async deleteUser(userId: string): Promise<boolean> {
    let deleted = false;
    await this.serial(async () => {
      const record = (await this.storage.get(`user:${userId}`)) as AccountUserRecord | undefined;
      if (!record) return;
      await this.storage.delete(`user:${userId}`);
      await this.storage.delete(`email:${record.emailNormalized}`);
      const displayName = normalizeDisplayName(record.displayName ?? null);
      if (displayName) await this.storage.delete(`dname:${displayName.normalized}`);
      const verification = (await this.storage.get(`vcode:${userId}`)) as VerificationRecord | undefined;
      if (verification) await this.clearVerification(userId, verification);
      await this.dropSessions(userId);
      deleted = true;
    });
    return deleted;
  }

  async putSession(tokenHash: string, record: AccountSessionRecord): Promise<void> {
    if (!Number.isFinite(record.expiresAt) || record.expiresAt > Date.now() + (MAX_SESSION_SECONDS + 60) * 1000) return;
    await this.storage.put(`sess:${record.userId}:${tokenHash}`, record);
    // Reverse index so a cookie lookup is one key read instead of a full scan:
    // the per-user prefix alone cannot address a session without knowing the user.
    await this.storage.put(`sid:${tokenHash}`, record.userId);
    this.ensureAlarm(record.expiresAt);
  }

  async getSession(tokenHash: string, now: number): Promise<AccountSessionRecord | null> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
    const userId = await this.storage.get(`sid:${tokenHash}`);
    if (typeof userId !== "string") return null;
    const key = `sess:${userId}:${tokenHash}`;
    const record = (await this.storage.get(key)) as AccountSessionRecord | undefined;
    if (!record) {
      await this.storage.delete(`sid:${tokenHash}`);
      return null;
    }
    if (record.expiresAt <= now) {
      await this.storage.delete(key);
      await this.storage.delete(`sid:${tokenHash}`);
      return null;
    }
    return record;
  }

  async touchSession(tokenHash: string, expiresAt: number): Promise<void> {
    const userId = await this.storage.get(`sid:${tokenHash}`);
    if (typeof userId !== "string") return;
    const key = `sess:${userId}:${tokenHash}`;
    const record = (await this.storage.get(key)) as AccountSessionRecord | undefined;
    if (!record) return;
    await this.storage.put(key, { ...record, expiresAt });
  }

  async deleteSession(tokenHash: string): Promise<boolean> {
    const userId = await this.storage.get(`sid:${tokenHash}`);
    if (typeof userId !== "string") return false;
    await this.storage.delete(`sess:${userId}:${tokenHash}`);
    await this.storage.delete(`sid:${tokenHash}`);
    return true;
  }

  async deleteSessionByPrefix(userId: string, hashPrefix: string): Promise<boolean> {
    if (!/^[a-f0-9]{8,64}$/.test(hashPrefix)) return false;
    const prefix = `sess:${userId}:`;
    const entries = await this.storage.list({ prefix: `${prefix}${hashPrefix}` });
    let removed = false;
    for (const key of entries.keys()) {
      await this.storage.delete(`sid:${key.slice(prefix.length)}`);
      await this.storage.delete(key);
      removed = true;
    }
    return removed;
  }

  async listSessions(userId: string, now: number): Promise<AccountSessionView[]> {
    const entries = await this.storage.list({ prefix: `sess:${userId}:` });
    const out: AccountSessionView[] = [];
    for (const [key, value] of entries) {
      const record = value as AccountSessionRecord;
      if (record.expiresAt <= now) {
        await this.storage.delete(key);
        continue;
      }
      const hash = key.slice(`sess:${userId}:`.length);
      out.push({ id: hash.slice(0, 8), createdAt: record.createdAt, expiresAt: record.expiresAt, label: record.label });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, 50);
  }

  async deleteOtherSessions(userId: string, keepTokenHash: string): Promise<number> {
    let removed = 0;
    const prefix = `sess:${userId}:`;
    const entries = await this.storage.list({ prefix });
    for (const key of entries.keys()) {
      const hash = key.slice(prefix.length);
      if (hash === keepTokenHash) continue;
      await this.storage.delete(`sid:${hash}`);
      await this.storage.delete(key);
      removed++;
    }
    return removed;
  }

  async deleteUserSessions(userId: string): Promise<number> {
    return this.dropSessions(userId);
  }

  /** Delete every session row for a user plus each reverse index entry. */
  private async dropSessions(userId: string): Promise<number> {
    let removed = 0;
    const prefix = `sess:${userId}:`;
    const entries = await this.storage.list({ prefix });
    for (const key of entries.keys()) {
      await this.storage.delete(`sid:${key.slice(prefix.length)}`);
      await this.storage.delete(key);
      removed++;
    }
    return removed;
  }

  async putVerificationCode(userId: string, record: VerificationRecord): Promise<void> {
    if (!Number.isFinite(record.expiresAt) || record.expiresAt > Date.now() + (MAX_CODE_SECONDS + 60) * 1000) return;
    const existing = (await this.storage.get(`vcode:${userId}`)) as VerificationRecord | undefined;
    // A new code supersedes any previous link token; drop its index first so a
    // stale link can never resolve to this user.
    if (existing?.linkHash) await this.storage.delete(`vtok:${existing.linkHash}`);
    await this.storage.put(`vcode:${userId}`, record);
    if (record.linkHash) await this.storage.put(`vtok:${record.linkHash}`, userId);
    this.ensureAlarm(record.expiresAt);
  }

  async getVerificationState(userId: string): Promise<{ sentAt: number } | null> {
    const record = (await this.storage.get(`vcode:${userId}`)) as VerificationRecord | undefined;
    return record ? { sentAt: record.sentAt } : null;
  }

  async consumeVerificationCode(userId: string, hash: string, now: number): Promise<ConsumeCodeOutcome> {
    let outcome: ConsumeCodeOutcome = "none";
    await this.serial(async () => {
      const key = `vcode:${userId}`;
      const record = (await this.storage.get(key)) as VerificationRecord | undefined;
      if (!record) return;
      if (record.expiresAt <= now) {
        await this.clearVerification(userId, record);
        outcome = "expired";
        return;
      }
      if (record.attempts >= 5) {
        await this.clearVerification(userId, record);
        outcome = "too_many_attempts";
        return;
      }
      if (record.hash !== hash) {
        await this.storage.put(key, { ...record, attempts: record.attempts + 1 });
        outcome = "mismatch";
        return;
      }
      await this.clearVerification(userId, record);
      outcome = "ok";
    });
    return outcome;
  }

  /**
   * Consume a one-click verification link token. Resolving the token to its user
   * is what lets a recipient who opens the link in a different browser (or on a
   * phone) verify without a session — possession of the emailed token is the
   * proof of mailbox control.
   */
  async consumeVerificationToken(tokenHash: string, now: number): Promise<{ userId: string } | "expired" | "none"> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return "none";
    let outcome: { userId: string } | "expired" | "none" = "none";
    await this.serial(async () => {
      const indexKey = `vtok:${tokenHash}`;
      const userId = await this.storage.get(indexKey);
      if (typeof userId !== "string") return;
      const record = (await this.storage.get(`vcode:${userId}`)) as VerificationRecord | undefined;
      // Single use: the index is consumed whether or not the record still matches.
      await this.storage.delete(indexKey);
      if (!record || record.linkHash !== tokenHash) return;
      if (record.expiresAt <= now) {
        await this.clearVerification(userId, record);
        outcome = "expired";
        return;
      }
      outcome = { userId };
    });
    return outcome;
  }

  /** Remove a verification record and both of its indexes. */
  private async clearVerification(userId: string, record: VerificationRecord): Promise<void> {
    await this.storage.delete(`vcode:${userId}`);
    if (record.linkHash) await this.storage.delete(`vtok:${record.linkHash}`);
  }

  async putResetToken(tokenHash: string, record: ResetRecord): Promise<void> {
    if (!Number.isFinite(record.expiresAt) || record.expiresAt > Date.now() + (MAX_RESET_SECONDS + 60) * 1000) return;
    await this.storage.put(`rtok:${tokenHash}`, record);
    this.ensureAlarm(record.expiresAt);
  }

  async consumeResetToken(tokenHash: string, now: number): Promise<ResetRecord | null> {
    let result: ResetRecord | null = null;
    await this.serial(async () => {
      const key = `rtok:${tokenHash}`;
      const record = (await this.storage.get(key)) as ResetRecord | undefined;
      if (!record) return;
      await this.storage.delete(key);
      if (record.expiresAt > now) result = record;
    });
    return result;
  }

  async charge(bucket: string, key: string, limit: number, windowMs: number, now: number): Promise<ChargeResult> {
    const storageKey = `limit:${bucket}:${key}`;
    let result: ChargeResult = { allowed: true, count: 1, retryAfterSeconds: 0 };
    await this.serial(async () => {
      const current = (await this.storage.get(storageKey)) as { startedAt: number; count: number; expiresAt?: number } | undefined;
      if (!current || now - current.startedAt >= windowMs) {
        await this.storage.put(storageKey, { startedAt: now, count: 1, expiresAt: now + windowMs });
        result = { allowed: true, count: 1, retryAfterSeconds: 0 };
        return;
      }
      if (current.count >= limit) {
        result = { allowed: false, count: current.count, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)) };
        return;
      }
      await this.storage.put(storageKey, { startedAt: current.startedAt, count: current.count + 1, expiresAt: current.startedAt + windowMs });
      result = { allowed: true, count: current.count + 1, retryAfterSeconds: 0 };
    });
    this.ensureAlarm(now + windowMs);
    return result;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.storage.list({ limit: 1000 });
    for (const [key, value] of entries) {
      if (key.startsWith("sess:") || key.startsWith("vcode:") || key.startsWith("rtok:") || key.startsWith("limit:")) {
        const expiresAt = (value as { expiresAt?: number } | undefined)?.expiresAt;
        if (typeof expiresAt !== "number" || expiresAt > now) continue;
        // Keep the addressing indexes in step with the rows they point at, so an
        // expired session can never be resurrected through a stale `sid:` entry.
        if (key.startsWith("sess:")) await this.storage.delete(`sid:${key.slice(key.lastIndexOf(":") + 1)}`);
        if (key.startsWith("vcode:")) {
          const record = value as VerificationRecord;
          if (record?.linkHash) await this.storage.delete(`vtok:${record.linkHash}`);
        }
        await this.storage.delete(key);
      }
    }
    this.alarmPending = false;
    const remaining = await this.storage.list({ limit: 1 });
    if (remaining.size > 0) this.ensureAlarm(now + 15 * 60 * 1000);
  }

  /* ----------------------- shared coding workspace (see src/collab/store.ts) */
  /*
   * The workspace lives in this object because it is already the deployment's
   * strongly-consistent store: reusing it needs no new binding and no new
   * Durable Object migration, so shipping collaboration cannot disturb the
   * account data that shares the class. Keys are namespaced with "collab:".
   */

  private get collabStorage(): CollabStorageLike {
    return this.ctx.storage as unknown as CollabStorageLike;
  }

  async collabOpen(input: OpenWorkspaceInput, now = Date.now()): Promise<{ summary: WorkspaceSummary; index: WorkspaceIndexEntry[] }> {
    let outcome: { summary: WorkspaceSummary; index: WorkspaceIndexEntry[] } | null = null;
    await this.serial(async () => {
      outcome = await openWorkspace(this.collabStorage, input, now);
    });
    if (!outcome) throw encodeForRpc(new Error("Workspace open produced no result."));
    return outcome;
  }

  async collabList(): Promise<{ workspaces: WorkspaceIndexEntry[]; total: number }> {
    return listWorkspaces(this.collabStorage);
  }

  async collabGet(id: string): Promise<CollabWorkspace | null> {
    return readWorkspace(this.collabStorage, id);
  }

  async collabSummary(id: string): Promise<WorkspaceSummary | null> {
    return summarizeStoredWorkspace(this.collabStorage, id);
  }

  async collabApply(id: string, operation: CollabOperation, context: ApplyContext = {}): Promise<OperationResult> {
    let outcome: OperationResult | null = null;
    try {
      await this.serial(async () => {
        outcome = await applyWorkspaceOperation(this.collabStorage, id, operation, context);
      });
    } catch (error) {
      throw encodeForRpc(error);
    }
    if (!outcome) throw encodeForRpc(new Error("Workspace operation produced no result."));
    return outcome;
  }

  private async serial(operation: () => Promise<void>): Promise<void> {
    await this.ctx.blockConcurrencyWhile(operation);
  }

  private ensureAlarm(at: number): void {
    if (this.alarmPending || !this.storage.setAlarm) return;
    this.alarmPending = true;
    void this.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(at, Date.now() + 15 * 60 * 1000))).catch(() => {
      this.alarmPending = false;
    });
  }
}

/** Minimal structural types keep unit tests independent of Workerd globals. */
interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options?: { prefix?: string; limit?: number }): Promise<Map<string, unknown>>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  blockConcurrencyWhile?(callback: () => Promise<void>): Promise<void>;
}

/** Pure in-memory adapter for deterministic tests only; never used as a fallback. */
export class InMemoryAccountStore implements AccountStoreApi {
  private users = new Map<string, AccountUserRecord>();
  private emails = new Map<string, string>();
  private displayNames = new Map<string, string>();
  private sessions = new Map<string, AccountSessionRecord>();
  private vcodes = new Map<string, VerificationRecord>();
  private vtokIndex = new Map<string, string>();
  private resets = new Map<string, ResetRecord>();
  private limits = new Map<string, { startedAt: number; count: number }>();

  async createUser(record: AccountUserRecord): Promise<"ok" | "exists"> {
    if (this.emails.has(record.emailNormalized)) return "exists";
    const displayName = normalizeDisplayName(record.displayName ?? null);
    if (displayName && this.displayNames.has(displayName.normalized)) return "exists";
    this.emails.set(record.emailNormalized, record.id);
    if (displayName) this.displayNames.set(displayName.normalized, record.id);
    this.users.set(record.id, structuredClone({ ...record, displayName: displayName?.display ?? null }));
    return "ok";
  }
  async getUser(userId: string) {
    const record = this.users.get(userId);
    return record ? structuredClone(record) : null;
  }
  async getUserByEmail(emailNormalized: string) {
    const userId = this.emails.get(emailNormalized);
    return userId ? this.getUser(userId) : null;
  }
  async getUserByDisplayName(displayNameNormalized: string) {
    const userId = this.displayNames.get(displayNameNormalized);
    return userId ? this.getUser(userId) : null;
  }
  async setDisplayName(userId: string, displayName: string | null, displayNameNormalized: string | null): Promise<DisplayNameOutcome> {
    const record = this.users.get(userId);
    if (!record) return "missing";
    const current = normalizeDisplayName(record.displayName ?? null);
    if (displayName === null) {
      if (current) this.displayNames.delete(current.normalized);
      this.users.set(userId, { ...record, displayName: null });
      return "ok";
    }
    const next = normalizeDisplayName(displayName);
    if (!next || !displayNameNormalized || next.normalized !== displayNameNormalized) return "missing";
    if (current?.normalized === next.normalized) {
      this.users.set(userId, { ...record, displayName: next.display });
      return "ok";
    }
    const claimed = this.displayNames.get(next.normalized);
    if (claimed && claimed !== userId) return "taken";
    if (current) this.displayNames.delete(current.normalized);
    this.displayNames.set(next.normalized, userId);
    this.users.set(userId, { ...record, displayName: next.display });
    return "ok";
  }
  async updateUser(userId: string, patch: UpdateUserPatch) {
    const record = this.users.get(userId);
    if (!record) return false;
    this.users.set(userId, { ...record, ...patch });
    return true;
  }
  async deleteUser(userId: string) {
    const record = this.users.get(userId);
    if (!record) return false;
    this.users.delete(userId);
    this.emails.delete(record.emailNormalized);
    const displayName = normalizeDisplayName(record.displayName ?? null);
    if (displayName) this.displayNames.delete(displayName.normalized);
    const verification = this.vcodes.get(userId);
    if (verification?.linkHash) this.vtokIndex.delete(verification.linkHash);
    this.vcodes.delete(userId);
    for (const [key, session] of this.sessions) if (session.userId === userId) this.sessions.delete(key);
    return true;
  }
  async putSession(tokenHash: string, record: AccountSessionRecord) {
    this.sessions.set(tokenHash, structuredClone(record));
  }
  async getSession(tokenHash: string, now: number) {
    const record = this.sessions.get(tokenHash);
    if (!record) return null;
    if (record.expiresAt <= now) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return structuredClone(record);
  }
  async touchSession(tokenHash: string, expiresAt: number) {
    const record = this.sessions.get(tokenHash);
    if (record) this.sessions.set(tokenHash, { ...record, expiresAt });
  }
  async deleteSession(tokenHash: string) {
    return this.sessions.delete(tokenHash);
  }
  async deleteSessionByPrefix(userId: string, hashPrefix: string) {
    if (!/^[a-f0-9]{8,64}$/.test(hashPrefix)) return false;
    let removed = false;
    for (const [hash, record] of this.sessions) {
      if (record.userId === userId && hash.startsWith(hashPrefix)) {
        this.sessions.delete(hash);
        removed = true;
      }
    }
    return removed;
  }
  async listSessions(userId: string, now: number) {
    const out: AccountSessionView[] = [];
    for (const [hash, record] of this.sessions) {
      if (record.userId !== userId) continue;
      if (record.expiresAt <= now) {
        this.sessions.delete(hash);
        continue;
      }
      out.push({ id: hash.slice(0, 8), createdAt: record.createdAt, expiresAt: record.expiresAt, label: record.label });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }
  async deleteOtherSessions(userId: string, keepTokenHash: string) {
    let removed = 0;
    for (const [hash, record] of this.sessions) {
      if (record.userId === userId && hash !== keepTokenHash) {
        this.sessions.delete(hash);
        removed++;
      }
    }
    return removed;
  }
  async deleteUserSessions(userId: string) {
    let removed = 0;
    for (const [hash, record] of this.sessions) {
      if (record.userId === userId) {
        this.sessions.delete(hash);
        removed++;
      }
    }
    return removed;
  }
  async putVerificationCode(userId: string, record: VerificationRecord) {
    const existing = this.vcodes.get(userId);
    if (existing?.linkHash) this.vtokIndex.delete(existing.linkHash);
    this.vcodes.set(userId, structuredClone(record));
    if (record.linkHash) this.vtokIndex.set(record.linkHash, userId);
  }
  async getVerificationState(userId: string) {
    const record = this.vcodes.get(userId);
    return record ? { sentAt: record.sentAt } : null;
  }
  async consumeVerificationCode(userId: string, hash: string, now: number): Promise<ConsumeCodeOutcome> {
    const record = this.vcodes.get(userId);
    if (!record) return "none";
    if (record.expiresAt <= now) {
      this.clearVerification(userId, record);
      return "expired";
    }
    if (record.attempts >= 5) {
      this.clearVerification(userId, record);
      return "too_many_attempts";
    }
    if (record.hash !== hash) {
      this.vcodes.set(userId, { ...record, attempts: record.attempts + 1 });
      return "mismatch";
    }
    this.clearVerification(userId, record);
    return "ok";
  }
  async consumeVerificationToken(tokenHash: string, now: number): Promise<{ userId: string } | "expired" | "none"> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return "none";
    const userId = this.vtokIndex.get(tokenHash);
    if (!userId) return "none";
    this.vtokIndex.delete(tokenHash);
    const record = this.vcodes.get(userId);
    if (!record || record.linkHash !== tokenHash) return "none";
    if (record.expiresAt <= now) {
      this.clearVerification(userId, record);
      return "expired";
    }
    return { userId };
  }
  private clearVerification(userId: string, record: VerificationRecord) {
    this.vcodes.delete(userId);
    if (record.linkHash) this.vtokIndex.delete(record.linkHash);
  }
  async putResetToken(tokenHash: string, record: ResetRecord) {
    this.resets.set(tokenHash, structuredClone(record));
  }
  async consumeResetToken(tokenHash: string, now: number) {
    const record = this.resets.get(tokenHash);
    this.resets.delete(tokenHash);
    return record && record.expiresAt > now ? structuredClone(record) : null;
  }
  async charge(bucket: string, key: string, limit: number, windowMs: number, now: number): Promise<ChargeResult> {
    const mapKey = `${bucket}:${key}`;
    const current = this.limits.get(mapKey);
    if (!current || now - current.startedAt >= windowMs) {
      this.limits.set(mapKey, { startedAt: now, count: 1 });
      return { allowed: true, count: 1, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return { allowed: false, count: current.count, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)) };
    }
    this.limits.set(mapKey, { startedAt: current.startedAt, count: current.count + 1 });
    return { allowed: true, count: current.count + 1, retryAfterSeconds: 0 };
  }
}
