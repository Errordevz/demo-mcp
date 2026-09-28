/** User-isolated Roblox account tools. Public Roblox lookup tools are registered separately. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { errorResult, textResult, type ToolResult } from "./results.js";
import { redactValue, safeLog } from "../core/redact.js";
import { asRobloxAuthError, robloxAuthError } from "../roblox/errors.js";
import { resolveRobloxConfig, DEFAULT_SCOPES } from "../roblox/config.js";
import { createVault, type VaultHandle } from "../roblox/store.js";
import { RobloxAccountClient } from "../roblox/client.js";
import { describeRobloxCapabilities, ROBLOX_CAPABILITIES_URI, ROBLOX_SCHEMA } from "../roblox/capabilities.js";
import type { AccountRecord, RobloxAuthEnv } from "../roblox/types.js";
import { randomOpaqueToken, sha256Hex } from "../roblox/crypto.js";
import { requireMcpScope, type McpPrincipal } from "../auth/tool-auth.js";
import { resolveMcpAuthStore } from "../auth/oauth-store.js";
import { resolveMcpOAuthConfig, type McpOAuthScope } from "../auth/oauth-config.js";

export const ROBLOX_TOOL_NAMES = [
  "roblox_account_status",
  "roblox_account_link_start",
  "roblox_account_profile",
  "roblox_account_inventory",
  "roblox_account_avatar_thumbnail",
  "roblox_account_capabilities",
  "roblox_account_unlink",
] as const;

export interface RobloxToolContext {
  env: Record<string, unknown>;
  requestUrl?: string | null;
  /** Authorization header from this HTTP request; validated against MCP_AUTH per tool. */
  authorization?: string | null;
}

/** Resolve Roblox's encrypted vault and API client for the current Worker request. */
export async function robloxContext(ctx: RobloxToolContext) {
  const env = ctx.env as RobloxAuthEnv;
  const requestUrl = ctx.requestUrl ?? String(env.MCP_PUBLIC_ORIGIN ?? "https://demo.invalid/");
  const config = resolveRobloxConfig(env, requestUrl);
  const handle = await createVault(env as Record<string, any>);
  config.storageMode = handle.mode;
  config.encryption = handle.encryption;
  config.encryptionReason = handle.reason;
  const vault = handle.vault;
  const client = new RobloxAccountClient({ env, config, vault });
  return { env, config, vault, client, handle };
}

function requireEncryptedDurableStorage(handle: VaultHandle): void {
  if (handle.mode !== "durable-object" || handle.encryption !== "aes-gcm-256") {
    throw robloxAuthError("storage_unavailable", "Protected Roblox operations require the ROBLOX_AUTH Durable Object and ROBLOX_TOKEN_KEY encryption secret.", {
      hint: "Configure both the ROBLOX_AUTH Durable Object binding and ROBLOX_TOKEN_KEY, then reconnect. DEMO will not place Roblox tokens in isolate memory or plaintext storage.",
      status: 503,
    });
  }
}

function ownsAccount(record: AccountRecord | null, principal: McpPrincipal): record is AccountRecord {
  return Boolean(record && record.accountKey === principal.robloxAccountKey && record.principalHash === principal.subjectHash);
}

async function ownedRecord(ctx: RobloxToolContext, principal: McpPrincipal): Promise<AccountRecord | null> {
  const { vault, handle } = await robloxContext(ctx);
  requireEncryptedDurableStorage(handle);
  const candidate = await vault.getAccount(principal.robloxAccountKey);
  return ownsAccount(candidate, principal) ? candidate : null;
}

async function requireOwnedRecord(ctx: RobloxToolContext, principal: McpPrincipal): Promise<AccountRecord> {
  const record = await ownedRecord(ctx, principal);
  if (!record) {
    throw robloxAuthError("unauthenticated", "No Roblox account is linked to this DEMO identity.", {
      hint: "Call roblox_account_link_start, then paste its one-time code into DEMO's Roblox link page and approve the official Roblox consent screen.",
      status: 401,
    });
  }
  return record;
}

async function authorizeTool(ctx: RobloxToolContext, toolName: string, scope: McpOAuthScope) {
  const outcome = await requireMcpScope(ctx, toolName, scope);
  return outcome.ok ? outcome.principal : outcome.result;
}

async function run<T>(work: () => Promise<T>): Promise<ToolResult> {
  try {
    return textResult(redactValue(await work()));
  } catch (error) {
    const authError = asRobloxAuthError(error);
    safeLog("warn", "tool-error", { code: authError.code, message: authError.message }, "roblox");
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          error: authError.code,
          message: authError.message,
          ...(authError.hint ? { hint: authError.hint } : {}),
          retryable: authError.retryable,
          ...(authError.data ? { details: authError.data } : {}),
        }, null, 2),
      }],
    };
  }
}

export function registerRobloxAccountTools(mcp: McpServer, ctx: RobloxToolContext): void {
  // This resource describes general policy only. It does not inspect a linked account.
  mcp.registerResource(
    "roblox_account_capabilities",
    ROBLOX_CAPABILITIES_URI,
    {
      title: "DEMO Roblox Account Capabilities",
      description:
        "General policy: the Roblox endpoints and scopes DEMO supports, the official OAuth/PKCE and encrypted-storage guarantees, rate limits, and actions Roblox does not permit over OAuth. This public resource does not reveal any user's linked account state.",
      mimeType: "application/json",
    },
    async (uri) => {
      const report = await buildCapabilities(ctx, null);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report, null, 2) }] };
    },
  );

  mcp.registerTool(
    "roblox_account_status",
    {
      title: "Roblox Account Status",
      description:
        "Report the Roblox grant linked to the identity represented by this DEMO OAuth token. No account id or slot can be supplied. Returns only safe account metadata and encryption/storage status; it never returns an access token, refresh token, ID token, cookie or secret. Requires roblox:read.",
      inputSchema: z.object({}),
      annotations: { title: "Roblox Account Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const auth = await authorizeTool(ctx, "roblox_account_status", "roblox:read");
      if (isToolResult(auth)) return auth;
      return run(async () => {
        const { config, vault, handle } = await robloxContext(ctx);
        requireEncryptedDurableStorage(handle);
        const record = await vault.getAccount(auth.robloxAccountKey);
        const own = ownsAccount(record, auth) ? record : null;
        if (!own) {
          return {
            connected: false,
            configured: config.enabled,
            disabledReason: config.disabledReason,
            requestedScopes: config.scopes,
            nextStep: "Call roblox_account_link_start for a one-time code, then open /oauth/roblox/link in a browser and approve Roblox's official consent screen.",
            tokensReturnedToClient: false,
          };
        }
        const tokens = await vault.openTokens(own.token);
        return {
          connected: !own.reauthorizationRequired,
          needsReconnect: own.reauthorizationRequired,
          reconnectHint: own.reauthorizationReason,
          userId: own.userId,
          displayName: own.displayName,
          username: own.username,
          profileUrl: own.profileUrl,
          grantedScopes: own.scopes,
          scopesSource: own.scopesSource,
          accessExpiresAt: new Date(tokens?.expiresAt ?? own.expiresAt).toISOString(),
          secondsUntilRefresh: Math.max(0, Math.ceil(((tokens?.expiresAt ?? 0) - Date.now()) / 1000)),
          canRefresh: own.hasRefreshToken,
          connectedAt: new Date(own.connectedAt).toISOString(),
          lastRefreshAt: own.lastRefreshAt ? new Date(own.lastRefreshAt).toISOString() : null,
          lastApiCallAt: own.lastApiCallAt ? new Date(own.lastApiCallAt).toISOString() : null,
          storage: { mode: config.storageMode, encryption: config.encryption, note: config.encryptionReason },
          credentialsReturnedToClient: false,
          cookieOrPasswordUsed: false,
        };
      });
    },
  );

  mcp.registerTool(
    "roblox_account_link_start",
    {
      title: "Start Roblox Account Link",
      description:
        "Create a short-lived, single-use code that binds a Roblox OAuth authorization to this authenticated DEMO identity. This does not sign in to Roblox or grant Roblox access; the user must open DEMO's link page and approve on Roblox's official consent screen. Requires roblox:link; reading linked account data separately requires roblox:read.",
      inputSchema: z.object({}),
      annotations: { title: "Start Roblox Account Link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      const auth = await authorizeTool(ctx, "roblox_account_link_start", "roblox:link");
      if (isToolResult(auth)) return auth;
      return run(async () => {
        const oauthConfig = resolveMcpOAuthConfig(ctx.env as never);
        const store = resolveMcpAuthStore(ctx.env);
        if (!oauthConfig || !store) throw robloxAuthError("not_configured", "DEMO OAuth storage is unavailable.", { status: 503 });
        const { config, handle } = await robloxContext(ctx);
        requireEncryptedDurableStorage(handle);
        if (!config.enabled) throw robloxAuthError("not_configured", config.disabledReason ?? "Roblox OAuth is not configured.", { status: 503 });

        const rawCode = randomOpaqueToken(32);
        const expiresAt = Date.now() + oauthConfig.linkCodeTtlSeconds * 1000;
        const stored = await store.putRobloxLinkCode(await sha256Hex(rawCode), {
          version: 1,
          principalHash: auth.subjectHash,
          expiresAt,
        });
        if (!stored) throw robloxAuthError("storage_unavailable", "DEMO could not create a Roblox link code. Try again.", { status: 503 });
        return {
          linkCode: rawCode,
          linkUrl: `${oauthConfig.origin}/oauth/roblox/link`,
          expiresInSeconds: oauthConfig.linkCodeTtlSeconds,
          singleUse: true,
          instructions: "Open linkUrl in a browser signed in to the same Cloudflare Access identity used for ChatGPT, paste linkCode, then sign in and approve only the requested scopes on Roblox's official consent page. DEMO never asks for a Roblox password or cookie.",
          tokensReturnedToClient: false,
        };
      });
    },
  );

  mcp.registerTool(
    "roblox_account_profile",
    {
      title: "Roblox Authenticated Profile",
      description:
        "Fetch the linked user's own Roblox profile with the server-side token. Set extended=true to also read Open Cloud GET /cloud/v2/users/{id}, requiring user.advanced:read or user.social:read on the Roblox app. The DEMO identity—not a tool argument—selects the linked account. Requires roblox:read.",
      inputSchema: {
        extended: z.boolean().default(false).describe("Also call the Open Cloud user endpoint when its Roblox scope is granted."),
      },
      annotations: { title: "Roblox Authenticated Profile", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ extended }) => {
      const auth = await authorizeTool(ctx, "roblox_account_profile", "roblox:read");
      if (isToolResult(auth)) return auth;
      return run(async () => {
        await requireOwnedRecord(ctx, auth);
        const { client } = await robloxContext(ctx);
        const { profile, record } = await client.profile(auth.robloxAccountKey);
        const result: Record<string, unknown> = {
          source: "https://apis.roblox.com/oauth/v1/userinfo",
          connectedAs: { userId: record.userId, scopes: record.scopes },
          profile: {
            userId: profile.sub,
            displayName: profile.name,
            nickname: profile.nickname,
            username: profile.preferred_username,
            accountCreatedAt: profile.created_at ? new Date(profile.created_at * 1000).toISOString() : null,
            profileUrl: profile.profile,
            headshotUrl: profile.picture,
          },
          identityNote: "The verified Roblox sub claim is the stable account id; usernames and display names can change.",
        };
        if (extended) {
          try {
            result.extended = await client.extendedProfile(auth.robloxAccountKey);
            result.extendedSource = "https://apis.roblox.com/cloud/v2/users/{user_id}";
          } catch (error) {
            const authError = asRobloxAuthError(error);
            result.extendedError = { error: authError.code, message: authError.message, ...(authError.hint ? { hint: authError.hint } : {}) };
          }
        }
        return result;
      });
    },
  );

  mcp.registerTool(
    "roblox_account_inventory",
    {
      title: "Roblox Authenticated Inventory",
      description:
        "List the linked user's own Roblox inventory items through the official Open Cloud endpoint. This requires the Roblox user.inventory-item:read scope plus that user's privacy setting. No user id or account selector is accepted. Requires roblox:read in DEMO and the separate Roblox scope.",
      inputSchema: {
        maxPageSize: z.number().int().min(1).max(100).default(25).describe("Roblox caps this at 100."),
        pageToken: z.string().max(512).optional().describe("nextPageToken from a previous call."),
        filter: z.string().max(512).optional().describe('Roblox filter syntax, e.g. "onlyCollectibles=true;inventoryItemAssetTypes=HAT" or "assetIds=1028595,4773588762".'),
        assertAssetIds: z.array(z.number().int().positive()).max(50).optional().describe("Check ownership of these asset ids and return per-id results alongside the page."),
      },
      annotations: { title: "Roblox Authenticated Inventory", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ maxPageSize, pageToken, filter, assertAssetIds }) => {
      const auth = await authorizeTool(ctx, "roblox_account_inventory", "roblox:read");
      if (isToolResult(auth)) return auth;
      return run(async () => {
        await requireOwnedRecord(ctx, auth);
        const { client } = await robloxContext(ctx);
        const effectiveFilter = assertAssetIds?.length ? `assetIds=${assertAssetIds.join(",")}${filter ? `;${filter}` : ""}` : filter;
        const data = await client.inventory(auth.robloxAccountKey, { maxPageSize, pageToken, filter: effectiveFilter });
        const items = Array.isArray((data as any)?.inventoryItems) ? ((data as any).inventoryItems as any[]) : [];
        const ownedAssetIds = new Set(items.map((item) => item?.assetDetails?.assetId).filter((value: unknown) => value !== undefined && value !== null).map((value: unknown) => String(value)));
        return {
          endpoint: "https://apis.roblox.com/cloud/v2/users/{user_id}/inventory-items",
          itemCount: items.length,
          items: items.slice(0, 50),
          nextPageToken: (data as any)?.nextPageToken ?? null,
          ...(assertAssetIds?.length ? {
            ownership: assertAssetIds.map((assetId) => ({ assetId, owned: ownedAssetIds.has(String(assetId)) })),
            ownershipNote: "A false verdict means this page did not contain the item. Query one page at a time with the assetIds filter for an authoritative answer; Roblox rate-limits inventory reads per OAuth authorization.",
          } : {}),
          privacyNote: "Roblox gates this response on the user's Settings → Privacy → Who can see my inventory? setting as well as on the scope.",
        };
      });
    },
  );

  mcp.registerTool(
    "roblox_account_avatar_thumbnail",
    {
      title: "Roblox Authenticated Avatar Thumbnail",
      description:
        "Generate the linked user's avatar thumbnail through the official Open Cloud long-running operation and return its public image URL. The DEMO OAuth identity selects the account. Requires roblox:read.",
      inputSchema: {
        size: z.number().int().refine((value) => [48, 50, 60, 75, 100, 110, 150, 180, 352, 420, 720].includes(value)).default(420).describe("One of Roblox's supported square sizes."),
        format: z.enum(["PNG", "JPEG"]).default("PNG"),
        shape: z.enum(["ROUND", "SQUARE"]).default("ROUND"),
      },
      annotations: { title: "Roblox Authenticated Avatar Thumbnail", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ size, format, shape }) => {
      const auth = await authorizeTool(ctx, "roblox_account_avatar_thumbnail", "roblox:read");
      if (isToolResult(auth)) return auth;
      return run(async () => {
        await requireOwnedRecord(ctx, auth);
        const { client } = await robloxContext(ctx);
        const result = await client.thumbnail(auth.robloxAccountKey, { size, format, shape });
        return { endpoint: "https://apis.roblox.com/cloud/v2/users/{user_id}:generateThumbnail", ...result };
      });
    },
  );

  mcp.registerTool(
    "roblox_account_capabilities",
    {
      title: "Roblox Account Capability Matrix",
      description:
        "Report the Roblox actions DEMO may perform for the account bound to this authenticated DEMO identity, together with the scopes and unsupported actions. No account selector is accepted. Requires roblox:read.",
      inputSchema: z.object({}),
      annotations: { title: "Roblox Account Capability Matrix", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const auth = await authorizeTool(ctx, "roblox_account_capabilities", "roblox:read");
      if (isToolResult(auth)) return auth;
      return run(() => buildCapabilities(ctx, auth));
    },
  );

  mcp.registerTool(
    "roblox_account_unlink",
    {
      title: "Disconnect Roblox Account",
      description:
        "Revoke the Roblox authorization when possible and delete the encrypted grant bound to this DEMO identity. This is the only account affected; no account id can be supplied. Requires roblox:disconnect.",
      inputSchema: z.object({}),
      annotations: { title: "Disconnect Roblox Account", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      const auth = await authorizeTool(ctx, "roblox_account_unlink", "roblox:disconnect");
      if (isToolResult(auth)) return auth;
      return run(async () => {
        const { client, vault, handle } = await robloxContext(ctx);
        requireEncryptedDurableStorage(handle);
        const candidate = await vault.getAccount(auth.robloxAccountKey);
        if (!ownsAccount(candidate, auth)) return { disconnected: false, revocationAttempted: false, note: "No Roblox grant is linked to this DEMO identity." };
        const result = await client.disconnect(auth.robloxAccountKey);
        return {
          disconnected: result.disconnected,
          revocationAttempted: result.revocationAttempted,
          revokedAtRoblox: result.revoked,
          note: result.revoked
            ? "The Roblox grant was revoked and the encrypted DEMO record was deleted."
            : "The encrypted DEMO record was deleted. Roblox revocation is best effort; if Roblox could not be reached, revoke this app in Roblox account settings.",
        };
      });
    },
  );
}

function isToolResult(value: McpPrincipal | ToolResult): value is ToolResult {
  return Boolean(value && typeof value === "object" && "content" in value);
}

async function buildCapabilities(ctx: RobloxToolContext, principal: McpPrincipal | null) {
  try {
    const { config, vault, handle } = await robloxContext(ctx);
    let account: { connected: boolean; grantedScopes: string[] } | null = null;
    if (principal) {
      requireEncryptedDurableStorage(handle);
      const candidate = await vault.getAccount(principal.robloxAccountKey);
      const record = ownsAccount(candidate, principal) ? candidate : null;
      account = record ? { connected: !record.reauthorizationRequired, grantedScopes: record.scopes } : null;
    }
    const report = describeRobloxCapabilities({ config, account });
    return {
      ...report,
      ...(principal ? { identityBinding: "verified DEMO OAuth principal; no account selector" } : { accountState: "not inspected by this public resource" }),
      connectWith: principal ? "Call roblox_account_link_start, then use /oauth/roblox/link." : undefined,
      minimumScopes: [...DEFAULT_SCOPES],
      credentialsReturnedToClient: false,
    };
  } catch (error) {
    const authError = asRobloxAuthError(error);
    return {
      schema: ROBLOX_SCHEMA,
      configured: false,
      error: authError.code,
      message: authError.message,
      ...(authError.hint ? { hint: authError.hint } : {}),
    };
  }
}
