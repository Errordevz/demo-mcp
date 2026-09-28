/**
 * Static project content for the DEMO inspector UI — 2.0 premium edition.
 *
 * Facts about this repository (routes, tools, docs, built-in skills,
 * documented behaviour). No mocking: live values (status, versions,
 * availability, Roblox connection) are fetched at runtime from the Worker's
 * own public endpoints. No secrets.
 */

export const MCP_ENDPOINT = "demo-mcp.amidevz.workers.dev/mcp";

export const PROJECT = {
  name: "DEMO",
  tagline: "Execution infrastructure for AI agents.",
  blurb:
    "A public MCP server for browser automation, web intelligence, video understanding, Roblox integrations, skills, and typed decision routing. Public tools work immediately with no login; protected Roblox and paid-decision tools use per-tool OAuth.",
  repoUrl: "https://github.com/Errordevz/demo-mcp",
  repoLabel: "github.com/Errordevz/demo-mcp",
  docsTreeUrl: "https://github.com/Errordevz/demo-mcp/tree/main/docs",
  readmeUrl: "https://github.com/Errordevz/demo-mcp#readme",
};

export const SECTIONS = [
  { id: "overview", label: "Overview", icon: "gauge", blurb: "Live deployment status at a glance", nav: "primary" },
  { id: "capabilities", label: "Capabilities", icon: "layers", blurb: "Capability categories and tool explorer", nav: "primary" },
  { id: "status", label: "Status", icon: "activity", blurb: "Live deployment and capability health", nav: "primary" },
  { id: "tools", label: "Tools", icon: "tools", blurb: "Every MCP tool with live availability", nav: "hidden" },
  { id: "browser", label: "Browser", icon: "globe", blurb: "Persistent sessions, screenshots, human handoff", nav: "primary" },
  { id: "video", label: "Video", icon: "play", blurb: "Resolve, extract, transcribe, analyze with evidence", nav: "primary" },
  { id: "research", label: "Research", icon: "search", blurb: "Web, feeds, archive, PDFs, Git, sources", nav: "primary" },
  { id: "routing", label: "Routing", icon: "branch", blurb: "Jev / Laya typed decision providers", nav: "primary" },
  { id: "roblox", label: "Roblox", icon: "game", blurb: "OAuth connection — one per DEMO identity", nav: "primary" },
  { id: "skills", label: "Skills", icon: "puzzle", blurb: "Built-ins and the live skills.sh surface", nav: "primary" },
  { id: "about", label: "About", icon: "info", blurb: "Open source, architecture, security, privacy", nav: "primary" },
  { id: "account", label: "Account", icon: "user", blurb: "DEMO session, verification, sessions, Roblox link", nav: "hidden" },
  { id: "auth", label: "Sign in", icon: "key", blurb: "DEMO account sign in and registration", nav: "hidden" },
  { id: "reset", label: "Reset password", icon: "key", blurb: "Set a new password from an emailed link", nav: "hidden" },
] as const;

export const CAPABILITY_CATEGORIES = [
  {
    id: "browser",
    title: "Browser",
    icon: "globe",
    route: "browser",
    description: "Real persistent browser on Cloudflare: sessions, screenshots, DOM snapshots, and human handoff for CAPTCHAs.",
    highlights: ["Persistent sessions", "Screenshots", "DOM snapshots", "Human handoff"],
    groups: ["Browser"],
  },
  {
    id: "video",
    title: "Video",
    icon: "play",
    route: "video",
    description: "Resolve public videos, decode real frames in Browser Rendering, transcribe speech, and analyze scenes with explicit evidence.",
    highlights: ["URL resolution", "Frame decoding", "Transcription", "Scene analysis"],
    groups: ["Video", "YouTube"],
  },
  {
    id: "web",
    title: "Web & Research",
    icon: "search",
    route: "research",
    description: "Fetch, extract, diff, and monitor public web content — plus feeds, archives, PDFs, Git, and evidence-backed research.",
    highlights: ["Extraction", "Change monitoring", "Archive & feeds", "Evidence-backed research"],
    groups: ["Core", "Web Intelligence", "Research", "Internet Archive", "Feeds", "Documents", "Git", "Network", "Utilities"],
  },
  {
    id: "roblox",
    title: "Roblox",
    icon: "game",
    route: "roblox",
    description: "Public profiles and games need no login. Account tools use DEMO OAuth per tool, then a separate official Roblox OAuth 2.0 + PKCE consent — never a Roblox password or cookie.",
    highlights: ["Public profiles", "Games", "OAuth account tools"],
    groups: ["Roblox"],
  },
  {
    id: "intelligence",
    title: "Intelligence",
    icon: "cpu",
    route: "routing",
    description: "Typed Jev and Laya decisions, result review, and skills — advisory only, never authoritative, always auditable.",
    highlights: ["Jev decisions", "Laya routing", "Skills"],
    groups: ["JEV", "Laya", "Skills"],
  },
  {
    id: "infrastructure",
    title: "Platform",
    icon: "database",
    route: "status",
    description: "Cloudflare Workers, R2 artifacts, Durable Objects for sessions, and the public Streamable HTTP MCP endpoint.",
    highlights: ["R2 artifacts", "Durable sessions", "Public MCP"],
    groups: [],
  },
] as const;

export const MCP_COMMANDS = [
  { name: "/mcp", description: "Show DEMO status, version, capabilities, tools and commands — run from any MCP client.", source: "src/commands/mcp-command.ts" },
  { name: "/jev", description: "Collaborate with Jev on the current task — typed decisions, confidence bands, fallback rules.", source: "src/commands/jev-command.ts" },
  { name: "/laya", description: "Show Laya decision-provider status (safe fields only), or run a minimal connectivity check.", source: "src/commands/laya-command.ts" },
];

export const BROWSER_FLOW = [
  { tool: "browser_open", text: "Open a URL in a named session: redirects followed, final URL, title, status, challenge verdict and tab info. Everything else reuses the returned session_id." },
  { tool: "browser_read / browser_snapshot", text: "Read the rendered DOM (text, links, forms, media, JSON-LD) or take an accessibility snapshot; interactive elements get [e12]-style refs for stable targeting." },
  { tool: "browser_click / browser_type / browser_scroll / browser_wait", text: "Act on the same page by selector or snapshot ref. Typed secrets use secret: true — never logged, never echoed, only length reported." },
  { tool: "browser_screenshot", text: "Viewport, element or full-page capture. Stored in R2 and returned as a compact expiring link (/screenshots/:id)." },
  { tool: "browser_challenge_status", text: "Login wall, consent, CAPTCHA, access denied or rate limit — classified and reported. Challenges are never bypassed." },
  { tool: "browser_pause_for_human / captcha_handoff", text: "Keep the session alive and hand the human a Live View URL to solve the challenge; the task snapshot is resumable and auditable." },
  { tool: "browser_resume", text: "Continue after the human is done — auto / completed / abandoned — re-checking the page state without claiming bypass." },
  { tool: "browser_session / browser_close", text: "Inspect, refresh or extend the session; close releases the browser immediately and frees the Cloudflare instance." },
];

export const VIDEO_STAGES = [
  { flag: "videoResolution", label: "URL resolution", detail: "Short links followed; canonical URL, id, creator, caption, duration and access status — without downloading anything." },
  { flag: "publicVideo", label: "Public retrieval", detail: "Only public, non-DRM media. access_status names every failure mode (deleted, private, region-restricted, login wall, CAPTCHA, expired, rate-limited) instead of guessing." },
  { flag: "videoBytesRetrieval", label: "Actual video bytes", detail: "Verified MP4/WebM retrieval into expiring R2 artifacts (/video-assets/:ref, Range-aware for seekable playback)." },
  { flag: "videoFrames", label: "Frame decoding", detail: "Bounded real-frame sampling from a rendered <video> element via Browser Rendering — pixels on screen, not posters or thumbnails." },
  { flag: "videoAudioExtraction", label: "Audio extraction", detail: "Best-effort audio capture for publicly served tracks, stored as a temporary artifact with explicit availability." },
  { flag: "videoTranscription", label: "Transcription", detail: "Timestamped speech-to-text when a provider is configured (Workers AI Whisper or a configured HTTPS endpoint)." },
  { flag: "videoVisionAnalysis", label: "Vision analysis", detail: "Frame-grounded scene labels and on-screen text when Workers AI is bound; raw frames always ship to the connected model for direct inspection." },
  { flag: "videoArtifacts", label: "Artifacts", detail: "Video/audio/frames live in R2 with per-object expiry; the hourly cron and an R2 lifecycle rule clean them up." },
];

export const HONESTY_RULES = [
  "Never claim to have seen a video unless actual image blocks or a real transcript were returned and examined.",
  "Frames are samples, not continuous playback. Audio is only claimed when audioStatus is available.",
  "A post caption is not a transcript; a thumbnail is not a frame — they never count as visual evidence.",
  "Any access_status other than public is reported as the reason retrieval failed — content is never described anyway.",
  "A successful download proves retrieval only, never understanding — analysis requires frames or transcript.",
];

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

export const SKILLS_TOOLS = [
  { tool: "skills_search", text: "Search the live skills.sh catalog by query." },
  { tool: "skills_browse", text: "Browse trending and ranked skills." },
  { tool: "skills_get", text: "Fetch full skill instructions for review." },
  { tool: "skills_use", text: "Apply fetched material to the current task — guidance only, no execution." },
  { tool: "skills_audit", text: "Security-review a skill before use." },
  { tool: "skills_curated", text: "The curated starter set from skills.sh." },
  { tool: "skill_install_info", text: "The npx skills add command for an install URL — printed, never executed." },
];

export const API_ROUTES = [
  { path: "/", note: "Public inspector UI — no app login or tracking" },
  { path: "/mcp", note: "MCP endpoint (Streamable HTTP, stateless, public)" },
  { path: "/health", note: "Liveness + full capability flags" },
  { path: "/tools", note: "Tool inventory — count + names + resources" },
  { path: "/platform/stats", note: "Safe telemetry (no secrets, no user content)" },
  { path: "/capabilities/expanded", note: "Git · Archive · Feeds · PDF · Images · Web · Network · Research" },
  { path: "/capabilities/jev", note: "Jev decision engine (presence + policy only)" },
  { path: "/capabilities/laya", note: "Laya decision provider (presence + policy only)" },
  { path: "/capabilities/youtube", note: "YouTube Data API availability" },
  { path: "/capabilities/video", note: "Video pipeline capability report" },
  { path: "/screenshots/:id", note: "R2 screenshot / frame (expiring, high-entropy id)" },
  { path: "/video-assets/:ref", note: "Expiring video/audio artifact (Range supported, 410 when expired)" },
  { path: "/.well-known/oauth-*", note: "DEMO OAuth metadata for ChatGPT's mixed-auth connection" },
  { path: "/oauth/{authorize,token,revoke}", note: "DEMO OAuth 2.1 + PKCE, pinned ChatGPT client and short-lived grants" },
  { path: "/oauth/roblox/*", note: "Separate Roblox OAuth 2.0 + PKCE (one-time link · callback · status · disconnect)" },
];

export const PRIVACY_FACTS = [
  "Public MCP tools and routes work immediately without a DEMO account or login.",
  "Only account-specific Roblox tools and paid jev_decide are protected by per-tool OAuth; a missing token triggers a scoped challenge.",
  "The DEMO OAuth grant is separate from Roblox OAuth. Roblox linking requires a one-time code and explicit approval on Roblox's official consent page.",
  "User identity is verified from a signed Cloudflare Access assertion, then reduced to a server-side subject hash; tool arguments cannot choose an account.",
  "Roblox tokens are encrypted in the RobloxAuth Durable Object and never reach the browser, MCP result, URL, log, or telemetry.",
  "This page sets no cookie and runs no analytics, fingerprinting or IP tracking. OAuth state cookies are short-lived, HttpOnly and Secure.",
  "Every outbound fetch passes the SSRF guard; private/internal targets are refused. CAPTCHAs, login walls and DRM are reported, never bypassed.",
];

export const ARCHITECTURE_TEXT = `ChatGPT / any MCP client
        │  Streamable HTTP; public endpoint with per-tool auth metadata
        ▼
DEMO MCP Worker (Cloudflare Workers)
        ├── /mcp                  public transport; public tools declare noauth
        ├── tools/list            protected tools declare scoped OAuth 2.1 schemes
        ├── /.well-known/*        protected-resource + authorization-server metadata
        ├── /oauth/{authorize,token,revoke} short-lived PKCE grants; codes/tokens stored as hashes
        ├── Cloudflare Access     verified human subject only at interactive authorize/link surfaces
        ├── /oauth/roblox/*       separate Roblox OAuth 2.0 + PKCE consent flow
        ├── MCP_AUTH DO           atomic consent, one-time codes, token hashes, link codes, rate limits
        ├── RobloxAuth DO         per-subject encrypted Roblox token vault (server-side only)
        ├── BrowserSession DO     persistent sessions, tabs, handoff state
        ├── /health · /tools      liveness + inventory (public)
        ├── /platform/stats       safe telemetry (no secrets, no user content)
        ├── /screenshots/:id      R2-backed screenshot / frame (expiring)
        ├── /video-assets/:ref    expiring video/audio artifact (Range-aware)
        ├── Browser Provider      Cloudflare Browser Rendering (Browser Run)
        ├── UrlGuard              SSRF protection on every outbound fetch
        └── DecisionRouter        auto: Laya → Jev → deterministic rules`;

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
  oauth: "Protected tool: requires a user-bound DEMO OAuth token; ChatGPT can authorize it with Mixed Authentication.",
  always: "No optional provider needed — works out of the box.",
};
