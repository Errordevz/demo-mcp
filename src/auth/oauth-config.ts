/** Pinned public issuer and resource configuration for DEMO's MCP OAuth server. */

export const MCP_OAUTH_SCOPES = ["decision:use", "collab:write", "collab:admin"] as const;
export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

export const MCP_OAUTH_SCOPE_DESCRIPTIONS: Readonly<Record<McpOAuthScope, string>> = {
  "decision:use": "Run a DEMO paid typed-decision request.",
  "collab:write": "Read and change the shared coding workspace (tasks, patches, reviews, test records).",
  "collab:admin": "Perform administrator operations such as refreshing the Build Your Own X index.",
};

export interface McpOAuthConfig {
  origin: string;
  issuer: string;
  resource: string;
  resourceMetadataUrl: string;
  authorizationServerMetadataUrl: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  codeTtlSeconds: number;
  consentTtlSeconds: number;
  accessTokenTtlSeconds: number;
  rateLimitPerMinute: number;
  /** True when a Cloudflare Access team domain + audience are configured. */
  accessConfigured: boolean;
}

export interface McpOAuthConfigEnv {
  MCP_PUBLIC_ORIGIN?: string;
  MCP_AUTH_ACCESS_TEAM_DOMAIN?: string;
  MCP_AUTH_ACCESS_AUD?: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string | number;
  MCP_AUTH_RATE_LIMIT_PER_MINUTE?: string | number;
}

function numberFrom(value: string | number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

/**
 * Requires an explicit canonical HTTPS origin; request Host is never an issuer
 * fallback. HTTP is accepted only on loopback for local development tests.
 */
export function resolveMcpOAuthConfig(env: McpOAuthConfigEnv): McpOAuthConfig | null {
  const raw = (env.MCP_PUBLIC_ORIGIN ?? "").trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) return null;
  if (parsed.port && parsed.port !== "443" && !(local && parsed.protocol === "http:")) return null;
  const origin = parsed.origin;
  const accessDomain = (env.MCP_AUTH_ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
  const audience = (env.MCP_AUTH_ACCESS_AUD ?? "").trim();
  const accessConfigured = validAccessDomain(accessDomain) && Boolean(audience) && audience.length <= 512 && !/[\s\u0000-\u001f]/.test(audience);

  return {
    origin,
    issuer: origin,
    resource: origin,
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource`,
    authorizationServerMetadataUrl: `${origin}/.well-known/oauth-authorization-server`,
    authorizeEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    revocationEndpoint: `${origin}/oauth/revoke`,
    codeTtlSeconds: 120,
    consentTtlSeconds: 600,
    accessTokenTtlSeconds: numberFrom(env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS, 900, 300, 900),
    rateLimitPerMinute: numberFrom(env.MCP_AUTH_RATE_LIMIT_PER_MINUTE, 30, 1, 300),
    accessConfigured,
  };
}

export function validAccessDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(value);
}

export function mcpOAuthReady(env: McpOAuthConfigEnv & { MCP_AUTH?: unknown }): boolean {
  const config = resolveMcpOAuthConfig(env);
  if (!config) return false;
  const hasStore = Boolean(env.MCP_AUTH && typeof (env.MCP_AUTH as { idFromName?: unknown }).idFromName === "function" && typeof (env.MCP_AUTH as { get?: unknown }).get === "function");
  return hasStore && config.accessConfigured;
}

export function resourceMetadata(config: McpOAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
  };
}

export function authorizationServerMetadata(config: McpOAuthConfig) {
  return {
    issuer: config.issuer,
    authorization_endpoint: config.authorizeEndpoint,
    token_endpoint: config.tokenEndpoint,
    revocation_endpoint: config.revocationEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
