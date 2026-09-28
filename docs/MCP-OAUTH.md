# ChatGPT → DEMO OAuth 2.1

**Status:** implementation and local automated tests are in the repository. No Cloudflare deployment, live ChatGPT connection, or first protected-tool challenge has been verified in this change. Treat the ChatGPT setup below as the expected configuration, not a confirmed live integration.

## Architecture and boundaries

DEMO has two independent authorization flows:

1. **ChatGPT → DEMO:** OAuth 2.1 authorization-code flow with PKCE `S256`. It authenticates a human through Cloudflare Access and grants ChatGPT short-lived, per-tool permissions to DEMO.
2. **DEMO → Roblox:** Roblox's official OAuth 2.0 authorization-code flow with PKCE. It separately grants DEMO access to one Roblox account after the user explicitly approves Roblox's consent screen.

Approving ChatGPT does **not** connect Roblox. No Roblox password, `.ROBLOSECURITY` cookie, or Roblox token is accepted from ChatGPT or a browser.

### Public and protected MCP tools

The MCP endpoint, initialization, tool/resource discovery, capability reports, UI, and existing public tools remain available without a login or bearer token. In particular, `demo_ping`, public Roblox lookup tools (`roblox_user`, `roblox_game`), and other public tools keep their anonymous behavior.

| MCP tool | Authentication | Scope |
| --- | --- | --- |
| Public tools, including `demo_ping`, `roblox_user`, `roblox_game`, and `jev_capabilities` | `noauth` | None |
| `roblox_account_status`, `roblox_account_profile`, `roblox_account_inventory`, `roblox_account_avatar_thumbnail`, `roblox_account_capabilities` | OAuth 2.1 | `roblox:read` |
| `roblox_account_link_start` | OAuth 2.1 | `roblox:link` |
| `roblox_account_unlink` | OAuth 2.1 | `roblox:disconnect` |
| `jev_decide` | OAuth 2.1 | `decision:use` |

The server adds OpenAI's per-tool `securitySchemes` metadata to the serialized `tools/list` response because the installed MCP SDK drops that field during registration. Every protected handler independently verifies the opaque bearer token, its stored audience, expiration, revocation status, and required scope. Missing or invalid credentials return an MCP tool error with `_meta["mcp/www_authenticate"]` containing `resource_metadata`, `error`, and `error_description`; public tools do not trigger the protected flow.

### Identity and Roblox grant isolation

Cloudflare Access issues a signed `CF-Access-Jwt-Assertion`. The Worker validates its RS256 signature from the configured Access JWKS, exact issuer, audience, time claims, and human app-token type. It hashes the verified subject with tenant/audience context; it does not use email, a tool argument, a query parameter, or a caller-supplied user ID as the account key. Service tokens and unverified/missing identity fail closed.

Each Roblox grant is stored under a server-derived per-user key and carries the same subject hash. Account reads, linking, and unlinking check both. One user's DEMO bearer therefore cannot select or operate on another user's Roblox grant.

Roblox access, refresh and ID tokens plus pending Roblox PKCE verifiers are AES-256-GCM encrypted before they reach the `ROBLOX_AUTH` Durable Object, using a key derived from `ROBLOX_TOKEN_KEY`. Durable protected Roblox operations fail closed if the binding or encryption key is missing. Tokens are never returned in MCP results, browser responses, URLs, logs, or telemetry.

## OAuth protocol behavior

- Resource metadata: `GET /.well-known/oauth-protected-resource`.
- Authorization-server metadata: `GET /.well-known/oauth-authorization-server`.
- Authorization, token and revocation endpoints: `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`.
- Exact canonical issuer/resource comes from `MCP_PUBLIC_ORIGIN`, never from the request `Host` header.
- Only OpenAI ChatGPT CIMD client IDs are accepted: the documented stable `https://chatgpt.com/oauth/client.json` and callback-specific `https://chatgpt.com/oauth/{callback_id}/client.json` forms. DCR and arbitrary redirect URIs are not enabled.
- The client metadata is fetched over HTTPS and checked for the client ID, authorization-code grant, `code` response type, `none` support, and exact ChatGPT redirect URI. The redirect allowlist is limited to `https://chatgpt.com/connector_platform_oauth_redirect` and callback-specific `https://chatgpt.com/connector/oauth/{callback_id}` URIs.
- Authorization requires an unpredictable state, a 43-character PKCE S256 challenge, an exact `resource` match, registered redirect URI, and an explicit browser consent POST protected by an HttpOnly/Secure/SameSite cookie, CSRF token, same-origin check, and verified Access identity.
- Authorization codes are hashed at rest, short-lived, consumed once, and tied to client, redirect URI, resource, scopes, verified identity, and PKCE challenge. Replays fail.
- Access tokens are opaque, random, stored only by hash, revocable, and valid for at most 15 minutes. **No DEMO refresh token is issued**; an expired grant must be reauthorized. The RFC 7009-style revocation endpoint is advertised and implemented.
- Both successful and error authorization redirects include the exact issuer (`iss`) as advertised in discovery metadata.
- The consent page states that public tools remain public and that DEMO authorization does not connect Roblox.

## Cloudflare configuration and deployment

Use a canonical HTTPS hostname that you control and can protect with Cloudflare Access. A custom domain is recommended; if Access cannot attach to the current `workers.dev` hostname in your account, use a custom domain and make it the canonical origin everywhere.

### 1. Configure variables and bindings

`wrangler.jsonc` declares:

- `MCP_AUTH` → `McpAuth` Durable Object, migration `v3`.
- `ROBLOX_AUTH` → `RobloxAuth` Durable Object.
- `MCP_PUBLIC_ORIGIN` → exact public HTTPS origin (no path).
- `MCP_AUTH_ACCESS_TEAM_DOMAIN` → e.g. `your-team.cloudflareaccess.com`.
- `MCP_AUTH_ACCESS_AUD` → the audience tag for the human Access application.
- `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` → `900` (code clamps it to 300–900).
- `MCP_AUTH_RATE_LIMIT_PER_MINUTE` → `30` (code clamps it to 1–300).

Replace the two Cloudflare Access placeholders in `wrangler.jsonc` with real non-secret values, and set `MCP_PUBLIC_ORIGIN` to the deployed origin (including any custom domain). Do not put credentials or key material in `vars`.

### 2. Create the Cloudflare Access application

Create an interactive, human-authenticated Access application and policy. Protect the interactive identity pages needed by this implementation, at minimum `/oauth/authorize` and `/oauth/roblox/*`. Ensure the Worker receives the signed `CF-Access-Jwt-Assertion` header on these requests, and configure the exact team domain and application AUD above. Allow human identities; service tokens are intentionally rejected as user identities.

**Do not protect the entire hostname, `/mcp`, public tools, OAuth metadata, `/oauth/token`, or `/oauth/revoke` with an interactive Access login.** Blanket Access protection would break anonymous tools and ChatGPT's back-channel token exchange. Use path-scoped Access applications/policies or a custom domain arrangement that leaves those paths public.

### 3. Configure Roblox (only if you want Roblox account tools)

Create a Roblox OAuth application and register exactly:

```text
https://<canonical-origin>/oauth/roblox/callback
```

Set `ROBLOX_CLIENT_ID` as a non-secret Worker variable. Set the client secret and encryption key as encrypted Worker secrets:

```sh
npx wrangler secret put ROBLOX_CLIENT_SECRET
npx wrangler secret put ROBLOX_TOKEN_KEY
```

Generate a unique key, for example with `openssl rand -base64 32`; keep its value backed up securely because rotating it makes existing encrypted grants unreadable. The default Roblox scopes are `openid profile`; add `user.inventory-item:read` for inventory and, where approved by Roblox, `user.advanced:read` or `user.social:read` for the extended profile. Any added scope requires Roblox re-consent.

### 4. Optional paid decision-provider secret

`jev_decide` requires both the user-granted `decision:use` DEMO OAuth scope and the server-side TypeSafe credential. If enabling the TypeSafe provider, set `TYPESAFE_API_KEY` as an encrypted Worker secret. It is unrelated to ChatGPT's DEMO OAuth client authentication.

### 5. Deploy and validate

```sh
npm ci
npm run typecheck
npm test
npm run build:check
npx wrangler deploy
```

The deployment must apply the existing DO migrations, including `v3`. Before connecting ChatGPT, verify the live Worker:

```sh
curl -i https://<canonical-origin>/.well-known/oauth-protected-resource
curl -i https://<canonical-origin>/.well-known/oauth-authorization-server
curl -i https://<canonical-origin>/health
```

Confirm metadata uses the exact issuer/origin, `code_challenge_methods_supported` includes `S256`, and `/health` reports the protected OAuth configuration as ready. Use MCP Inspector to confirm unauthenticated `initialize`, `tools/list`, a public tool call, and a scoped challenge from a protected tool before trying ChatGPT.

## Connect from ChatGPT

OpenAI's current MCP auth documentation describes per-tool `noauth` and `oauth2` schemes and tool-level `_meta["mcp/www_authenticate"]` challenges; its developer-mode connection guide is at [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt), and the protocol details are in [Authenticate your users](https://developers.openai.com/plugins/build/auth).

Expected setup after deployment:

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**, if available for your account/workspace.
2. Open the ChatGPT Plugins/connection page and select the **plus** button to add a remote MCP server.
3. Name it **DEMO** and enter the exact endpoint `https://<canonical-origin>/mcp`.
4. Choose **Mixed Authentication** for the per-tool public `noauth` plus protected `oauth2` scheme, if ChatGPT offers that option for this connection.
5. Save/refresh the discovered tools. Call a public tool first; it should work without login. Then call a protected tool. ChatGPT should follow the resource metadata challenge and start DEMO OAuth. Sign in through Cloudflare Access and review the requested DEMO scopes before approving.
6. To connect Roblox, call `roblox_account_link_start` in ChatGPT. Open the returned `linkUrl` in a browser signed in with the **same Cloudflare Access identity**, paste the one-time `linkCode`, then sign in and approve scopes on Roblox's official consent page. That approval is separate from ChatGPT → DEMO.

If ChatGPT does not offer Mixed Authentication, does not show the protected tool's OAuth flow, or cannot complete the authorization-code exchange, do not switch to a shared API key and do not claim the integration works. Continue using the public tools while you investigate the deployed metadata/challenge in the actual ChatGPT account. This repository has not yet exercised that live flow.

## Disconnect and revoke

- **Disconnect ChatGPT from DEMO:** remove/disconnect the MCP server in ChatGPT's connection settings. ChatGPT can call `/oauth/revoke`; DEMO revocation is idempotent. Any unrevoked token expires within at most 15 minutes even if the client does not revoke it.
- **Disconnect Roblox:** use `roblox_account_unlink` in ChatGPT (requires `roblox:disconnect`) or the signed-in DEMO UI's Roblox disconnect control, which posts to `/oauth/roblox/logout`. DEMO deletes the user's encrypted Roblox grant and best-effort revokes its Roblox refresh token. Removing the ChatGPT connector and unlinking Roblox are independent actions.

## Automated coverage and limitations

The repository includes tests for Cloudflare Access JWT signature/issuer/audience/time/type validation, OAuth metadata and client/redirect validation, PKCE/consent/CSRF/replay/expiry, hashed token storage and revocation, per-tool scopes and public no-login compatibility, per-user Roblox-grant isolation, Roblox link-code ownership, encrypted storage, disconnect, and browser/UI token leakage. These tests use fakes; they do not prove that production Cloudflare Access path policies or the current ChatGPT UI/workflow have been configured correctly.

Known limits: protected OAuth clients are currently restricted to the documented ChatGPT CIMD URL shapes; there is no DCR or general-purpose MCP-client registration. DEMO issues no refresh token. A user must reauthorize after 15 minutes. Actual ChatGPT mixed-auth compatibility remains a live deployment check, not a test result.
