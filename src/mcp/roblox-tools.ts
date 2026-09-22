/**
 * Authenticated Roblox account tools.
 *
 * These are the *only* DEMO tools that touch a linked account, and they are
 * deliberately separated from the public Roblox lookups (`roblox_user`,
 * `roblox_game`), which stay credential-free:
 *
 *  - public tools  → Roblox's public endpoints, no token, no identity;
 *  - account tools → one named server-side token slot, resolved by the Worker,
 *    public claims out, nothing else.
 *
 * Rules enforced here rather than left to the reader:
 *
 *  - the account slot is chosen by the *deployment* (`ROBLOX_ACCOUNT_KEY`) or an
 *    explicit validated label; a tool may never point a stored token at an
 *    arbitrary user id, so `user_id` is never an argument;
 *  - private account calls must present `DEMO_API_KEY`, otherwise anyone who
 *    found the public worker URL could read the linked profile;
 *  - every result passes through `redactValue` and is built field by field, so no
 *    access token, refresh token, ID token, cookie or client secret can ride out
 *    in a payload even if Roblox adds a field to a response;
 *  - an action with no official Roblox OAuth/Open Cloud endpoint returns
 *    `not_supported` with the reason, and nothing unofficial is attempted.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { errorResult, textResult, type ToolResult } from "./results.js";
import { redactValue, safeLog } from "../core/redact.js";
import { bearerCredentialMatches } from "../core/credential.js";
import { asRobloxAuthError } from "../roblox/errors.js";
import { resolveRobloxConfig, normalizeAccountKey, DEFAULT_SCOPES } from "../roblox/config.js";
import { createVault } from "../roblox/store.js";
import { RobloxAccountClient } from "../roblox/client.js";
import { describeRobloxCapabilities, ROBLOX_CAPABILITIES_URI, ROBLOX_SCHEMA } from "../roblox/capabilities.js";
import type { RobloxAuthEnv } from "../roblox/types.js";

export const ROBLOX_TOOL_NAMES = [
  "roblox_account_status",
  "roblox_account_profile",
  "roblox_account_inventory",
  "roblox_account_avatar_thumbnail",
  "roblox_account_capabilities",
  "roblox_account_unlink",
] as const;

export interface RobloxToolContext {
  env: Record<string, unknown>;
  requestUrl?: string | null;
  /** Optional request credential for private tools, never required by the transport. */
  authorization?: string | null;
}

/** Resolve the per-request auth surface (config, vault, API client). */
export async function robloxContext(ctx: RobloxToolContext) {
  const env = ctx.env as RobloxAuthEnv;
  const requestUrl = ctx.requestUrl ?? "https://demo.invalid/";
  const config = resolveRobloxConfig(env, requestUrl);
  const handle = await createVault(env as Record<string, any>);
  config.storageMode = handle.mode;
  config.encryption = handle.encryption;
  config.encryptionReason = handle.reason;
  const vault = handle.vault;
  const client = new RobloxAccountClient({ env, config, vault });
  return { env, config, vault, client, handle };
}

/**
 * The MCP transport is public. Authenticate each private tool call before
 * reading or changing a linked account, even if a deployment secret is present.
 * The comparison is constant-time-ish (`bearerCredentialMatches`): the presented
 * header is never compared byte-for-byte against the secret.
 */
async function guardMcpEndpoint(ctx: RobloxToolContext): Promise<ToolResult | null> {
  const key = String(ctx.env.DEMO_API_KEY ?? "").trim();
  if (key && (await bearerCredentialMatches(ctx.authorization, key))) return null;
  if (key) return errorResult(JSON.stringify({
    error: "unauthorized",
    message: "Linked Roblox account tools require the configured private-tool bearer credential. Public MCP requests do not.",
    retryable: false,
  }));
  return errorResult(
    JSON.stringify(
      {
        error: "not_configured",
        message: "DEMO's private account tools are disabled because DEMO_API_KEY is not set.",
        hint: "Set the DEMO_API_KEY secret (`wrangler secret put DEMO_API_KEY`, or the Cloudflare dashboard under Workers → Settings → Variables and secrets), then reconnect your MCP client with that bearer token. Public tools such as roblox_user are unaffected.",
        retryable: false,
      },
      null,
      2,
    ),
  );
}

function accountArg(description: string) {
  return z
    .string()
    .optional()
    .describe(
      `${description} Must match the slot the account was connected to (the deployment default is \`default\`). It selects a server-side session; it does not change which Roblox user's data is read.`,
    );
}

function parseAccount(value: string | undefined, fallback: string): string {
  return value ? normalizeAccountKey(value) : fallback;
}

async function run<T>(work: () => Promise<T>): Promise<ToolResult> {
  try {
    const value = await work();
    return textResult(redactValue(value));
  } catch (error) {
    const authError = asRobloxAuthError(error);
    safeLog("warn", "tool-error", { code: authError.code, message: authError.message }, "roblox");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: authError.code,
              message: authError.message,
              ...(authError.hint ? { hint: authError.hint } : {}),
              retryable: authError.retryable,
              ...(authError.data ? { details: authError.data } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}

export function registerRobloxAccountTools(mcp: McpServer, ctx: RobloxToolContext): void {
  mcp.registerResource(
    "roblox_account_capabilities",
    ROBLOX_CAPABILITIES_URI,
    {
      title: "DEMO Roblox Account Capabilities",
      description:
        "What DEMO may do with a linked Roblox account under this deployment's scopes: the endpoint and scope behind every account action, the OAuth flow guarantees (authorization code + PKCE S256, hashed single-use state, encrypted server-side tokens), the enforced rate limits, and an explicit list of account actions Roblox does not permit over OAuth. Read this before promising a user anything about their account.",
      mimeType: "application/json",
    },
    async (uri) => {
      const report = await buildCapabilities(ctx, "default");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report, null, 2) }] };
    },
  );

  mcp.registerTool(
    "roblox_account_status",
    {
      title: "Roblox Account Status",
      description:
        "Report whether a Roblox account is connected to this DEMO deployment and what it may access. Returns only safe fields: connection state, Roblox user id, display name, username, granted scopes, access-token expiry, whether a refresh token exists, and the storage/encryption mode. It never returns an access token, refresh token, ID token, cookie or secret.",
      inputSchema: { account: accountArg("Optional account slot label.") },
    },
    async ({ account }) => {
      const blocked = await guardMcpEndpoint(ctx);
      if (blocked) return blocked;
      return run(async () => {
        const { config, vault } = await robloxContext(ctx);
        const key = parseAccount(account, config.accountKey);
        const record = await vault.getAccount(key);
        if (!record) {
          return {
            connected: false,
            configured: config.enabled,
            disabledReason: config.disabledReason,
            accountKey: key,
            requestedScopes: config.scopes,
            connectByOpening: `${new URL(ctx.requestUrl ?? "https://demo.invalid/").origin}/oauth/roblox/start`,
            note: config.enabled
              ? "Roblox OAuth is configured on the Worker but no account is connected to this browser session yet. Open the connect URL in Safari on the same device you will use DEMO from."
              : "Configure ROBLOX_CLIENT_ID and ROBLOX_CLIENT_SECRET on the Worker first.",
          };
        }
        const tokens = await vault.openTokens(record.token);
        return {
          connected: !record.reauthorizationRequired,
          // Field names avoid "token"/"authorization": the result passes through the
          // generic redaction layer, which masks any value under a sensitive-looking key.
          needsReconnect: record.reauthorizationRequired,
          reconnectHint: record.reauthorizationReason,
          accountKey: record.accountKey,
          userId: record.userId,
          displayName: record.displayName,
          username: record.username,
          profileUrl: record.profileUrl,
          grantedScopes: record.scopes,
          scopesSource: record.scopesSource,
          accessExpiresAt: new Date(tokens?.expiresAt ?? record.expiresAt).toISOString(),
          secondsUntilRefresh: Math.max(0, Math.ceil(((tokens?.expiresAt ?? 0) - Date.now()) / 1000)),
          canRefresh: record.hasRefreshToken,
          connectedAt: new Date(record.connectedAt).toISOString(),
          lastRefreshAt: record.lastRefreshAt ? new Date(record.lastRefreshAt).toISOString() : null,
          lastApiCallAt: record.lastApiCallAt ? new Date(record.lastApiCallAt).toISOString() : null,
          storage: { mode: config.storageMode, encryption: config.encryption, note: config.encryptionReason },
          credentialsReturnedToClient: false,
          cookieOrPasswordUsed: false,
        };
      });
    },
  );

  mcp.registerTool(
    "roblox_account_profile",
    {
      title: "Roblox Authenticated Profile",
      description:
        "Fetch the connected user's own Roblox profile straight from Roblox (GET /oauth/v1/userinfo) using the server-side token. Set extended=true to also read Open Cloud `GET /cloud/v2/users/{id}`, which requires the user.advanced:read or user.social:read scope on the app. Always the connected account — there is no user_id argument by design.",
      inputSchema: {
        account: accountArg("Optional account slot label."),
        extended: z.boolean().default(false).describe("Also call the Open Cloud user endpoint when its scope is granted."),
      },
    },
    async ({ account, extended }) => {
      const blocked = await guardMcpEndpoint(ctx);
      if (blocked) return blocked;
      return run(async () => {
        const { config, client } = await robloxContext(ctx);
        const key = parseAccount(account, config.accountKey);
        const { profile, record } = await client.profile(key);
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
          identityNote: "sub is the only stable identifier; Roblox usernames and display names can change.",
        };
        if (extended) {
          try {
            result.extended = await client.extendedProfile(key);
            result.extendedSource = "https://apis.roblox.com/cloud/v2/users/{user_id}";
          } catch (error) {
            const authError = asRobloxAuthError(error);
            result.extendedError = {
              error: authError.code,
              message: authError.message,
              ...(authError.hint ? { hint: authError.hint } : {}),
            };
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
        "List the connected user's own Roblox inventory items, or verify ownership of specific ids, through the official Open Cloud endpoint GET /cloud/v2/users/{user_id}/inventory-items. This requires the user.inventory-item:read scope on the Roblox app plus the user's own privacy setting. If the scope is not granted the tool returns insufficient_scope with the exact fix — it never falls back to cookie access.",
      inputSchema: {
        account: accountArg("Optional account slot label."),
        maxPageSize: z.number().int().min(1).max(100).default(25).describe("Roblox caps this at 100."),
        pageToken: z.string().max(512).optional().describe("nextPageToken from a previous call."),
        filter: z
          .string()
          .max(512)
          .optional()
          .describe('Roblox filter syntax, e.g. "onlyCollectibles=true;inventoryItemAssetTypes=HAT" or "assetIds=1028595,4773588762".'),
        assertAssetIds: z
          .array(z.number().int().positive())
          .max(50)
          .optional()
          .describe("Convenience: check ownership of these asset ids and return a per-id verdict alongside the raw page."),
      },
    },
    async ({ account, maxPageSize, pageToken, filter, assertAssetIds }) => {
      const blocked = await guardMcpEndpoint(ctx);
      if (blocked) return blocked;
      return run(async () => {
        const { config, client } = await robloxContext(ctx);
        const key = parseAccount(account, config.accountKey);
        const effectiveFilter = assertAssetIds?.length ? `assetIds=${assertAssetIds.join(",")}${filter ? `;${filter}` : ""}` : filter;
        const data = await client.inventory(key, { maxPageSize, pageToken, filter: effectiveFilter });
        const items = Array.isArray((data as any)?.inventoryItems) ? ((data as any).inventoryItems as any[]) : [];
        const ownedAssetIds = new Set(
          items
            .map((item) => item?.assetDetails?.assetId)
            .filter((value: unknown) => value !== undefined && value !== null)
            .map((value: unknown) => String(value)),
        );
        return {
          endpoint: "https://apis.roblox.com/cloud/v2/users/{user_id}/inventory-items",
          accountKey: key,
          itemCount: items.length,
          items: items.slice(0, 50),
          nextPageToken: (data as any)?.nextPageToken ?? null,
          ...(assertAssetIds?.length
            ? {
                ownership: assertAssetIds.map((assetId) => ({ assetId, owned: ownedAssetIds.has(String(assetId)) })),
                ownershipNote:
                  "A false verdict means this page did not contain the item. Query one page at a time with the assetIds filter for an authoritative answer; page size caps at 100 and Roblox limits this endpoint to 20 requests/minute per OAuth authorization.",
              }
            : {}),
          privacyNote: "Roblox gates this response on the user's Settings → Privacy → “Who can see my inventory?” setting as well as on the scope.",
        };
      });
    },
  );

  mcp.registerTool(
    "roblox_account_avatar_thumbnail",
    {
      title: "Roblox Authenticated Avatar Thumbnail",
      description:
        "Generate the connected user's avatar thumbnail through the official Open Cloud long-running operation (GET /cloud/v2/users/{user_id}:generateThumbnail) and return its public image URL. Returns status \"pending\" when Roblox has not finished yet — call again rather than polling in a loop.",
      inputSchema: {
        account: accountArg("Optional account slot label."),
        size: z.number().int().refine((value) => [48, 50, 60, 75, 100, 110, 150, 180, 352, 420, 720].includes(value)).default(420).describe("One of Roblox's supported square sizes."),
        format: z.enum(["PNG", "JPEG"]).default("PNG"),
        shape: z.enum(["ROUND", "SQUARE"]).default("ROUND"),
      },
    },
    async ({ account, size, format, shape }) => {
      const blocked = await guardMcpEndpoint(ctx);
      if (blocked) return blocked;
      return run(async () => {
        const { config, client } = await robloxContext(ctx);
        const key = parseAccount(account, config.accountKey);
        const result = await client.thumbnail(key, { size, format, shape });
        return { endpoint: "https://apis.roblox.com/cloud/v2/users/{user_id}:generateThumbnail", ...result };
      });
    },
  );

  mcp.registerTool(
    "roblox_account_capabilities",
    {
      title: "Roblox Account Capability Matrix",
      description:
        "Which Roblox account actions DEMO can perform for the connected user under the currently granted scopes, and which ones Roblox does not permit over OAuth/Open Cloud at all (with the reason). Read this before promising a user their Robux balance, friends, games they own, or any account write.",
      inputSchema: { account: accountArg("Optional account slot label; only used to reflect granted scopes.") },
    },
    async ({ account }) => {
      const blocked = await guardMcpEndpoint(ctx);
      if (blocked) return blocked;
      return run(async () => {
        const { config } = await robloxContext(ctx);
        return await buildCapabilities(ctx, parseAccount(account, config.accountKey));
      });
    },
  );

  mcp.registerTool(
    "roblox_account_unlink",
    {
      title: "Roblox Unlink Account",
      description:
        "Delete DEMO's stored authorization for an account slot and, when a refresh token exists, revoke it at Roblox through the official POST /oauth/v1/token/revoke endpoint. This only ever affects the deployment's own stored tokens: there is no way for this tool to touch a Roblox account beyond withdrawing the authorization it was given.",
      inputSchema: {
        account: accountArg("Optional account slot label."),
        revoke: z.boolean().default(true).describe("Ask Roblox to revoke the authorization. Local state is always cleared either way."),
      },
    },
    async ({ account, revoke }) => {
      const blocked = await guardMcpEndpoint(ctx);
      if (blocked) return blocked;
      return run(async () => {
        const { config, client } = await robloxContext(ctx);
        const key = parseAccount(account, config.accountKey);
        if (!revoke) {
          const { vault } = await robloxContext(ctx);
          await vault.deleteAccount(key);
          return { disconnected: true, revocationAttempted: false, revokedAtRoblox: false, note: "Local authorization deleted. The Roblox-side grant remains until it expires (90 days) or you revoke it in account settings." };
        }
        const result = await client.disconnect(key);
        return { ...result, note: "Tokens are deleted from DEMO's storage. Roblox revocation is best effort: if the service was unreachable, revoke the authorization under Roblox account settings → Advanced Settings → Apps." };
      });
    },
  );
}

async function buildCapabilities(ctx: RobloxToolContext, accountKey: string) {
  try {
    const { config, vault } = await robloxContext(ctx);
    // The public resource may describe policy, but must not inspect a linked
    // account. Authenticated private capability calls retain their account view.
    const record = (await guardMcpEndpoint(ctx)) ? null : await vault.getAccount(accountKey);
    const report = describeRobloxCapabilities({
      config,
      account: record ? { connected: !record.reauthorizationRequired, grantedScopes: record.scopes } : null,
    });
    return {
      ...report,
      connectByOpening: `${new URL(ctx.requestUrl ?? "https://demo.invalid/").origin}/oauth/roblox/start`,
      minimumScopes: [...DEFAULT_SCOPES],
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
