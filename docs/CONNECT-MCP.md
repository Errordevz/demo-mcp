# Connect MCP clients to DEMO

Research date: 2026-09-28. The inspector's **Connect MCP** dialog is a launcher into each client's setup; it does not imitate that UI or claim a connection succeeded. Handoff URLs are built by `src/ui/mcp-clients.ts` and covered by `tests/mcp-clients.test.ts`.

DEMO's public Streamable HTTP endpoint is `https://demo-mcp.amidevz.workers.dev/mcp`. Do not configure a shared bearer/API key. MCP initialization, tool discovery, resources, and public tools work without a login. Only account-specific Roblox tools and paid `jev_decide` request per-tool DEMO OAuth. The ChatGPT flow described below is the expected setup, but the actual ChatGPT Mixed Authentication UI and live compatibility have **not** been verified for this deployment.

## Client setup

| Client | Official method | What DEMO does and what it supports |
| --- | --- | --- |
| ChatGPT | Enable Developer mode in **Settings → Security and login**, then open the ChatGPT Plugins/connections page and add a remote MCP server. OpenAI's current guide: [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). | Opens `https://chatgpt.com/plugins` without query parameters; it does not prefill the endpoint. Enter `https://demo-mcp.amidevz.workers.dev/mcp`. Select **Mixed Authentication** for the expected public `noauth` plus protected `oauth2` tools, if that option is offered. The actual option, discovery, OAuth challenge, and full connection are pending a live check. Until they are confirmed, rely only on public tools. |
| Claude | Official custom-connector add link. The link prefills the dialog but the user reviews and confirms. | The current connector handoff is no-auth and intended for public tools only. Protected DEMO OAuth has not been configured or tested in Claude. |
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=&config=` where `config` is base64 of the documented mcp.json server entry. | Opens Cursor's install prompt. This handoff is no-auth; use public tools only. Protected DEMO OAuth support is unverified. |
| Visual Studio Code | `vscode:mcp/install?` plus URL-encoded JSON `{ "name", "type": "http", "url" }`. Insiders uses `vscode-insiders:mcp/install?`. | Opens VS Code's install flow. This handoff is no-auth; use public tools only. Protected DEMO OAuth support is unverified. |
| Claude Code | `claude mcp add --transport http <name> [--scope user] <url>` in a terminal. `claude-cli://open` only prefills a prompt and does not install MCP. | Copies the documented command. Public tools only unless the client supports and is explicitly configured for DEMO's per-tool OAuth. |
| Other clients | There is no shared install link. | Copy the endpoint. Public tools work without authentication. Protected tools require a ChatGPT-compatible OAuth registration and a client with per-tool OAuth support. |

## ChatGPT setup after deploying DEMO OAuth

1. First complete the Cloudflare steps in [`MCP-OAUTH.md`](MCP-OAUTH.md): set the canonical HTTPS origin and Access team/AUD, configure path-scoped human Cloudflare Access, deploy the `MCP_AUTH` migration, and verify metadata and health.
2. In ChatGPT, enable **Developer mode** at **Settings → Security and login** if available to your account or workspace.
3. Open the ChatGPT Plugins/connection page and use the **plus** button to add a remote MCP server. Name it **DEMO** and set the exact endpoint to `https://demo-mcp.amidevz.workers.dev/mcp` (or your deployed canonical origin followed by `/mcp`).
4. Choose **Mixed Authentication** for the per-tool public no-auth and protected OAuth schemes, if ChatGPT offers it. This exact UI choice and this deployment have not been live-tested; do not report compatibility until the connection succeeds and a protected challenge completes.
5. Refresh the tools. Test a public tool such as `demo_ping` first; it should not ask for login. Call a protected tool next; the expected behavior is a DEMO OAuth consent flow. Sign in with the Cloudflare Access human identity and review the requested scope. Reauthorize when ChatGPT challenges for a scope not yet granted.
6. For Roblox, call `roblox_account_link_start` after DEMO OAuth. Open its returned `linkUrl` in a browser signed into the same Access identity, paste the one-time code, and approve Roblox's official consent. This is separate from the ChatGPT → DEMO authorization.

**If ChatGPT doesn't offer Mixed Authentication or doesn't follow the protected-tool OAuth challenge, use only public tools.** Do not replace the design with a shared API key or describe it as a successful mixed-auth integration. Diagnose the actual deployed `/tools/list`, `WWW-Authenticate` MCP metadata challenge, and OAuth endpoints with MCP Inspector before retesting ChatGPT.

## Disconnect

- Remove/disconnect DEMO in ChatGPT's connection settings. DEMO's `/oauth/revoke` endpoint supports revocation; an access token not explicitly revoked expires within at most 15 minutes. No DEMO refresh token is issued.
- To disconnect only Roblox, use `roblox_account_unlink` or the signed-in DEMO UI's Disconnect control. Removing ChatGPT and unlinking Roblox are separate actions.

## Sources

- [OpenAI: Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI: Authenticate your users](https://developers.openai.com/plugins/build/auth)
- [OpenAI: Developer mode availability](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- Claude install link: https://claude.com/docs/connectors/building/directory-vs-custom
- Claude add-by-URL: https://claude.com/docs/connectors/custom/add-unlisted
- Claude plans and cloud broker: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Cursor install links: https://cursor.com/docs/mcp/install-links
- Cursor remote `url` config: https://cursor.com/docs/mcp
- VS Code install URL: https://code.visualstudio.com/api/extension-guides/ai/mcp
- VS Code HTTP fields: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code deep links (not an installer): https://code.claude.com/docs/en/deep-links

## Not claimed

- The website does not open a native confirmation dialog or report that the user approved a connection in another app.
- No ChatGPT mobile-app install link was found; the documented setup is ChatGPT web.
- This setup does not configure Codex or the ChatGPT desktop app; they use separate MCP setup.
- No cross-client or production Cloudflare Access path-policy test is implied by local automated tests.

## Platform limits

- Claude's link is HTTPS and opens in a browser. After the user confirms, Anthropic's cloud reaches the connector for supported Claude clients.
- Cursor and VS Code links need their desktop apps. On iPhone, copy the public endpoint/config instead.
- Claude Code's install command must be run in a terminal. User scope (`--scope user`) registers the server for that user; omitting it registers at project scope.
