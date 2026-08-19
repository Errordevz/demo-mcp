# DEMO MCP — Independent Browser + Skills Gateway

DEMO MCP is the execution layer behind DEMO Platform. It exposes the MCP endpoint, skills.sh integration, native utilities and an independent Cloudflare Browser Run environment.

## Architecture

```text
ChatGPT / MCP client
        │
        ▼
DEMO MCP Worker
        │
        ├── /mcp
        ├── /health
        ├── /platform/stats
        ├── /screenshots/:id
        ├── skills.sh
        └── independent Browser Run
                    │
                    ▼
             Cloudflare R2
             screenshot storage

DEMO Platform ──────► /platform/stats + /health
```

DEMO no longer depends on Composio. External integrations can be added as native DEMO connectors later without making a third-party routing provider part of the core architecture.

## Browser watching

DEMO now treats browsing as an execution capability rather than a simple HTTP fetch.

Browser tools include:

- `browser_open` — open a website and inspect navigation metadata
- `browser_inspect` — inspect headings and interactive elements
- `browser_click` — interact with a page
- `browser_fill` — fill inputs
- `browser_type` — type into a page
- `browser_press` — press keys
- `browser_scroll` — scroll
- `browser_wait` — wait for selectors/time
- `browser_evaluate` — execute page JavaScript
- `browser_console` — collect console/page errors
- `browser_run` — execute a multi-step workflow in one browser instance
- `browser_watch` — actively explore a website with screenshot checkpoints
- `browser_task` — prepare a skill-aware browser task

The browser runs on the DEMO Worker, not inside ChatGPT.

## Screenshot delivery

Screenshot binaries are intentionally **not returned as MCP image payloads**. Instead, DEMO stores them in Cloudflare R2 and returns a compact URL such as:

```text
https://demo-mcp.www-notamirrblx.workers.dev/screenshots/<random-id>
```

This keeps the large image bytes outside the MCP response and lets the user open the image directly in a browser. It also avoids assuming that every MCP client can render image content.

This does **not** make ChatGPT's own platform token/usage limits disappear. It does, however, keep the screenshot binary out of the ChatGPT tool result and dramatically reduce the result payload.

Cloudflare R2 is accessed through a Worker binding; the bucket stores the image object and the Worker serves it through the screenshot route.

## Skills

DEMO continues to search, fetch, audit and apply skills from skills.sh. Skills are treated as instruction material and cannot override system, developer, safety or user instructions. DEMO does not execute arbitrary installer commands merely because a skill requests them.

## Safe telemetry

`GET /platform/stats` returns non-sensitive operational state for DEMO Platform, including:

- DEMO version
- Worker-isolate uptime
- request count since isolate start
- native tool count
- skill capability count
- browser/screenshot capability state
- active service/capability connections

It deliberately excludes secrets, OAuth tokens, cookies, prompts, private account information and user content.

## CORS

The Worker allowlists the Platform origin through `DEMO_PLATFORM_ORIGIN` and includes local development origins. The default planned Platform origin is:

```text
https://demo-platform.pages.dev
```

Change the variable when the final Platform domain is known.

## R2 setup

The Worker expects an R2 bucket named `demo-mcp-screenshots` bound as `SCREENSHOTS`.

Create it in Cloudflare R2 before deploying:

```bash
npx wrangler r2 bucket create demo-mcp-screenshots
```

Then deploy the Worker:

```bash
npm install
npm run typecheck
npm run deploy
```

Cloudflare documents R2 Worker bindings and `put()`/`get()` object operations in its R2 Workers API documentation.

## Security

- No third-party gateway API key is required by DEMO.
- Optional `DEMO_API_KEY` protects the MCP endpoint.
- Platform telemetry is intentionally non-sensitive.
- Screenshot URLs use high-entropy random identifiers and are not listed by the Worker.
- Screenshot objects should have an R2 lifecycle rule configured if you want automatic deletion after a retention period.
- Browser origins and Platform origins are explicitly allowlisted.

## Deployment

The Cloudflare entrypoint is `platform-entry.ts`.

`wrangler.jsonc` binds Browser Run as `BROWSER` and R2 as `SCREENSHOTS`.
