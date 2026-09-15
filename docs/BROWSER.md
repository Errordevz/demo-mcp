# Browser subsystem

Design notes for the browser/visual-inspection layer of DEMO MCP. Everything
here runs on Cloudflare Workers with real Browser Rendering (Browser Run);
nothing needs a local server, Docker or a desktop browser.

## Module map

```text
src/browser/
  types.ts          Page/Browser handles, BrowserProvider contract, capability types
  providers/
    cloudflare.ts   Cloudflare Browser Run (@cloudflare/puppeteer) provider
    node.ts         OPTIONAL Node/Puppeteer provider — lazily imported, dev/test only
    index.ts        resolveBrowserProvider(): picks cloudflare | node from env
  runtime.ts        BrowserRuntime: sessions, tabs, redirects, retries, heartbeats
  ops.ts            Pure-ish operations over a PageHandle (open/read/click/type/…)
  page-scripts.ts   Functions serialised into the page (no module closures)
  challenge.ts      Login wall / consent / CAPTCHA / access-denied detection
  screenshot.ts     ScreenshotManager: bounds, R2 storage, public URLs
  snapshot.ts       Accessibility tree + interactive-element rendering
  media.ts          MediaInspector: metadata reports + video frame sampling
  tiktok.ts         TikTok URL + payload parsing (universal / SIGI / meta)

src/session/
  manager.ts        SessionManager: capability reporting, session CRUD, memory fallback
  facade.ts         BrowserSession facade over the runtime (used by MCP tools)
  durable-object.ts BrowserSession Durable Object: state + alarms + persistence
  factory.ts        Per-request dependency wiring from `env`

src/mcp/
  browser-tools.ts  17 MCP tools over persistent sessions
```

## Provider abstraction

`BrowserProvider` is the only thing that knows how a browser is obtained:

```ts
interface BrowserProvider {
  readonly name: "cloudflare" | "node";
  isAvailable(): boolean;                       // env.BROWSER present? local service?
  unavailableReason(): string | null;           // human-readable, safe to show
  capabilities(): ProviderCapabilities;         // liveView, handoff, videoFrames, … 
  launch(options): Promise<BrowserHandle>;      // keep_alive, viewport, guardrails
  connect(sessionId, options): Promise<BrowserHandle>;
  sessions(): Promise<ProviderSessionInfo[]>;
  limits(): Promise<ProviderLimits | null>;
  closeSession(sessionId): Promise<void>;
  ping?(browser): Promise<boolean>;
}
```

* `CloudflareBrowserProvider` wraps `@cloudflare/puppeteer`
  (`launch(env.BROWSER, …)` / `connect(env.BROWSER, sessionId)`). It is the only
  provider used in production; the Node adapter is imported lazily
  (`await import("./providers/node.js")`) and **never** reaches the Worker
  bundle — verified by the build-gate test and by grepping the built output.
* Everything above the provider is transport-agnostic: `PageHandle` /
  `BrowserHandle` are narrow interfaces, so the same operations run against a
  real Cloudflare browser, or, in tests, against a fake transport that executes
  the real page scripts under jsdom.

## Sessions

Each MCP request rebuilds the MCP server (the transport is stateless), so
session state must outlive the request:

1. `SessionManager` stores the session record in the `BROWSER_SESSIONS`
   Durable Object when the binding exists, and in an in-process `Map`
   otherwise (`sessionStorage: "memory"` — sessions die with the isolate).
2. A session record holds the Browser Run `sessionId`, tab list, viewport,
   timestamps, challenge state and the last screenshot id.
3. Subsequent requests call `puppeteer.connect(env.BROWSER, sessionId)` to
   re-attach to the same remote browser.
4. `keep_alive` (default 300 s, max 600 s) is refreshed on every launch/connect,
   and a heartbeat runs while a session is paused for a human, so a CAPTCHA can
   be solved without the browser evaporating.
5. The Durable Object sets an alarm to release the browser if the client never
   comes back; `browser_session { action: "close" }` releases it immediately.

## Rendered-state inspection (not raw HTTP)

`browser_read` / `browser_snapshot` / `browser_media_info` run against the live
DOM after the page has rendered, which is the only way to see client-side
rendered content (React/Vue hydration, lazy media, redirect chains). They are
bounded by `LIMITS` (text chars, links, snapshot nodes, JSON-LD blocks, raw
hydration payload size) so a pathological page cannot flood the MCP response.

## Challenges and human-in-the-loop

`detectChallenge()` scores signals gathered *inside the page* (password fields,
captcha widgets/iframes, consent banners, "verify you are human" copy, vendor
names such as `google-recaptcha`, `hcaptcha`, `cloudflare-turnstile`, `datadome`,
`arkose`) plus HTTP status and URL hints.

Rules that matter:

* Detection only. No solving, no bypassing, no fingerprint spoofing, no
  CAPTCHA-farm integration.
* A challenge returns `status: "challenge_required"` with the challenge kind,
  the current URL and a screenshot — never a claim that it was bypassed.
* `browser_pause_for_human` returns a Live View URL (and starts a Cloudflare
  handoff when the browser supports it), keeps the session alive, and tells the
  user what to do.
* `browser_resume` re-checks the page: `challengeCleared: true` only when the
  signals are actually gone. If the human abandoned it, the tool says so.
* If the browser binding does not support Live View/handoff, the tool says that
  explicitly rather than pretending.

## Screenshots and frames

* Captured as PNG (or JPEG when asked), clamped to `LIMITS.screenshotMaxBytes`,
  full pages clamped to `LIMITS.fullPageMaxHeightPx`.
* Stored in R2 under `screenshots/<32 hex><16 hex>.png`; the Worker serves them
  at `/screenshots/:id` (and `/frames/:id`) with an immutable cache header.
* Tools return **links** by default. `inline_base64` is allowed but capped at
  `LIMITS.inlineImageMaxBytes` (512 KiB) so a huge page cannot blow up a chat.
* `browser_video_frames` seeks a *publicly accessible, non-DRM* `<video>`
  element and captures a bounded number of frames (default 4, max 8, or explicit
  timestamps, all clamped below the duration). DRM/EME protected media is
  refused outright; media that cannot be decoded is reported as unavailable with
  the reason.

## TikTok specifics

* Short links (`vt.tiktok.com`, `vm.tiktok.com`, `m.tiktok.com/v/<id>.html`)
  are followed to the canonical `www.tiktok.com/@user/video/<id>` URL.
* Metadata sources, in order: `__UNIVERSAL_DATA_FOR_REHYDRATION__` →
  `SIGI_STATE` / `__SIGI_STATE__` → OpenGraph/Twitter/`<meta>` tags.
* Extracted: author (`uniqueId`, `nickname`, `verified`), caption, hashtags,
  video id, thumbnail, duration, dimensions, playable URL, play/like/comment/
  share counts, music, creation time, photo-carousel flag.
* `limitations` always states what was *not* visible: verification wall, login
  wall, region block, missing media element, no playable URL, DRM, or a signed
  expiring URL. Nothing is inferred or invented.
* Cloudflare Browser Run traffic is always identified as bot traffic, so TikTok
  (or any site) may block it. The tools report that honestly instead of
  retrying with evasive tricks.

## Error model

Every failure carries a stable code so a client can react:

| Code | Meaning |
| --- | --- |
| `capability_unavailable` | Binding/service/plan feature missing (e.g. no `BROWSER`). |
| `rate_limited` | Browser Run concurrency or rate limit hit; retry later. |
| `timeout` | Navigation/wait/operation exceeded its budget. |
| `blocked_url` | SSRF guard refused the URL. |
| `invalid_input` | Schema/argument problem (bad session id, unknown page, …). |
| `session_not_found` | Session expired or was never created here. |
| `navigation_error` | The browser could not load the page. |
| `challenge_required` | A human needs to act before continuing. |

Errors include a short `message` and, where useful, a `hint` pointing at the
binding or plan that would enable the feature.

## Resource limits

See `src/core/limits.ts`. Highlights: navigation timeout 45 s (max 120 s),
operation budget 60 s (max 120 s), 10 tabs per session, 10 MB per screenshot,
200 k chars of text, 400 snapshot nodes, 150 interactive elements, 4 frames per
sampling call (max 8), 30 s frame budget.
