# DEMO v0.1 — Cloudflare Remote MCP

A Cloudflare Workers implementation of DEMO, designed to be connected through one remote MCP URL.

## What is included

- Streamable HTTP MCP endpoint: `/mcp`
- Optional Bearer authentication
- DEMO ping
- JSON formatting
- SHA-256 / SHA-512 hashing
- UUID generation
- HTTP fetch
- Roblox user lookup
- Roblox experience lookup

## Deploy from your computer

Install Node.js 22+ and authenticate Wrangler:

```bash
npm install
npx wrangler login
npm install
npm run typecheck
npm run deploy
```

Wrangler prints a URL similar to:

```text
https://demo-mcp.<your-subdomain>.workers.dev
```

Your MCP URL is:

```text
https://demo-mcp.<your-subdomain>.workers.dev/mcp
```

## Add an API key

Create a strong secret:

```bash
npx wrangler secret put DEMO_API_KEY
```

Enter the key when prompted.

Then clients should send:

```text
Authorization: Bearer YOUR_KEY
```

## Test

Health:

```text
https://demo-mcp.<your-subdomain>.workers.dev/health
```

MCP:

```text
https://demo-mcp.<your-subdomain>.workers.dev/mcp
```

## Connect from a phone

Use the `/mcp` URL in an MCP client that supports remote Streamable HTTP MCP servers. If the client asks for authentication, choose Bearer token and provide the value stored in `DEMO_API_KEY`.

## Browser automation

DEMO v0.1 keeps browser automation out of this base Worker. For the next release, integrate Cloudflare Browser Run / Playwright MCP rather than trying to install normal Chromium/Playwright inside a Worker.

## Security

Do not expose an unauthenticated DEMO server once you add powerful tools. The API key is intentionally simple for v0.1; production DEMO should add stronger authentication, rate limits, per-tool permissions, and auditing before adding shell or arbitrary server-side code execution.
