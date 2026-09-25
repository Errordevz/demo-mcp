/**
 * Static project content for the DEMO inspector UI.
 *
 * Everything here is a fact about this repository (routes, tools, docs files,
 * built-in skills, documented behaviour). Nothing is mocked: all live values
 * (status, versions, availability, Roblox connection) are fetched at runtime
 * from the Worker's own public endpoints. No secret values appear anywhere.
 */

/** The public MCP endpoint exactly as it must be presented to clients. */
export const MCP_ENDPOINT = "demo-mcp.amidevz.workers.dev/mcp";

export const PROJECT = {
  name: "DEMO",
  tagline: "Execution infrastructure for AI agents.",
  blurb:
    "One MCP server for browser automation, web access, video understanding, Roblox integrations, skills, Jev decision routing, and storage. Open the URL and use it — there is no account to create.",
  repoUrl: "https://github.com/Errordevz/demo-mcp",
  repoLabel: "github.com/Errordevz/demo-mcp",
  docsTreeUrl: "https://github.com/Errordevz/demo-mcp/tree/main/docs",
  readmeUrl: "https://github.com/Errordevz/demo-mcp#readme",
};

/**
 * Navigation sections (all backed by real content in this build).
 *
 * `nav` controls placement: `primary` sections sit in the top header,
 * `secondary` sections are reachable from capability cards, the footer and the
 * command palette, and `hidden` sections stay routable (deep links keep
 * working) without appearing in navigation.
 */
export const SECTIONS = [
  { id: "overview", label: "Overview", icon: "gauge", blurb: "Deployment status at a glance", nav: "primary" },
  { id: "capabilities", label: "Capabilities", icon: "layers", blurb: "Capability categories and the tool explorer", nav: "primary" },
  { id: "status", label: "Status", icon: "activity", blurb: "Live deployment and capability status", nav: "primary" },
  { id: "tools", label: "Tools", icon: "tools", blurb: "Every MCP tool with live availability", nav: "hidden" },
  { id: "browser", label: "Browser", icon: "globe", blurb: "Persistent sessions, screenshots, handoff", nav: "secondary" },
  { id: "video", label: "Video", icon: "play", blurb: "Resolve, extract, transcribe, analyze", nav: "secondary" },
  { id: "research", label: "Research", icon: "search", blurb: "Web, feeds, archive, PDFs, sources", nav: "secondary" },
  { id: "routing", label: "Routing", icon: "branch", blurb: "Jev / Laya decision providers", nav: "secondary" },
  { id: "roblox", label: "Roblox", icon: "game", blurb: "Optional OAuth — not a DEMO login", nav: "secondary" },
  { id: "skills", label: "Skills", icon: "puzzle", blurb: "Built-ins and the skills.sh surface", nav: "secondary" },
  { id: "about", label: "About", icon: "info", blurb: "Open source, architecture, security", nav: "secondary" },
] as const;

/**
 * Capability categories for the overview page.
 *
 * Small, stable grouping over the raw tool groups: each card links to the
 * section that documents the capability in depth, and its live status pill is
 * computed at runtime from /health + /platform/stats (never hardcoded).
 */
export const CAPABILITY_CATEGORIES = [
  {
    id: "browser",
    title: "Browser",
    icon: "globe",
    route: "browser",
    description: "A real persistent browser on Cloudflare: sessions, screenshots, DOM snapshots, and human handoff.",
    highlights: ["Persistent sessions", "Screenshots", "DOM snapshots", "Human handoff"],
    groups: ["Browser"],
  },
  {
    id: "video",
    title: "Video",
    icon: "play",
    route: "video",
    description: "Resolve public videos, decode real frames, transcribe speech, and analyze scenes — with explicit evidence.",
    highlights: ["URL resolution", "Frame decoding", "Transcription", "Scene analysis"],
    groups: ["Video", "YouTube"],
  },
  {
    id: "web",
    title: "Web & Research",
    icon: "search",
    route: "research",
    description: "Fetch, extract, diff, and monitor public web content — plus feeds, archives, PDFs, and Git.",
    highlights: ["Extraction", "Change monitoring", "Archive & feeds", "Evidence-backed research"],
    groups: ["Core", "Web Intelligence", "Research", "Internet Archive", "Feeds", "Documents", "Git", "Network", "Utilities"],
  },
  {
    id: "roblox",
    title: "Roblox",
    icon: "game",
    route: "roblox",
    description: "Public profiles and games out of the box; your own account via official OAuth — never a DEMO login.",
    highlights: ["Public profiles", "Games", "OAuth account tools"],
    groups: ["Roblox"],
  },
  {
    id: "intelligence",
    title: "Intelligence",
    icon: "cpu",
    route: "routing",
    description: "Typed Jev and Laya decisions, result review, and skills — advisory only, never authoritative.",
    highlights: ["Jev decisions", "Laya routing", "Skills"],
    groups: ["JEV", "Laya", "Skills"],
  },
  {
    id: "infrastructure",
    title: "Infrastructure",
    icon: "database",
    route: "status",
    description: "Cloudflare storage, expiring artifacts, durable sessions, and the public MCP endpoint.",
    highlights: ["R2 artifacts", "Durable sessions", "Public MCP"],
    groups: [],
  },
] as const;

/** Commands that genuinely exist in this build (src/commands/*). */
export const MCP_COMMANDS = [
  { name: "/mcp", description: "Show DEMO status, version, capabilities, tools and commands — run from any MCP client.", source: "src/commands/mcp-command.ts" },
  { name: "/jev", description: "Collaborate with Jev on the current task.", source: "src/commands/jev-command.ts" },
  { name: "/laya", description: "Show Laya decision-provider status (safe fields only), or run a minimal connectivity check.", source: "src/commands/laya-command.ts" },
];

/** The persistent-session workflow, stated with the real tool names. */
export const BROWSER_FLOW = [
  { tool: "browser_open", text: "Open a URL in a named session: redirects followed, final URL, title, status, challenge verdict and tab info come back. Everything else reuses the returned session_id." },
  { tool: "browser_read / browser_snapshot", text: "Read the rendered DOM (text, links, forms, media, JSON-LD) or take an accessibility snapshot; interactive elements get [e12]-style refs." },
  { tool: "browser_click / browser_type / browser_scroll / browser_wait", text: "Act on the same page by selector or snapshot ref. Typed secrets use secret: true — never logged, never echoed." },
  { tool: "browser_screenshot", text: "Viewport, element or full-page capture. Stored in R2 and returned as a compact link (/screenshots/:id)." },
  { tool: "browser_challenge_status", text: "Login wall, consent, CAPTCHA, access denied or rate limit — classified and reported. Challenges are never bypassed." },
  { tool: "browser_pause_for_human / captcha_handoff", text: "Keep the session alive and hand the human a Live View URL to solve the challenge; the task snapshot is resumable." },
  { tool: "browser_resume", text: "Continue after the human is done — auto / completed / abandoned — re-checking the page state." },
  { tool: "browser_session / browser_close", text: "Inspect, refresh or extend the session; close releases the browser immediately." },
];

/** Video pipeline stages, each mapped to the real health flag that gates it. */
export const VIDEO_STAGES = [
  { flag: "videoResolution", label: "URL resolution", detail: "Short links followed; canonical URL, id, creator, caption, duration and access status — without downloading anything." },
  { flag: "publicVideo", label: "Public retrieval", detail: "Only public, non-DRM media. access_status names every failure mode (deleted, private, region-restricted, login wall, CAPTCHA, expired, rate-limited) instead of guessing." },
  { flag: "videoBytesRetrieval", label: "Actual video bytes", detail: "Verified MP4/WebM retrieval into expiring R2 artifacts (/video-assets/:ref, Range-aware)." },
  { flag: "videoFrames", label: "Frame decoding", detail: "Bounded real-frame sampling from a rendered <video> element via Browser Rendering — pixels on screen, not posters." },
  { flag: "videoAudioExtraction", label: "Audio extraction", detail: "Best-effort audio capture for publicly served tracks, stored as a temporary artifact." },
  { flag: "videoTranscription", label: "Transcription", detail: "Timestamped speech-to-text when a provider is configured (Workers AI whisper or a configured HTTPS endpoint)." },
  { flag: "videoVisionAnalysis", label: "Vision analysis", detail: "Frame-grounded scene labels and on-screen text when Workers AI is bound; the raw frames always ship to the connected model." },
  { flag: "videoArtifacts", label: "Artifacts", detail: "Video/audio/frames live in R2 with per-object expiry; the hourly cron and an R2 lifecycle rule clean them up." },
];

/** Honesty rules — condensed from the server instructions this Worker ships. */
export const HONESTY_RULES = [
  "Never claim to have seen a video unless actual image blocks or a real transcript were returned and examined.",
  "Frames are samples, not continuous playback. Audio is only claimed when audioStatus is available.",
  "A post caption is not a transcript; a thumbnail is not a frame.",
  "Any access_status other than public is reported as the reason retrieval failed — content is never described anyway.",
  "A successful download proves retrieval only, never understanding.",
];

/** Built-in skills that genuinely ship in this repository (skills/). */
export const BUILTIN_SKILLS = [
  {
    name: "caveman",
    kind: "builtin",
    title: "Caveman response compression",
    description:
      "Compress verbose AI responses while preserving technical substance, code, API names, errors and important details. Levels: lite / full / ultra / wenyan-*; stop on “stop caveman” or “normal mode”.",
    invoke: "skill_builtin_caveman",
    source: "https://skills.sh/juliusbrussee/caveman/caveman",
    sourceLabel: "skills.sh/juliusbrussee/caveman",
    note: "Bundled local copy (skills/caveman/SKILL.md); it never overrides system, developer, safety or user instructions.",
  },
  {
    name: "typesafe-ai",
    kind: "builtin",
    title: "Build with TypeSafe",
    description:
      "Use TypeSafe units of AI intelligence — System One models such as Jev — as programming primitives: typed judgments and probabilities for routing, ranking, extraction and verification.",
    invoke: "skill_builtin_typesafe",
    source: "https://github.com/typesafe-ai/skills",
    sourceLabel: "github.com/typesafe-ai/skills",
    note: "Pinned in skills-lock.json via a content hash; MIT-licensed skill text cached at skills/typesafe-ai/SKILL.md.",
    license: "MIT",
  },
];

/** Skills.sh surface — the real MCP tools, not an invented REST API. */
export const SKILLS_TOOLS = [
  { tool: "skills_search", text: "Search the live skills.sh catalog." },
  { tool: "skills_browse", text: "Browse trending and ranked skills." },
  { tool: "skills_get", text: "Fetch full skill instructions." },
  { tool: "skills_use", text: "Apply fetched material to the current task." },
  { tool: "skills_audit", text: "Security-review a skill before use." },
  { tool: "skills_curated", text: "The curated starter set." },
  { tool: "skill_install_info", text: "The npx skills add command for an install URL — printed, never executed." },
];

/** Documented routes of this Worker (all live-checked by the app where possible). */
export const API_ROUTES = [
  { path: "/", note: "This inspector UI" },
  { path: "/mcp", note: "MCP endpoint (Streamable HTTP, stateless, public)" },
  { path: "/health", note: "Liveness + full capability flags" },
  { path: "/tools", note: "Tool inventory" },
  { path: "/platform/stats", note: "Safe telemetry (no secrets, no user content)" },
  { path: "/capabilities/expanded", note: "Git · Archive · Feeds · PDF · Images · Web · Network · Research" },
  { path: "/capabilities/jev", note: "Jev decision engine (presence + policy only)" },
  { path: "/capabilities/laya", note: "Laya decision provider (presence + policy only)" },
  { path: "/capabilities/youtube", note: "YouTube Data API availability" },
  { path: "/capabilities/video", note: "Video pipeline capability report" },
  { path: "/screenshots/:id", note: "R2 screenshot / frame (expiring)" },
  { path: "/video-assets/:ref", note: "Expiring video/audio artifact (Range supported)" },
  { path: "/oauth/roblox/*", note: "Roblox OAuth 2.0 + PKCE (start · callback · status · logout)" },
];

export const PRIVACY_FACTS = [
  "No account, no sign-in, no onboarding: DEMO's public capabilities work immediately.",
  "No cookies on JSON routes; this page sets no cookie and runs no analytics, fingerprinting or IP tracking.",
  "Telemetry endpoints report presence and policy only — API keys, OAuth tokens and secrets never leave the Worker.",
  "Every outbound fetch (including the Laya endpoint) passes the SSRF guard; private/internal targets are refused.",
  "Tool results are bounded and redacted: tokens, cookies, passwords, e-mails and phone numbers are stripped.",
  "CAPTCHAs, login walls and DRM are reported, never bypassed; humans are handed the Live View instead.",
];

export const ARCHITECTURE_TEXT = `ChatGPT / any MCP client
        │  (Streamable HTTP MCP — public endpoint)
        ▼
DEMO MCP Worker (Cloudflare Workers)
        ├── /mcp                  MCP endpoint (stateless)
        ├── /health · /tools      liveness + inventory
        ├── /platform/stats       safe telemetry (no secrets)
        ├── /capabilities/*       expanded · jev · laya · youtube · video
        ├── /screenshots/:id      R2-backed screenshot / frame
        ├── /video-assets/:ref    expiring video/audio artifact
        ├── /oauth/roblox/*       Roblox OAuth 2.0 + PKCE (optional)
        ├── BrowserSession DO     persistent sessions, tabs, handoff state
        ├── RobloxAuth DO         encrypted token vault (server-side only)
        ├── Browser Provider      Cloudflare Browser Rendering (Browser Run)
        ├── UrlGuard              SSRF protection on every fetch
        └── DecisionRouter        auto: Laya → Jev → deterministic rules`;

/** Which /health·/platform/stats field gates each availability key. */
export const AVAILABILITY_HINTS: Record<string, string> = {
  browser: "Needs the Cloudflare Browser Rendering binding (BROWSER).",
  youtube: "Needs a server-side YouTube Data API v3 credential.",
  jev: "Needs a server-side TypeSafe credential for the Jev engine.",
  laya: "Needs a configured Laya endpoint on this Worker.",
  transcription: "Needs Workers AI or a configured transcription endpoint.",
  vision: "Needs the Workers AI binding for server-side labels.",
  frames: "Needs the Browser Rendering binding to decode frames.",
  artifacts: "Needs R2 storage for expiring artifacts.",
  snapshots: "Needs R2 storage for web snapshots / monitors.",
  bearer: "Private tool: requires the DEMO API bearer credential (configured server-side as a secret).",
  always: "No optional provider needed — works out of the box.",
};
