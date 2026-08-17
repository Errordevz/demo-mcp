# DEMO MCP — Cloudflare Worker

DEMO MCP is the execution/backend layer for **DEMO Platform**. The Platform is the UI and control center; this Worker owns MCP tools, browser automation, skills.sh access and external-service integrations.

## Architecture

```text
DEMO Platform (website)
        │
        │ HTTPS + CORS
        ▼
DEMO MCP Worker (Cloudflare)
        │
        ├── /mcp
        ├── /health
        ├── /platform/stats
        ├── skills.sh
        ├── Browser Run
        └── external integrations
```

Current Worker entrypoint is `platform-entry.ts`. It wraps the existing `index.ts` MCP implementation rather than replacing its tools.

## Current endpoints

- `GET /` — public basic status
- `GET /health` — public health status
- `GET /platform/stats` — safe Platform telemetry
- `/mcp` — remote MCP endpoint

### Safe telemetry

`/platform/stats` exposes only operational metadata such as:

- DEMO version
- online status
- isolate-local uptime
- isolate-local request counter
- enabled capability flags
- endpoint names

It intentionally does **not** expose API keys, OAuth tokens, cookies, prompts, user content, SMTP credentials, environment variables or private account data.

The request counter and uptime are isolate-local because ordinary Worker memory is ephemeral. They reset when an isolate is recycled; they are not presented as globally authoritative analytics.

## Platform CORS

Browser requests are allowlisted before reaching MCP. The configured Platform origin is supplied through the non-secret `DEMO_PLATFORM_ORIGIN` variable, with the current fallback:

```text
https://demo-platform.pages.dev
```

Local development origins are also supported:

```text
http://localhost:3000
http://localhost:5173
http://127.0.0.1:3000
http://127.0.0.1:5173
```

If the Platform gets a custom domain, update `DEMO_PLATFORM_ORIGIN` in Cloudflare Worker Variables. For multiple origins, use a comma-separated allowlist. Do not change this to `*` for the MCP endpoint.

The gateway validates the incoming browser Origin and then delegates the already-validated request to the existing MCP implementation. This keeps the Platform connected without opening MCP to arbitrary websites.

Cloudflare recommends explicit CORS handling for Worker APIs and warns that CORS is not authentication; the MCP endpoint should still use authentication when protected operations are exposed.

## Existing capabilities

The underlying `index.ts` implementation remains responsible for DEMO's existing capabilities, including:

- DEMO ping
- JSON formatting
- SHA-256 / SHA-512 hashing
- UUID generation
- HTTP fetch
- Roblox lookups
- Cloudflare Browser Run navigation/inspection
- screenshots
- browser interaction
- skills.sh discovery/fetching
- Composio-connected app tools when configured

## Authentication

Optional Bearer authentication remains supported through `DEMO_API_KEY`:

```bash
npx wrangler secret put DEMO_API_KEY
```

Never put API keys, OAuth tokens, SMTP credentials or app passwords in GitHub source or `wrangler.jsonc`. Cloudflare recommends Worker secrets for sensitive values.

## Deployment

```bash
npm install
npm run typecheck
npm run deploy
```

The Worker should continue to deploy to the existing `demo-mcp.<subdomain>.workers.dev` hostname unless its Cloudflare configuration is changed.

## DEMO Platform

The companion UI repository is `Errordevz/demo-platform`. It polls `/platform/stats` and `/health` and displays live Worker state in the independent DEMO Platform dashboard.
