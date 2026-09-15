# Testing

```bash
npm test          # vitest run  — unit + integration + build gate
npm run typecheck # tsc --noEmit over src/ and tests/
npm run build:check # CI=1 wrangler deploy --dry-run --outdir dist
```

The suite is designed so that **only the browser transport is faked**. Page
scripts, the SSRF guard, redaction, challenge detection, payload parsing,
snapshot rendering and the whole MCP/HTTP surface run for real.

## Layers

| Layer | Where | What it proves |
| --- | --- | --- |
| Pure units | `tests/url-guard.test.ts`, `tests/redact.test.ts`, `tests/challenge.test.ts`, `tests/snapshot.test.ts`, `tests/tiktok.test.ts` | SSRF blocking (static + DNS), secret redaction, challenge classification, bounded rendering, TikTok payload parsing. |
| Page scripts | `tests/page-scripts.test.ts` | The serialised in-page functions run under jsdom in a `vm` context — the same way a browser would run them. |
| Runtime integration | `tests/browser-session.test.ts` | `BrowserRuntime` against a fake provider: open, redirects, screenshots → R2, a11y snapshots, tabs, timeouts, login walls, CAPTCHA pause/resume, degraded capabilities, typing secrets. |
| Media | `tests/media.test.ts` | Metadata reports and frame sampling, including the "cannot decode", "DRM protected" and "no video" honest-failure paths. |
| Public video | `tests/video.test.ts` | Safe redirect/media-candidate resolution, SSRF redirect rejection, platform challenge reporting and content-addressed expiring artifact references. |
| MCP surface | `tests/mcp-tools.test.ts` | The Worker itself: tool inventory (47 tools incl. every original DEMO tool), `demo_ping`, utility tools, capability reporting without bindings, URL validation, session validation, auth on `/mcp`, `/health`, `/tools`, `/platform/stats`, screenshot id validation. |
| Build gate | `tests/worker-build.test.ts` | `wrangler deploy --dry-run` succeeds and the plan contains every binding. |
| Live (opt-in) | `tests/live.test.ts`, `tests/video-live.test.ts` | Real Browser Run: open a page, screenshot to R2, read, snapshot, TikTok short link, and the supplied TikTok URL with a requirement for actual MCP image frames or an exact technical failure. |

## Fixtures and helpers

* `tests/fixtures/pages.ts` — realistic HTML: a simple page, a login wall, a
  Cloudflare interstitial, a consent banner, an access-denied page, a 404,
  TikTok's verification wall, a TikTok video page with a real
  `__UNIVERSAL_DATA_FOR_REHYDRATION__` payload (video + image-post + no-media
  variants) and a legacy `SIGI_STATE` page.
* `tests/helpers/dom.ts` — `runInPage()` serialises a function exactly like the
  runtime does and executes it inside jsdom, so page scripts are tested against
  a real DOM implementation.
* `tests/helpers/fake-provider.ts` — `FakePage`, `FakeBrowser`, `FakeProvider`
  and `FakeObjectStore`. The fake browser can toggle Live View/handoff support
  and inject launch errors, limits and rate-limit failures.
* `tests/helpers/live.ts` — opt-in live client (Streamable HTTP MCP over
  `fetch`) plus `wrangler dev` bootstrapping.

## Running the live tests

Live tests drive the real Cloudflare Browser Rendering service and consume
browser-minutes, so they only run when explicitly enabled:

```bash
# against a deployed worker
DEMO_MCP_LIVE=1 \
LIVE_WORKER_URL=https://demo-mcp.<subdomain>.workers.dev \
LIVE_API_KEY=<DEMO_API_KEY or unset> \
npm run test:live

# or boot wrangler dev locally (needs Cloudflare credentials)
DEMO_MCP_LIVE=1 \
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
npm run test:live
```

Requirements for a meaningful run:

* `BROWSER` (Browser Run) binding — **Workers Paid** for more than 3 concurrent
  sessions / 10 browser-minutes per day.
* `SCREENSHOTS` (R2) binding, otherwise screenshots are reported as unavailable.
* `BROWSER_SESSIONS` (Durable Object) binding, otherwise sessions live only in
  the isolate that handled the request.
* `LIVE_TIKTOK_URL` can point the TikTok test at a specific video; the default
  is a public TikTok video URL. TikTok may block Browser Run traffic — the test
  accepts an honest `limitations` report as a pass.

Tests skip (not fail) when a capability the environment cannot provide is
missing (`capability_unavailable`, `rate_limited`).

## Verifying Cloudflare compatibility

1. `npm run build:check` — the bundle must build (`Total Upload …`).
2. The build-gate test asserts the same thing inside the suite.
3. Manual audit (kept as a review step): the built Worker must not contain a
   static import of the Node adapter. `puppeteer-core` and `NodeBrowserProvider`
   may appear only inside error strings; `providers/node` must never be imported
   on the Worker path.

## What is deliberately not tested

* No CAPTCHA solving, no anti-bot evasion, no fingerprint spoofing — there is
  nothing to test, by design.
* No fixtures containing real credentials, cookies or tokens; the redaction
  tests use obviously fake secrets.
* No unbounded scraping of video frames — frame sampling is capped in code and
  asserted in tests.
