# DEMO MCP — Independent Tool Gateway

DEMO MCP is an independent MCP gateway for connecting ChatGPT and other MCP clients to a large catalog of external tools. **DEMO is the product and public interface; Composio is an internal routing/integration backend.** Provider API keys and OAuth credentials stay server-side.

## Architecture

```text
ChatGPT / MCP client
        │
        ▼
DEMO — independent MCP + gateway surface
        │
        ├── /mcp
        ├── /gateway
        ├── /gateway/tools
        ├── /gateway/toolkits
        ├── Browser Run
        └── native DEMO utilities
                │
                ▼
        Composio API (server-side)
                │
        ┌───────┼────────┐
        ▼       ▼        ▼
      GitHub   Gmail    Slack   …
```

Composio is deliberately hidden behind DEMO's gateway surface. Clients interact with DEMO tools rather than needing the backend provider's API key.

## Public UI

`GET /` now serves an independent DEMO Tool Gateway dashboard with:

- DEMO branding and status
- MCP endpoint information
- backend health visibility without exposing secrets
- live Composio-backed tool search
- responsive glass-style presentation

The UI is implemented in `ui.ts` and served directly by the Worker, so the gateway does not depend on a separate AI product UI.

## Gateway endpoints

- `GET /` — independent DEMO gateway UI
- `GET /gateway` — gateway status and architecture metadata
- `GET /gateway/tools?query=...` — server-side search of the Composio tool catalog
- `GET /gateway/tools?toolkit=github` — filter tools by toolkit
- `GET /gateway/toolkits` — server-side toolkit catalog
- `GET /health` — health status
- `GET /platform/stats` — safe operational telemetry
- `/mcp` — remote MCP endpoint

The gateway endpoints use the existing `COMPOSIO_API_KEY` Worker secret and never send that secret to the browser.

## MCP gateway capabilities

The underlying MCP implementation provides DEMO-native utilities, browser automation, and Composio session routing. Composio-backed operations can discover tools, expose schemas, create secure app connection links, and execute authorized tools through a DEMO-owned MCP surface.

The intended flow is:

1. ChatGPT connects to DEMO's `/mcp` endpoint.
2. DEMO exposes the gateway operations.
3. DEMO discovers the required external tool through Composio.
4. If authorization is required, the user completes the secure connection flow.
5. DEMO executes the selected tool server-side.
6. Results return through DEMO to the MCP client.

This keeps the integration layer replaceable: Composio can power the backend without becoming DEMO's public identity.

## Security

- `COMPOSIO_API_KEY` stays in Cloudflare Worker Secrets.
- Optional `DEMO_API_KEY` protects the MCP and gateway APIs.
- Browser origins are explicitly allowlisted.
- OAuth credentials and connected-app tokens are not exposed to the UI.
- `/platform/stats` intentionally excludes secrets, cookies, prompts, user content and private account data.

Set secrets with Wrangler:

```bash
npx wrangler secret put COMPOSIO_API_KEY
npx wrangler secret put DEMO_API_KEY
```

## Deployment

```bash
npm install
npm run typecheck
npm run deploy
```

The Cloudflare entrypoint is `platform-entry.ts`.

## Design direction

DEMO should remain the recognizable layer: independent branding, gateway UX, MCP surface, policies and native utilities. Backend providers are implementation details and can be swapped or expanded without changing how ChatGPT connects to DEMO.
