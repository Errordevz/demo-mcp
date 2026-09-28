# Link a Roblox account to DEMO

Roblox account tools use Roblox's official OAuth 2.0/Open Cloud APIs. They are protected per DEMO identity, and they do not change DEMO's public tools. This integration never asks for a Roblox password, `.ROBLOSECURITY` cookie, browser cookie, or user-supplied Roblox account ID.

**Keep the two OAuth approvals separate:** ChatGPT first authorizes protected DEMO tools with DEMO OAuth 2.1; Roblox is then authorized separately on Roblox's official consent page. DEMO OAuth alone does not sign into Roblox or connect an account. For Cloudflare Access and ChatGPT connection setup, read [`MCP-OAUTH.md`](MCP-OAUTH.md).

## Protected Roblox tools

| Tool | DEMO OAuth scope | Behavior |
| --- | --- | --- |
| `roblox_account_status` | `roblox:read` | Status for the Roblox grant belonging to the authenticated DEMO user. |
| `roblox_account_link_start` | `roblox:link` | Returns a random, five-minute, single-use link code and the browser link page URL. |
| `roblox_account_profile` | `roblox:read` | Reads Roblox `/oauth/v1/userinfo`; optional extended fields need a Roblox Open Cloud scope. |
| `roblox_account_inventory` | `roblox:read` | Reads the authenticated user's own inventory with Roblox `user.inventory-item:read` and the user's privacy setting. |
| `roblox_account_avatar_thumbnail` | `roblox:read` | Generates a thumbnail for the authenticated Roblox user. |
| `roblox_account_capabilities` | `roblox:read` | Reports the authenticated account's supported actions and granted Roblox scopes. |
| `roblox_account_unlink` | `roblox:disconnect` | Deletes the user's local encrypted grant and best-effort revokes the Roblox refresh token. |

Public tools such as `roblox_user` and `roblox_game` remain no-login public Roblox lookups; they do not read or use a linked account token.

## One-time Roblox app setup

1. Create a Roblox OAuth app in the Creator Dashboard.
2. Register this exact redirect URI on the Roblox app:

   ```text
   https://<MCP_PUBLIC_ORIGIN>/oauth/roblox/callback
   ```

   For example, if `MCP_PUBLIC_ORIGIN` is `https://demo.example.com`, register `https://demo.example.com/oauth/roblox/callback`. Keep scheme, hostname, path, and trailing-slash behavior exact.
3. Start with scopes `openid profile`. `openid` is required to establish the stable Roblox `sub`; `profile` enables display fields. Add only what you need:
   - `user.inventory-item:read` for inventory.
   - `user.advanced:read` or `user.social:read` for supported extended-profile fields.
4. Set `ROBLOX_CLIENT_ID` as a non-secret Worker variable. Store the following as encrypted Worker secrets, not in `wrangler.jsonc`, `.env.example`, browser JavaScript, or chat:

   ```sh
   npx wrangler secret put ROBLOX_CLIENT_SECRET
   npx wrangler secret put ROBLOX_TOKEN_KEY
   ```

   Generate `ROBLOX_TOKEN_KEY` as a fresh random 32-byte value (for example `openssl rand -base64 32`) and back it up securely. Changing it makes existing encrypted grants unreadable; affected users must reconnect.
5. Bind the `ROBLOX_AUTH` Durable Object and configure the `MCP_AUTH` identity/link-code Durable Object as described in [`MCP-OAUTH.md`](MCP-OAUTH.md). Protected Roblox operations fail closed unless durable encrypted storage is available.

`ROBLOX_REDIRECT_URI` can pin the URI explicitly; otherwise DEMO uses `MCP_PUBLIC_ORIGIN`. `ROBLOX_ALLOWED_HOSTS` is an optional comma-separated hostname allowlist. `OAUTH_STATE_TTL_SECONDS` defaults to 600 seconds and is clamped to 60–900.

## User connection steps

1. Add the deployed DEMO MCP endpoint to ChatGPT using **Mixed Authentication** for public no-auth and protected OAuth tools. This expected setup has not been verified in a live ChatGPT account yet.
2. Call `roblox_account_link_start` in ChatGPT. It returns `linkCode` and `linkUrl`; do not paste the code into another service or conversation.
3. Open `linkUrl` in a browser and sign in through the configured Cloudflare Access application with the **same human identity used for ChatGPT**.
4. Paste the code into DEMO's link page. It expires in five minutes and can be consumed once. DEMO then redirects to Roblox's official authorization URL.
5. Sign in at Roblox and review/approve the requested Roblox scopes. DEMO exchanges Roblox's authorization code on the server and stores only an encrypted token envelope and safe account metadata.
6. Return to ChatGPT and call a protected Roblox tool. The tool resolves only the Roblox grant bound to the signed-in DEMO subject; it accepts no account ID or selector.

The browser link form uses a same-origin POST, HttpOnly/Secure/SameSite state cookie, state hash, Roblox PKCE S256, expiry, and replay protection. A link code generated for one Access identity cannot be redeemed under another.

## Disconnect

- In ChatGPT, call `roblox_account_unlink` (ChatGPT may first need to authorize the `roblox:disconnect` scope), or use the signed-in DEMO UI's Roblox **Disconnect** control.
- The browser control posts to `POST /oauth/roblox/logout`; it requires the same Access identity and a same-site request. DEMO deletes only that identity's encrypted Roblox grant and tries to revoke the Roblox refresh token. Local deletion still occurs if Roblox's revoke endpoint is unavailable.
- Removing the ChatGPT MCP connection is a different action. It does not automatically unlink Roblox; likewise, unlinking Roblox does not remove the ChatGPT connection. See [`MCP-OAUTH.md`](MCP-OAUTH.md) for DEMO access-token expiry and revocation.

## Storage, identity, and token handling

- Cloudflare Access's signed human app-token assertion is verified by the Worker (signature/JWKS, issuer, audience, expiry/not-before, and `type: app`). The stable server-derived subject hash—not an email address or tool argument—selects the Roblox record.
- `ROBLOX_AUTH` stores the safe account record and AES-256-GCM encrypted access/refresh/ID tokens. `ROBLOX_TOKEN_KEY` is used to derive the encryption key. The `MCP_AUTH` Durable Object stores hashed DEMO grants and hashed Roblox link codes.
- The Roblox client pins OAuth/Open Cloud endpoints to `apis.roblox.com`; the Roblox client secret is sent only to Roblox's token endpoint in a POST body. Token values do not appear in URLs, client results, responses, logs, or telemetry.
- Access-token refresh is performed server-side; Roblox's rotated single-use refresh token is persisted atomically. A refused refresh marks the grant `reauthorization_required` rather than retrying with a burned refresh token.
- Missing encryption storage fails closed for account operations. DEMO does not silently store Roblox token material in plaintext or rely on an isolate-memory grant for protected calls.
- DEMO does not scrape Roblox web pages, solve CAPTCHAs, bypass login walls, or perform unsupported account writes. Unsupported account actions report `not_supported`.

## Troubleshooting

| Symptom | Cause and next step |
| --- | --- |
| `MCP OAuth is not configured` or `protectedToolOAuthConfigured: false` | Check `MCP_PUBLIC_ORIGIN`, team domain, Access application AUD, and the `MCP_AUTH` binding/migration. Never add a shared API-key fallback. |
| Cloudflare Access does not sign in or the Worker reports an unauthenticated identity | Confirm the Access application protects the interactive OAuth path, emits `CF-Access-Jwt-Assertion`, and the configured team domain/AUD match. Do not protect `/mcp`, metadata, `/oauth/token`, or `/oauth/revoke` with the interactive policy. |
| `storage_unavailable` on Roblox link/status/profile/unlink | Bind `ROBLOX_AUTH` and set `ROBLOX_TOKEN_KEY` as a Worker secret; deploy the migration. The code intentionally refuses plaintext or memory-only protected operations. |
| Roblox says `invalid_redirect_uri` | Compare the Roblox dashboard entry byte-for-byte with `https://<MCP_PUBLIC_ORIGIN>/oauth/roblox/callback` or the configured `ROBLOX_REDIRECT_URI`. |
| The link code is invalid, expired, or used | Call `roblox_account_link_start` for a new code and use it within five minutes in a browser signed into the same Access identity. |
| `insufficient_scope` from DEMO | Reauthorize the ChatGPT connector for the requested DEMO scope. This is separate from Roblox consent. |
| Roblox scope missing or inventory is unavailable | Enable the relevant Roblox scope on the Roblox app and reconnect to Roblox; inventory also respects Roblox's privacy setting. |
| `reauthorization_required` | Roblox rejected/expired the refresh token or the encryption key changed. Start a new link flow and approve again. |
| A public Roblox lookup differs from `roblox_account_profile` | Expected: `roblox_user`/`roblox_game` are anonymous public lookups; account tools resolve only the connected Roblox grant for this DEMO identity. |
| ChatGPT does not start DEMO OAuth on a protected tool | Verify `/tools/list` contains the per-tool `securitySchemes`, protected calls return `_meta["mcp/www_authenticate"]`, and metadata is public. Test with MCP Inspector, then validate the actual ChatGPT connector; live ChatGPT compatibility is not yet confirmed here. |

## Tests and manual checks

Automated coverage is split across `tests/roblox-routes.test.ts` (verified identity, link-code replay/ownership, Roblox callback, encrypted token storage, disconnect/isolation), `tests/mcp-oauth.test.ts`, `tests/access-identity.test.ts`, `tests/mcp-auth.test.ts`, `tests/roblox-account.test.ts`, and UI tests. These use test adapters and stubbed providers; they do not contact Roblox or Cloudflare Access and cannot prove live ChatGPT compatibility.

A real end-to-end acceptance check must be performed after deployment: use the same human Access identity in ChatGPT and the Roblox browser flow, verify one user cannot read or disconnect another user's grant, confirm unlink revokes/deletes only the current user's grant, and verify the public no-login tools still work before and after authorization.
