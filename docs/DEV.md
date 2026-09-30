# Dev integration

DEMO MCP now exposes Dev alongside Jev and Laya.

- `dev_capabilities` — live presence/configuration report.
- `dev_chat` — coding-focused Dev execution endpoint.

Dev remains an independent MIT-licensed repository at `Errordevz/Dev`. DEMO MCP only integrates it through the server-side `DEV_BASE_URL`; no model credential is sent to MCP clients.

## Configuration

Set the non-secret Worker variable:

`DEV_BASE_URL=https://dev-htce.onrender.com`

Dev's own model provider credential remains server-side on the Render service.

The Dev web UI is public and requires no account. Normal browser chat does not require a user API key. External applications may issue a one-time `DEV_API_KEY` from Dev's `POST /api/key` endpoint and send it as `Authorization: Bearer DEV_...` to `/api/v1/chat`.

## Collaboration role

- **Jev**: typed decisions, routing/review signals and structured judgment.
- **Laya**: external typed-decision/research provider.
- **Dev**: coding execution — repository inspection, targeted edits and verification.

Dev does not replace the existing collaboration workspace. It is an execution specialist that can be invoked through DEMO MCP.
