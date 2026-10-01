/**
 * Strongly consistent storage for DEMO's ChatGPT -> DEMO OAuth grants.
 *
 * Only one-way hashes of DEMO authorization codes, access tokens, refresh-free
 * link codes, and browser consent cookies are used as keys. Identity is stored as
 * a server-derived SHA-256 of Cloudflare Access's verified subject; raw JWTs,
 * emails, Roblox credentials, and DEMO bearer tokens are never stored here.
 */

export const MCP_AUTH_DO_NAME = "demo-mcp-auth";
const MAX_CONSENT_SECONDS = 10 * 60;
const MAX_CODE_SECONDS = 2 * 60;

export interface ConsentRequestRecord {
  version: 1;
  expiresAt: number;
  flowTokenHash: string;
  csrfTokenHash: string;
  principalHash: string;
  clientId: string;
  clientIdHash: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  audience: string;
}

export interface AuthorizationCodeRecord {
  version: 1;
  expiresAt: number;
  clientIdHash: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  principalHash: string;
  audience: string;
}

export interface McpAccessTokenRecord {
  version: 1;
  clientIdHash: string;
  principalHash: string;
  scopes: string[];
  audience: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ChargeResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export interface McpAuthStoreApi {
  putConsent(requestHash: string, record: ConsentRequestRecord): Promise<boolean>;
  consumeConsent(
    requestHash: string,
    flowTokenHash: string,
    csrfTokenHash: string,
    principalHash: string,
    now: number,
  ): Promise<ConsentRequestRecord | null>;
  putAuthorizationCode(codeHash: string, record: AuthorizationCodeRecord): Promise<boolean>;
  consumeAuthorizationCode(codeHash: string, now: number): Promise<AuthorizationCodeRecord | null>;
  putAccessToken(tokenHash: string, record: McpAccessTokenRecord): Promise<void>;
  getAccessToken(tokenHash: string, now: number): Promise<McpAccessTokenRecord | null>;
  revokeAccessToken(tokenHash: string, clientIdHash: string): Promise<boolean>;
  charge(bucket: string, scopeHash: string, limit: number, windowMs: number, now: number): Promise<ChargeResult>;
}

/** Worker RPC surface implemented by the MCP_AUTH Durable Object. */
export class McpAuthStore implements McpAuthStoreApi {
  constructor(private readonly stub: McpAuthStoreApi) {}

  putConsent(requestHash: string, record: ConsentRequestRecord) { return this.stub.putConsent(requestHash, record); }
  consumeConsent(requestHash: string, flowTokenHash: string, csrfTokenHash: string, principalHash: string, now: number) {
    return this.stub.consumeConsent(requestHash, flowTokenHash, csrfTokenHash, principalHash, now);
  }
  putAuthorizationCode(codeHash: string, record: AuthorizationCodeRecord) { return this.stub.putAuthorizationCode(codeHash, record); }
  consumeAuthorizationCode(codeHash: string, now: number) { return this.stub.consumeAuthorizationCode(codeHash, now); }
  putAccessToken(tokenHash: string, record: McpAccessTokenRecord) { return this.stub.putAccessToken(tokenHash, record); }
  getAccessToken(tokenHash: string, now: number) { return this.stub.getAccessToken(tokenHash, now); }
  revokeAccessToken(tokenHash: string, clientIdHash: string) { return this.stub.revokeAccessToken(tokenHash, clientIdHash); }
  charge(bucket: string, scopeHash: string, limit: number, windowMs: number, now: number) {
    return this.stub.charge(bucket, scopeHash, limit, windowMs, now);
  }
}

export interface McpAuthNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): McpAuthStoreApi;
}

/** Return null rather than silently placing production grants in isolate memory. */
export function resolveMcpAuthStore(env: Record<string, unknown>): McpAuthStore | null {
  const namespace = env.MCP_AUTH as McpAuthNamespaceLike | undefined;
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return null;
  try {
    return new McpAuthStore(namespace.get(namespace.idFromName(MCP_AUTH_DO_NAME)));
  } catch {
    return null;
  }
}

/** Pure in-memory adapter for deterministic tests only; never used as a fallback. */
export class InMemoryMcpAuthStore implements McpAuthStoreApi {
  private consents = new Map<string, ConsentRequestRecord>();
  private codes = new Map<string, AuthorizationCodeRecord>();
  private tokens = new Map<string, McpAccessTokenRecord>();
  private limits = new Map<string, { startedAt: number; count: number }>();

  async putConsent(hash: string, record: ConsentRequestRecord): Promise<boolean> {
    if (this.consents.has(hash)) return false;
    this.consents.set(hash, structuredClone(record));
    return true;
  }
  async consumeConsent(hash: string, flowHash: string, csrfHash: string, principalHash: string, now: number) {
    const record = this.consents.get(hash);
    this.consents.delete(hash);
    if (!record || record.expiresAt <= now || record.flowTokenHash !== flowHash || record.csrfTokenHash !== csrfHash || record.principalHash !== principalHash) return null;
    return structuredClone(record);
  }
  async putAuthorizationCode(hash: string, record: AuthorizationCodeRecord): Promise<boolean> {
    if (this.codes.has(hash)) return false;
    this.codes.set(hash, structuredClone(record));
    return true;
  }
  async consumeAuthorizationCode(hash: string, now: number) {
    const record = this.codes.get(hash);
    this.codes.delete(hash);
    return record && record.expiresAt > now ? structuredClone(record) : null;
  }
  async putAccessToken(hash: string, record: McpAccessTokenRecord) {
    this.tokens.set(hash, structuredClone(record));
  }
  async getAccessToken(hash: string, now: number) {
    const record = this.tokens.get(hash);
    if (!record) return null;
    if (record.expiresAt <= now) {
      this.tokens.delete(hash);
      return null;
    }
    return structuredClone(record);
  }
  async revokeAccessToken(hash: string, clientIdHash: string) {
    const record = this.tokens.get(hash);
    if (!record || record.clientIdHash !== clientIdHash) return false;
    this.tokens.delete(hash);
    return true;
  }
  async charge(bucket: string, scopeHash: string, limit: number, windowMs: number, now: number): Promise<ChargeResult> {
    const key = `${bucket}:${scopeHash}`;
    const current = this.limits.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.limits.set(key, { startedAt: now, count: 1 });
      return { allowed: true, count: 1, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return { allowed: false, count: current.count, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)) };
    }
    this.limits.set(key, { startedAt: current.startedAt, count: current.count + 1 });
    return { allowed: true, count: current.count + 1, retryAfterSeconds: 0 };
  }
}

/**
 * Cloudflare Durable Object RPC class. Every consume/check-and-delete operation
 * is serialized so authorization codes, consent posts, link codes, and rate
 * counters are single-use/atomic across Worker isolates.
 */
import { DurableObject } from "cloudflare:workers";

export class McpAuth extends DurableObject<Record<string, unknown>> {
  private alarmPending = false;

  private get storage(): DurableObjectStorageLike {
    return this.ctx.storage as unknown as DurableObjectStorageLike;
  }

  async putConsent(hash: string, record: ConsentRequestRecord): Promise<boolean> {
    return this.putOnce(`consent:${hash}`, record, MAX_CONSENT_SECONDS);
  }
  async consumeConsent(hash: string, flowHash: string, csrfHash: string, principalHash: string, now: number) {
    return this.consume<ConsentRequestRecord>(`consent:${hash}`, now, (record) =>
      record.flowTokenHash === flowHash && record.csrfTokenHash === csrfHash && record.principalHash === principalHash,
    );
  }
  async putAuthorizationCode(hash: string, record: AuthorizationCodeRecord): Promise<boolean> {
    return this.putOnce(`code:${hash}`, record, MAX_CODE_SECONDS);
  }
  async consumeAuthorizationCode(hash: string, now: number) {
    return this.consume<AuthorizationCodeRecord>(`code:${hash}`, now, () => true);
  }
  async putAccessToken(hash: string, record: McpAccessTokenRecord): Promise<void> {
    await this.storage.put(`token:${hash}`, record);
    this.ensureAlarm(record.expiresAt);
  }
  async getAccessToken(hash: string, now: number) {
    const key = `token:${hash}`;
    const record = (await this.storage.get(key)) as McpAccessTokenRecord | undefined;
    if (!record) return null;
    if (record.expiresAt <= now) {
      await this.storage.delete(key);
      return null;
    }
    return record;
  }
  async revokeAccessToken(hash: string, clientIdHash: string): Promise<boolean> {
    let revoked = false;
    await this.serial(async () => {
      const key = `token:${hash}`;
      const record = (await this.storage.get(key)) as McpAccessTokenRecord | undefined;
      if (record && record.clientIdHash === clientIdHash) {
        await this.storage.delete(key);
        revoked = true;
      }
    });
    return revoked;
  }
  async charge(bucket: string, scopeHash: string, limit: number, windowMs: number, now: number): Promise<ChargeResult> {
    const key = `limit:${bucket}:${scopeHash}`;
    let result: ChargeResult = { allowed: true, count: 1, retryAfterSeconds: 0 };
    await this.serial(async () => {
      const current = (await this.storage.get(key)) as { startedAt: number; count: number } | undefined;
      if (!current || now - current.startedAt >= windowMs) {
        await this.storage.put(key, { startedAt: now, count: 1, expiresAt: now + windowMs });
        result = { allowed: true, count: 1, retryAfterSeconds: 0 };
        return;
      }
      if (current.count >= limit) {
        result = { allowed: false, count: current.count, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)) };
        return;
      }
      await this.storage.put(key, { startedAt: current.startedAt, count: current.count + 1, expiresAt: current.startedAt + windowMs });
      result = { allowed: true, count: current.count + 1, retryAfterSeconds: 0 };
    });
    this.ensureAlarm(now + windowMs);
    return result;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.storage.list({ limit: 1000 });
    for (const [key, value] of entries) {
      if (key.startsWith("consent:") || key.startsWith("code:") || key.startsWith("token:") || key.startsWith("limit:")) {
        const expiresAt = (value as { expiresAt?: number } | undefined)?.expiresAt;
        if (typeof expiresAt === "number" && expiresAt <= now) await this.storage.delete(key);
      }
    }
    this.alarmPending = false;
    const remaining = await this.storage.list({ limit: 1 });
    if (remaining.size > 0) this.ensureAlarm(now + 15 * 60 * 1000);
  }

  private async putOnce(key: string, record: { expiresAt: number }, maxSeconds: number): Promise<boolean> {
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now() || record.expiresAt > Date.now() + (maxSeconds + 5) * 1000) return false;
    let created = false;
    await this.serial(async () => {
      if (await this.storage.get(key)) return;
      await this.storage.put(key, record);
      created = true;
    });
    if (created) this.ensureAlarm(record.expiresAt);
    return created;
  }

  private async consume<T extends { expiresAt: number }>(key: string, now: number, check: (value: T) => boolean): Promise<T | null> {
    let result: T | null = null;
    await this.serial(async () => {
      const record = (await this.storage.get(key)) as T | undefined;
      if (!record) return;
      await this.storage.delete(key);
      if (record.expiresAt > now && check(record)) result = record;
    });
    return result;
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
interface DurableObjectStateLike { storage: DurableObjectStorageLike }
