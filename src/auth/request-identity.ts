/**
 * Request identity surface for interactive auth endpoints (MCP OAuth authorize).
 *
 * Identity is derived server-side from a verified Cloudflare Access JWT assertion
 * (`verifyCloudflareAccessIdentity`) — never from a request parameter.
 */

import { verifyCloudflareAccessIdentity, type VerifiedAccessIdentity } from "./access-identity.js";

export interface RequestIdentity {
  kind: "access";
  subjectHash: string;
  issuer: string;
}

export interface IdentityEnv extends Record<string, unknown> {
  MCP_AUTH_ACCESS_TEAM_DOMAIN?: string;
  MCP_AUTH_ACCESS_AUD?: string;
}

export interface IdentityDeps {
  access?: (request: Request, env: IdentityEnv) => Promise<VerifiedAccessIdentity | null>;
}

/**
 * Resolve the request identity via Cloudflare Access when the deployment is fronted by it.
 */
export async function resolveRequestIdentity(
  request: Request,
  env: IdentityEnv,
  deps: IdentityDeps = {},
): Promise<RequestIdentity | null> {
  const access = await (deps.access ?? verifyCloudflareAccessIdentity)(request, env);
  if (access && /^[a-f0-9]{64}$/.test(access.subjectHash)) {
    return { kind: "access", subjectHash: access.subjectHash, issuer: access.issuer };
  }
  return null;
}

export function validRequestIdentity(identity: RequestIdentity | null): identity is RequestIdentity {
  return Boolean(identity && /^[a-f0-9]{64}$/.test(identity.subjectHash));
}
