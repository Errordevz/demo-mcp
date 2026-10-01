/** Per-tool authentication for OAuth-protected MCP tools. */

import { errorResult, type ToolResult } from "../mcp/results.js";
import { sha256Hex } from "./crypto.js";
import { mcpOAuthChallenge } from "./oauth-routes.js";
import { resolveMcpOAuthConfig, type McpOAuthScope } from "./oauth-config.js";
import { resolveMcpAuthStore, type McpAccessTokenRecord } from "./oauth-store.js";

export interface McpProtectedRequestContext {
  env: Record<string, unknown>;
  authorization?: string | null;
}

export interface McpPrincipal {
  /** Server-derived hash of the verified Cloudflare Access subject and tenant. */
  subjectHash: string;
  scopes: string[];
}

export interface McpAuthFailure {
  ok: false;
  result: ToolResult;
}
export interface McpAuthSuccess {
  ok: true;
  principal: McpPrincipal;
}
export type McpAuthOutcome = McpAuthFailure | McpAuthSuccess;

/**
 * Every protected tool calls this on every invocation. The opaque access token
 * is never decoded as a self-asserted identity: only its hash is looked up in
 * the strongly consistent grant store, then audience, expiry and scopes are
 * rechecked before exposing the server-derived principal to the handler.
 */
export async function requireMcpScope(
  context: McpProtectedRequestContext,
  toolName: string,
  requiredScope: McpOAuthScope,
  now = Date.now(),
): Promise<McpAuthOutcome> {
  const config = resolveMcpOAuthConfig(context.env as never);
  const store = resolveMcpAuthStore(context.env);
  if (!config || !store) {
    return failure("not_configured", "DEMO's protected tools are unavailable because MCP OAuth is not configured.");
  }

  const token = bearerToken(context.authorization);
  if (!token) return authChallenge(config, "invalid_token", "Connect or reauthorize with DEMO to use this protected tool.");

  let grant: McpAccessTokenRecord | null;
  try {
    grant = await store.getAccessToken(await sha256Hex(token), now);
  } catch {
    return failure("temporarily_unavailable", "DEMO could not verify this authorization. Try again shortly.");
  }
  if (!grant || grant.version !== 1 || grant.expiresAt <= now || grant.audience !== config.resource || !/^[a-f0-9]{64}$/.test(grant.principalHash) || !Array.isArray(grant.scopes)) {
    return authChallenge(config, "invalid_token", "This DEMO authorization is missing, expired, revoked, or invalid.");
  }
  if (!grant.scopes.includes(requiredScope)) {
    return authChallenge(config, "insufficient_scope", `Authorize the ${requiredScope} scope in DEMO to use ${toolName}.`);
  }

  const rateScope = (await sha256Hex(`${grant.principalHash}\u0000${toolName}`)).slice(0, 32);
  try {
    const limit = await store.charge("tool", rateScope, 60, 60_000, now);
    if (!limit.allowed) {
      const result = errorResult(JSON.stringify({
        error: "rate_limited",
        message: "This protected tool is temporarily rate limited for this signed-in user.",
        retryAfterSeconds: limit.retryAfterSeconds,
        retryable: true,
      }, null, 2));
      return { ok: false, result };
    }
  } catch {
    return failure("temporarily_unavailable", "DEMO could not check this tool's rate limit. Try again shortly.");
  }

  return {
    ok: true,
    principal: {
      subjectHash: grant.principalHash,
      scopes: [...grant.scopes],
    },
  };
}

function bearerToken(value: string | null | undefined): string | null {
  if (!value || value.length > 256) return null;
  const match = /^Bearer[ \t]+([A-Za-z0-9_-]{32,128})$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function authChallenge(config: NonNullable<ReturnType<typeof resolveMcpOAuthConfig>>, error: "invalid_token" | "insufficient_scope", description: string): McpAuthFailure {
  const result = errorResult(JSON.stringify({
    error,
    message: description,
    retryable: false,
  }, null, 2));
  result._meta = { "mcp/www_authenticate": [mcpOAuthChallenge(config, error, description)] };
  return { ok: false, result };
}

function failure(error: string, message: string): McpAuthFailure {
  return {
    ok: false,
    result: errorResult(JSON.stringify({ error, message, retryable: false }, null, 2)),
  };
}
