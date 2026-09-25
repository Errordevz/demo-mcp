# Connect MCP — official client handoffs

Researched 2026-09-25. The inspector dialog is a launcher into each client's
own connection UI. It does not imitate that UI, and it never reports that a
connection succeeded. URL builders live in `src/ui/mcp-clients.ts` and are
locked by `tests/mcp-clients.test.ts`.

The server is the public Streamable HTTP endpoint
`https://demo-mcp.amidevz.workers.dev/mcp`. No DEMO account. Do not send an
authentication header to connect. The Worker was not changed for this flow.

## What was verified

| Client | Official method | What DEMO does |
| --- | --- | --- |
| Claude | Custom-connector install link. `modal=add-custom-connector`, `connectorName`, `connectorUrl`. Prefills the dialog only. The user reviews and confirms. Team/Enterprise owners use the same parameters on the admin path. | Opens that HTTPS link. |
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=&config=` with `config` as base64 of the mcp.json server entry. Remote servers use `{ "url": "..." }`. Cursor prompts to install. | Opens that deeplink. Manual `mcp.json` if the app does not open. |
| Visual Studio Code | `vscode:mcp/install?` plus URL-encoded JSON `{ "name", "type": "http", "url" }`. Insiders uses `vscode-insiders:mcp/install?`. | Opens that link. Does **not** use the unofficial `?name=&config=` form. |
| ChatGPT | Settings → Developer mode, then [ChatGPT Plugins](https://chatgpt.com/plugins), plus button, paste the MCP URL. No documented prefill or website deep link. | Opens `https://chatgpt.com/plugins` with no query string, and shows the paste steps. |
| Claude Code | `claude mcp add --transport http <name> [--scope user] <url>`, run in a terminal. `claude-cli://open` only prefills a prompt and does not install MCP. | Copies the documented command. Does not open `claude-cli://`. |
| Other clients | No shared install link. | Copy the endpoint. Streamable HTTP, no authentication. |

## Sources

- Claude install link: https://claude.com/docs/connectors/building/directory-vs-custom
- Claude add-by-URL: https://claude.com/docs/connectors/custom/add-unlisted
- Claude plans and cloud broker: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Cursor install links: https://cursor.com/docs/mcp/install-links
- Cursor remote `url` config: https://cursor.com/docs/mcp
- VS Code install URL: https://code.visualstudio.com/api/extension-guides/ai/mcp
- VS Code HTTP fields: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- ChatGPT connect steps: https://developers.openai.com/plugins/deploy/connect-chatgpt
- ChatGPT developer-mode availability: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code deep links (not an installer): https://code.claude.com/docs/en/deep-links

## Not claimed

- ChatGPT does not open a native confirmation dialog from this website.
- A mobile-app install link for ChatGPT, Cursor, or VS Code was not found.
- DEMO cannot observe whether the user approved the connection in the other app.
- Codex and the ChatGPT desktop app use a separate MCP setup. The Plugins link does not configure them.

## Platform limits

- Claude's link is HTTPS, so it works in mobile Safari as a website. After the user confirms, Anthropic's docs say the connector is reached from Anthropic's cloud, including desktop and mobile apps.
- Cursor and VS Code links need the desktop app. On iPhone, copy the install link or the configuration. Those app links are same-tab anchors with no `target` or `rel`, so the browser can hand the scheme to the app. HTTPS destinations open in a new tab. The dialog does not call `window.open`.
- Claude Code is a terminal command. User scope (`--scope user`) is what the dialog copies; omitting it registers the server for the current project only.
