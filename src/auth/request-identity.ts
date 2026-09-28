/**
 * One identity surface for every interactive auth surface (MCP OAuth authorize,
 * Roblox browser routes, account endpoints).
 *
 * The caller gets the same shape no matter which sign-in the user completed:
 *
 *   kind "account" — DEMO account session cookie. The subject hash is a
 *     domain-separated SHA-256 of the internal user id, so it can never collide
 *     with a Cloudflare Access subject hash, and existing per-principal storage
 *     keys (`robloxAccountKeyForSubjectHash`) keep working unchanged.
 *   kind "access"  — verified Cloudflare Access JWT (legacy/original path).
 *
 * Identity is only ever derived server-side from the session store or the signed
 * Access assertion — never from a request parameter.
 */

import { sha256Hex } from "../roblox/crypto.js";
import { verifyCloudflareAccessIdentity, type VerifiedAccessIdentity } from "./access-identity.js";
import { resolveAccountStore, type AccountStoreApi, type AccountUserRecord } from "../account/store.js";

export const ACCOUNT_SESSION_COOKIE = "demo_session";

export interface RequestIdentity {
  kind: "account" | "access";
  subjectHash: string;
  issuer: string;
  /** DEMO account fields; undefined for Access identities. */
  userId?: string;
  email?: string;
  emailVerified?: boolean;
}

export interface IdentityEnv extends Record<string, unknown> {
  MCP_AUTH_ACCESS_TEAM_DOMAIN?: string;
  MCP_AUTH_ACCESS_AUD?: string;
}

export interface IdentityDeps {
  accountStore?: AccountStoreApi;
  access?: (request: Request, env: IdentityEnv) => Promise<VerifiedAccessIdentity | null>;
  now?: () => number;
}

/** Domain separator: a DEMO user id and an Access subject can never produce the same principal. */
export async function accountSubjectHash(userId: string): Promise<string> {
  return sha256Hex(`demo-account${userId}`);
}

export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== ACCOUNT_SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      const decoded = decodeURIComponent(value);
      return /^[A-Za-z0-9_-]{32,128}$/.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface ResolvedAccountSession {
  user: AccountUserRecord;
  sessionToken: string;
  sessionTokenHash: string;
}

/** Resolve the DEMO account session cookie to a live user, or null. */
export async function resolveAccountSession(
  request: Request,
  env: IdentityEnv,
  deps: IdentityDeps = {},
): Promise<ResolvedAccountSession | null> {
  const token = readSessionCookie(request.headers.get("Cookie"));
  if (!token) return null;
  const store = deps.accountStore ?? resolveAccountStore(env);
  if (!store) return null;
  const tokenHash = await sha256Hex(token);
  let session;
  try {
    session = await store.getSession(tokenHash, deps.now?.() ?? Date.now());
  } catch {
    return null;
  }
  if (!session) return null;
  let user;
  try {
    user = await store.getUser(session.userId);
  } catch {
    return null;
  }
  if (!user) return null;
  return { user, sessionToken: token, sessionTokenHash: tokenHash };
}

/**
 * Resolve the request identity: DEMO session first (the account system is the
 * primary sign-in), then Cloudflare Access when the deployment is fronted by it.
 */
export async function resolveRequestIdentity(
  request: Request,
  env: IdentityEnv,
  deps: IdentityDeps = {},
): Promise<RequestIdentity | null> {
  const account = await resolveAccountSession(request, env, deps);
  if (account) {
    return {
      kind: "account",
      subjectHash: await accountSubjectHash(account.user.id),
      issuer: "demo-account",
      userId: account.user.id,
      email: account.user.email,
      emailVerified: Boolean(account.user.verifiedAt),
    };
  }
  const access = await (deps.access ?? verifyCloudflareAccessIdentity)(request, env);
  if (access && /^[a-f0-9]{64}$/.test(access.subjectHash)) {
    return { kind: "access", subjectHash: access.subjectHash, issuer: access.issuer };
  }
  return null;
}

export function validRequestIdentity(identity: RequestIdentity | null): identity is RequestIdentity {
  return Boolean(identity && /^[a-f0-9]{64}$/.test(identity.subjectHash));
}
