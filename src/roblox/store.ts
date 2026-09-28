/**
 * `AccountVault` — the single implementation of every read/write the Roblox
 * OAuth flow needs, on top of a KV-ish storage adapter.
 *
 * It runs unchanged in two places:
 *
 *  - inside/behind the `RobloxAuth` Durable Object (production; strongly
 *    consistent, which matters because link submission and /callback land seconds apart
 *    and may hit different isolates — Workers KV's eventual consistency is why
 *    this project uses a Durable Object instead), and
 *  - in-process (local `wrangler dev` and unit tests) with a Map adapter.
 *
 * Security properties enforced here rather than at the call sites:
 *
 *  - pending authorizations are consumed exactly once (a tombstone distinguishes
 *    "replayed" from "never issued"), and in DO mode the consume itself is atomic;
 *  - every record carries an absolute expiry and is refused after it;
 *  - token material and the PKCE code verifier are sealed with AES-GCM before
 *    they reach storage, and in memory-only mode (no cipher) nothing is ever
 *    written to durable storage at all;
 *  - the OAuth `state` value itself is never stored — only its SHA-256.
 */

import { TokenCipher, randomOpaqueToken, safeEqual, sha256Hex } from "./crypto.js";
import { robloxAuthError } from "./errors.js";
import type { AccountRecord, KvLike, PendingAuthorization, RateLimitOutcome, SessionRecord, StateOutcome, TokenSecrets } from "./types.js";

export const USED_TOMBSTONE_SECONDS = 600;
/** Single DO instance per deployment: keeps a refresh rotation and a state write from racing each other. */
export const ROBLOX_AUTH_DO_NAME = "demo-roblox-auth";

export interface PendingStateInput {
  accountKey: string;
  principalHash?: string;
  redirectUri: string;
  scopes: string[];
  host: string;
  codeVerifier: string;
  stateTtlSeconds: number;
  /** The browser binding (SHA-256 of the state cookie), not the cookie itself. */
  bindingHash: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  scopes: string[];
  expiresAt: number;
}

export type VaultMode = "durable-object" | "memory";

/**
 * Operations that must not interleave. The Durable Object provides them through
 * RPC; the memory vault gets a plain implementation, which is sufficient because
 * isolate memory is only ever a development fallback.
 */
export interface AtomicOps {
  takePending(stateHash: string): Promise<{ pending: PendingAuthorization | null; tombstone: { usedAt: number } | null }>;
  increment(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number }>;
  /** Optional in memory mode: a lease only matters when isolates can race. */
  acquireLease?(key: string, owner: string, ttlMs: number): Promise<{ acquired: boolean; retryAfterMs: number }>;
  releaseLease?(key: string, owner: string): Promise<void>;
}

export class AccountVault {
  private readonly atomic: AtomicOps;

  constructor(
    private readonly kv: KvLike,
    private readonly cipher: TokenCipher | null,
    readonly mode: VaultMode = "memory",
    atomic?: AtomicOps,
  ) {
    this.atomic = atomic ?? createLocalAtomicOps(kv);
  }

  get encryptsAtRest(): boolean {
    return this.cipher !== null;
  }

  static pendingKey(stateHash: string): string {
    return `pending:${stateHash}`;
  }

  static usedKey(stateHash: string): string {
    return `used:${stateHash}`;
  }

  static accountKey(key: string): string {
    return `account:${key}`;
  }

  static sessionKey(id: string): string {
    return `session:${id}`;
  }

  static limitKey(bucket: string, scope: string): string {
    return `limit:${bucket}:${scope}`;
  }

  /* --------------------------------------------------- pending authorizations */

  async beginAuthorization(input: PendingStateInput): Promise<{ state: string; stateHash: string }> {
    const state = randomOpaqueToken(32);
    const stateHash = await sha256Hex(state);
    const now = Date.now();
    const seal = this.cipher ? await this.cipher.encrypt(input.codeVerifier) : null;
    if (seal === null && this.mode === "durable-object") {
      throw robloxAuthError("storage_unavailable", "Refusing to persist OAuth state in durable storage without ROBLOX_TOKEN_KEY.", {
        hint: "Set the ROBLOX_TOKEN_KEY secret, or run without the ROBLOX_AUTH binding so the flow stays in isolate memory.",
      });
    }
    const record: PendingAuthorization = {
      version: 1,
      stateHash,
      bindingHash: input.bindingHash,
      accountKey: input.accountKey,
      ...(input.principalHash ? { principalHash: input.principalHash } : {}),
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      codeVerifierSealed: seal,
      // Only ever populated in memory-only mode, where it cannot leave the isolate.
      codeVerifier: seal === null ? input.codeVerifier : null,
      createdAt: now,
      expiresAt: now + input.stateTtlSeconds * 1000,
      host: input.host,
    };
    await this.kv.put(AccountVault.pendingKey(stateHash), record);
    return { state, stateHash };
  }

  /** Redeem a state. Never idempotent: a second attempt reports `replayed`. */
  async consumeAuthorization(state: string, binding: string): Promise<StateOutcome> {
    const stateHash = await sha256Hex(state);
    const taken = await this.atomic.takePending(stateHash);
    if (!taken.pending) {
      if (taken.tombstone) return { status: "replayed" };
      return { status: "unknown" };
    }
    const pending = taken.pending;
    if (Date.now() > pending.expiresAt) return { status: "expired", expiresAt: pending.expiresAt };
    if (!binding || !safeEqual(binding, pending.bindingHash)) return { status: "binding_mismatch" };
    if (!this.cipher && pending.codeVerifierSealed) {
      throw robloxAuthError("storage_unavailable", "The OAuth state was sealed with a key this isolate does not have.", {
        hint: "ROBLOX_TOKEN_KEY changed mid-flow. Restore the previous key or start a fresh link from ChatGPT using the current key.",
      });
    }
    return { status: "ok", pending };
  }

  async recoverCodeVerifier(pending: PendingAuthorization): Promise<string> {
    if (pending.codeVerifier) return pending.codeVerifier;
    if (!pending.codeVerifierSealed) {
      throw robloxAuthError("storage_unavailable", "The PKCE code verifier for this authorization is missing.");
    }
    if (!this.cipher) {
      throw robloxAuthError("storage_unavailable", "ROBLOX_TOKEN_KEY is required to read the sealed PKCE verifier.", {
        hint: "Set the secret and start the flow again.",
      });
    }
    const verifier = await this.cipher.decrypt(pending.codeVerifierSealed);
    if (!verifier) {
      throw robloxAuthError("storage_unavailable", "The sealed PKCE verifier could not be decrypted (ROBLOX_TOKEN_KEY was rotated?).", {
        hint: "Create a fresh link code in ChatGPT and submit it through /oauth/roblox/link with the current key.",
      });
    }
    return verifier;
  }

  /* -------------------------------------------------------------- accounts */

  /** Encrypt token material before it reaches storage; memory mode keeps it in the isolate. */
  async sealTokens(tokens: StoredTokens): Promise<TokenSecrets> {
    if (!this.cipher) {
      if (this.mode === "durable-object") {
        throw robloxAuthError("storage_unavailable", "Refusing to write tokens to durable storage without encryption.");
      }
      return { version: 1, kid: "none", algorithm: "AES-GCM", sealed: null, plain: { ...tokens } };
    }
    const payload = JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt,
    });
    return { version: 1, kid: this.cipher.keyId, algorithm: "AES-GCM", sealed: await this.cipher.encrypt(payload) };
  }

  async openTokens(token: TokenSecrets | null | undefined): Promise<StoredTokens | null> {
    if (!token) return null;
    if (token.plain) return { ...token.plain };
    if (!token.sealed) return null;
    // A different key id means ROBLOX_TOKEN_KEY was rotated: treat as signed out
    // rather than failing with an undecodable blob.
    if (!this.cipher || token.kid !== this.cipher.keyId) return null;
    const json = await this.cipher.decrypt(token.sealed);
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as Partial<StoredTokens>;
      if (typeof parsed?.accessToken !== "string" || !parsed.accessToken) return null;
      return {
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
        idToken: typeof parsed.idToken === "string" ? parsed.idToken : null,
        scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope): scope is string => typeof scope === "string") : [],
        expiresAt: Number(parsed.expiresAt) || 0,
      };
    } catch {
      return null;
    }
  }

  async putAccount(record: AccountRecord): Promise<void> {
    await this.kv.put(AccountVault.accountKey(record.accountKey), { ...record, updatedAt: Date.now() });
  }

  async getAccount(key: string): Promise<AccountRecord | null> {
    return ((await this.kv.get<AccountRecord>(AccountVault.accountKey(key))) ?? null) as AccountRecord | null;
  }

  async deleteAccount(key: string): Promise<boolean> {
    return (await this.kv.delete(AccountVault.accountKey(key))) !== false;
  }

  /* -------------------------------------------------------------- sessions */

  async createSession(accountKey: string, ttlSeconds: number): Promise<{ sessionId: string; record: SessionRecord }> {
    const sessionId = randomOpaqueToken(32);
    const record: SessionRecord = { version: 1, accountKey, createdAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000 };
    await this.kv.put(AccountVault.sessionKey(sessionId), record);
    return { sessionId, record };
  }

  async resolveSession(sessionId: string): Promise<SessionRecord | null> {
    const record = ((await this.kv.get<SessionRecord>(AccountVault.sessionKey(sessionId))) ?? null) as SessionRecord | null;
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      await this.kv.delete(AccountVault.sessionKey(sessionId));
      return null;
    }
    return record;
  }

  async dropSession(sessionId: string): Promise<void> {
    await this.kv.delete(AccountVault.sessionKey(sessionId));
  }

  /** Sliding expiry, so an actively used browser is not logged out mid-session. */
  async touchSession(sessionId: string, ttlSeconds: number): Promise<SessionRecord | null> {
    const record = await this.resolveSession(sessionId);
    if (!record) return null;
    const next: SessionRecord = { ...record, expiresAt: Date.now() + ttlSeconds * 1000 };
    await this.kv.put(AccountVault.sessionKey(sessionId), next);
    return next;
  }

  /* ------------------------------------------------------------ rate limits */

  /**
   * Fixed-window counter. Buckets are deliberately coarse (route + client hash)
   * so the limit throttles abuse without becoming a usage-tracking store.
   */
  async charge(bucket: string, scope: string, limit: number, windowMs = 60_000): Promise<RateLimitOutcome> {
    const result = await this.atomic.increment(AccountVault.limitKey(bucket, scope), limit, windowMs);
    if (!result.allowed) {
      return { allowed: false, limit, remaining: 0, retryAfterSeconds: result.retryAfterSeconds };
    }
    return { allowed: true, limit, remaining: Math.max(0, limit - result.count), retryAfterSeconds: 0 };
  }

  /* --------------------------------------------------------------- leases */

  /**
   * Single-flight guard used around token refresh. Roblox refresh tokens are
   * consumed on use, so two isolates refreshing at once would throw one of the two
   * new token pairs away and leave the account holding a dead refresh token.
   */
  async acquireLease(name: string, owner: string, ttlMs = 30_000): Promise<{ acquired: boolean; retryAfterMs: number }> {
    if (!this.atomic.acquireLease) return { acquired: true, retryAfterMs: 0 };
    return await this.atomic.acquireLease(`lease:${name}`, owner, ttlMs);
  }

  async releaseLease(name: string, owner: string): Promise<void> {
    if (!this.atomic.releaseLease) return;
    await this.atomic.releaseLease(`lease:${name}`, owner);
  }

  /* -------------------------------------------------------------- hygiene */

  /** Drop expired pending states, tombstones, sessions and rate buckets. Bounded per call. */
  async sweep(now = Date.now(), limit = 200): Promise<{ deleted: number }> {
    if (!this.kv.list) return { deleted: 0 };
    let deleted = 0;
    for (const prefix of ["pending:", "used:", "session:", "limit:"]) {
      const listed = await this.kv.list({ prefix, limit });
      for (const entry of listed) {
        const value = entry.value as { expiresAt?: number; usedAt?: number; startedAt?: number } | null;
        const expiry =
          value?.expiresAt ??
          (value?.usedAt ? value.usedAt + USED_TOMBSTONE_SECONDS * 1000 : undefined) ??
          (value?.startedAt ? value.startedAt + 60_000 : undefined);
        if (typeof expiry === "number" && expiry <= now) {
          await this.kv.delete(entry.key);
          deleted++;
        }
      }
    }
    return { deleted };
  }
}

function createLocalAtomicOps(kv: KvLike): AtomicOps {
  return {
    async takePending(stateHash) {
      const pending = ((await kv.get<PendingAuthorization>(AccountVault.pendingKey(stateHash))) ?? null) as PendingAuthorization | null;
      if (pending) {
        await kv.delete(AccountVault.pendingKey(stateHash));
        await kv.put(AccountVault.usedKey(stateHash), { usedAt: Date.now() });
        return { pending, tombstone: null };
      }
      const tombstone = ((await kv.get<{ usedAt: number }>(AccountVault.usedKey(stateHash))) ?? null) as { usedAt: number } | null;
      return { pending: null, tombstone };
    },
    async increment(key, limit, windowMs) {
      const now = Date.now();
      const current = ((await kv.get<{ startedAt: number; count: number }>(key)) ?? null) as { startedAt: number; count: number } | null;
      if (!current || now - current.startedAt >= windowMs) {
        await kv.put(key, { startedAt: now, count: 1 });
        return { allowed: true, count: 1, retryAfterSeconds: 0 };
      }
      if (current.count >= limit) {
        return { allowed: false, count: current.count, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)) };
      }
      await kv.put(key, { startedAt: current.startedAt, count: current.count + 1 });
      return { allowed: true, count: current.count + 1, retryAfterSeconds: 0 };
    },
    async acquireLease(key, owner, ttlMs) {
      const now = Date.now();
      const current = ((await kv.get<{ owner: string; expiresAt: number }>(key)) ?? null) as { owner: string; expiresAt: number } | null;
      if (current && current.expiresAt > now && current.owner !== owner) {
        return { acquired: false, retryAfterMs: Math.max(50, current.expiresAt - now) };
      }
      await kv.put(key, { owner, expiresAt: now + ttlMs });
      return { acquired: true, retryAfterMs: 0 };
    },
    async releaseLease(key, owner) {
      const current = ((await kv.get<{ owner: string; expiresAt: number }>(key)) ?? null) as { owner: string; expiresAt: number } | null;
      if (current && current.owner === owner) await kv.delete(key);
    },
  };
}

/** Process-local storage adapter (wrangler dev without the DO binding, and tests). */
export class MemoryKv implements KvLike {
  private readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.entries.get(key) as T) ?? null;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async list(options: { prefix: string; limit?: number }): Promise<Array<{ key: string; value: unknown }>> {
    const out: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of this.entries) {
      if (!key.startsWith(options.prefix)) continue;
      out.push({ key, value });
      if (options.limit && out.length >= options.limit) break;
    }
    return out;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Test helper: exactly what landed in storage, which is how the "no plaintext at rest" claim is proven. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.entries.entries()].map(([key, value]) => [key, value]));
  }
}

/** Durable Object storage adapter used by the DO itself. */
export class DurableKv implements KvLike {
  constructor(private readonly storage: {
    get<T = unknown>(key: string): Promise<T | null | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(options: { prefix?: string; limit?: number }): Promise<Iterable<[string, unknown]>>;
  }) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.storage.get(key);
    return (value ?? null) as T | null;
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.storage.put(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return await this.storage.delete(key);
  }

  async list(options: { prefix: string; limit?: number }): Promise<Array<{ key: string; value: unknown }>> {
    const listed = await this.storage.list(options);
    const out: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of listed) out.push({ key, value });
    return out;
  }
}

/* ------------------------------------------------------------------ factory */

export interface VaultHandle {
  vault: AccountVault;
  mode: VaultMode;
  encryption: "aes-gcm-256" | "none";
  reason: string | null;
}

const isolateVaults = new Map<string, AccountVault>();

/**
 * Resolve the storage backend for this request.
 *
 * Durable Object + `ROBLOX_TOKEN_KEY` is the supported production configuration.
 * Without the key the vault *refuses* durable writes and degrades to isolate
 * memory, reporting the reason on every surface, rather than persisting tokens
 * unencrypted.
 */
/**
 * Cipher memo, keyed by the env object. HKDF derivation on every tool call is
 * measurable, and reusing one non-extractable `CryptoKey` per isolate is exactly
 * what we want: the key material never becomes a plain string anywhere.
 */
const cipherCache = new WeakMap<object, { secret: string | null; cipher: TokenCipher | null }>();

async function cipherFor(env: Record<string, any>): Promise<TokenCipher | null> {
  const secret = (env.ROBLOX_TOKEN_KEY ?? "").trim() || null;
  const cached = cipherCache.get(env);
  if (cached && cached.secret === secret) return cached.cipher;
  const cipher = await TokenCipher.fromSecret(secret).catch(() => null);
  cipherCache.set(env, { secret, cipher });
  return cipher;
}

export async function createVault(env: Record<string, any>): Promise<VaultHandle> {
  const cipher = await cipherFor(env);
  const namespace = env.ROBLOX_AUTH;
  if (namespace && typeof namespace.idFromName === "function" && cipher) {
    const stub = namespace.get(namespace.idFromName(ROBLOX_AUTH_DO_NAME));
    return { vault: createDurableVault(stub, cipher), mode: "durable-object", encryption: "aes-gcm-256", reason: null };
  }
  if (namespace && typeof namespace.idFromName === "function") {
    return {
      vault: isolateVault("default", null),
      mode: "memory",
      encryption: "none",
      reason:
        "ROBLOX_TOKEN_KEY is not configured, so tokens cannot be written to durable storage. Sessions live in isolate memory and must be repeated after the Worker recycles.",
    };
  }
  return {
    vault: isolateVault("default", cipher),
    mode: "memory",
    encryption: cipher ? "aes-gcm-256" : "none",
    reason: "The ROBLOX_AUTH Durable Object binding is unavailable; protected Roblox linking and account operations fail closed.",
  };
}

function isolateVault(scope: string, cipher: TokenCipher | null): AccountVault {
  let vault = isolateVaults.get(scope);
  if (!vault) {
    vault = new AccountVault(new MemoryKv(), cipher, "memory");
    isolateVaults.set(scope, vault);
  }
  return vault;
}

/**
 * Vault whose storage proxies through Durable Object RPC.
 *
 * `takePending`/`increment` are forwarded as single DO calls so they stay atomic,
 * while plain reads and writes use the generic `read`/`write`/`remove`/`scan`
 * surface. `sealTokens` happens in the caller isolate, so ciphertext is all the
 * DO ever stores.
 */
export function createDurableVault(stub: any, cipher: TokenCipher | null): AccountVault {
  const kv: KvLike = {
    async get<T>(key: string): Promise<T | null> {
      return ((await stub.read(key)) ?? null) as T | null;
    },
    async put(key: string, value: unknown): Promise<void> {
      await stub.write(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return await stub.remove(key);
    },
    async list(options: { prefix: string; limit?: number }) {
      return ((await stub.scan(options.prefix, options.limit ?? 100)) ?? []) as Array<{ key: string; value: unknown }>;
    },
  };
  const atomic: AtomicOps = {
    async takePending(stateHash) {
      const result = await stub.takePending(stateHash);
      return (result ?? { pending: null, tombstone: null }) as { pending: PendingAuthorization | null; tombstone: { usedAt: number } | null };
    },
    async increment(key, limit, windowMs) {
      const result = await stub.charge(key, limit, windowMs);
      return (result ?? { allowed: true, count: 1, retryAfterSeconds: 0 }) as { allowed: boolean; count: number; retryAfterSeconds: number };
    },
    async acquireLease(key, owner, ttlMs) {
      const result = await stub.acquireRefreshLease(key.replace(/^lease:/, ""), owner, ttlMs);
      return (result ?? { acquired: true, retryAfterMs: 0 }) as { acquired: boolean; retryAfterMs: number };
    },
    async releaseLease(key, owner) {
      await stub.releaseRefreshLease(key.replace(/^lease:/, ""), owner);
    },
  };
  return new AccountVault(kv, cipher, "durable-object", atomic);
}
