/**
 * DEMO inspector UI — client application 2.0
 *
 * Zero-dependency, self-contained single-page app, premium overhaul.
 * Inlined into one HTML document (CSP locks to inline script + same-origin
 * fetches, hence String.raw and no framework).
 *
 * Live data from same-origin /health, /platform/stats, /capabilities/*;
 * static facts from generated catalog. No mocking, no secrets, public tools
 * need no login; protected tools use per-tool OAuth.
 *
 * Style constraints:
 *  - embedded via String.raw, so body must not contain backticks or
 *    dollar-brace sequences.
 */
export const APP_SCRIPT = String.raw`(function () {
"use strict";

var BOOT = window.__DEMO_BOOT__ || {};
var CAT = BOOT.catalog || [];
var GROUPS = BOOT.groups || [];
var DATA = BOOT.data || {};
var ENDPOINT = BOOT.endpoint || "";
var SERVER_URL = BOOT.serverUrl || (ENDPOINT ? "https://" + ENDPOINT : "");
var CONNECT = BOOT.connect || { title: "Connect DEMO", subtitle: "Choose where you want to connect DEMO." };
var CLIENTS = BOOT.clients || [];
var VERSION = BOOT.version || "";
var HINTS = DATA.AVAILABILITY_HINTS || {};
var CATS = DATA.CAPABILITY_CATEGORIES || [];

var S = {
  route: "",
  health: null, healthErr: null,
  stats: null, statsErr: null,
  lazy: {}, lazyErr: {}, lazyInflight: {},
  openTool: null,
  tf: { q: "", group: "", avail: "" },
  expandedPlatforms: {},
  core: null,
  modalOpen: false, paletteOpen: false, lastFocus: null, pSel: 0, pQuery: "", pItems: [],
  connectId: "", connectNote: "",
  menuFocusTrap: null
};

var LAZY_ROUTES = {
  video: "/capabilities/video",
  expanded: "/capabilities/expanded",
  collab: "/capabilities/collab",
  byox: "/capabilities/byox",
  collabWorkspaces: "/collab/workspaces"
};

var EXPLORER_FILTERS = [
  { id: "", label: "All" },
  { id: "browser", label: "Browser", groups: ["Browser"] },
  { id: "video", label: "Video", groups: ["Video", "YouTube"] },
  { id: "web", label: "Web", groups: ["Core", "Web Intelligence", "Research", "Internet Archive", "Feeds", "Documents", "Git", "Network", "Utilities", "Roblox"] },
  { id: "skills", label: "Skills", groups: ["Skills"] },
  { id: "intel", label: "Intelligence", groups: ["JEV", "Laya"] },
  { id: "reverse", label: "Reverse Engineering", groups: ["Reverse Engineering"] },
  { id: "storage", label: "Storage", availability: ["artifacts", "snapshots"] }
];

/* utilities */
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>\"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function jfetch(path, opts) {
  opts = opts || {};
  var init = { cache: "no-store", headers: { Accept: "application/json" } };
  if (opts.method) init.method = opts.method;
  if (opts.body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return fetch(path, init).then(function (r) {
    return r.text().then(function (t) {
      var j = null;
      try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
      if (r.ok && !j && /text\/html/i.test(r.headers.get("content-type") || "")) {
        var accessErr = new Error("Cloudflare Access sign-in is required to view this Roblox status.");
        accessErr.status = 401;
        accessErr.payload = { error: "unauthenticated", message: accessErr.message };
        throw accessErr;
      }
      if (!r.ok) {
        var err = new Error((j && (j.message || j.error)) || "Request failed (HTTP " + r.status + ")");
        err.status = r.status;
        err.payload = j;
        throw err;
      }
      return j;
    });
  });
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 24) return Math.floor(h / 24) + "d " + (h % 24) + "h";
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + (sec % 60) + "s";
  return sec + "s";
}
function fmtTs(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

var ICONS = {
  gauge: ["M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z", "M12 12l4.5-3.5"],
  activity: ["M3 12h4l3 8 4-16 3 8h4"],
  tools: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M3 12h18", "M12 3c2.7 2.6 4 5.6 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.6-4-9s1.3-6.4 4-9z"],
  play: ["M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M10.5 9.2l4.3 2.8-4.3 2.8z"],
  search: ["M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z", "M21 21l-4.35-4.35"],
  branch: ["M6 4v16", "M18 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z", "M18 9c0 4-4 5.5-12 5.5"],
  game: ["M6.5 7h11a4.5 4.5 0 0 1 0 9h-1.3a3 3 0 0 1-2.3-1.1l-.5-.6a2.2 2.2 0 0 0-3.4 0l-.5.6A3 3 0 0 1 7.8 16H6.5a4.5 4.5 0 0 1 0-9z", "M7.5 12h2", "M15.5 11.5h.01", "M17 13h.01"],
  puzzle: ["M9 3h6v4.5h4.5v6H15V18H9v-4.5H4.5v-6H9z", "M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"],
  zap: ["M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"],
  info: ["M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z", "M12 11v5", "M12 8h.01"],
  plug: ["M9 7V3", "M15 7V3", "M7 7h10v3a5 5 0 0 1-10 0z", "M12 15v6"],
  chevL: ["M15 6l-6 6 6 6"],
  bubble: ["M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v6A3.5 3.5 0 0 1 15.5 16H12l-3.5 3.5V16H8.5A3.5 3.5 0 0 1 5 12.5z"],
  spark: ["M12 2.8l1.7 5.1 5.3.2-4.2 3.3 1.5 5.1L12 13.8 7.7 16.5l1.5-5.1L5 8.1l5.3-.2z"],
  pointer: ["M5.5 3.5l12 8.5-6.2.8-2.4 5.7z"],
  copy: ["M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  check: ["M20 6L9 17l-5-5"],
  checkc: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M8.5 12.5l2.5 2.5 5-5.5"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  alert: ["M12 3.5L21.5 20h-19z", "M12 10v4", "M12 17h.01"],
  xc: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M14.5 9.5l-5 5", "M9.5 9.5l5 5"],
  slash: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M5.6 5.6l12.8 12.8"],
  clock: ["M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z", "M12 7.5V12l3 2"],
  chev: ["M9 6l6 6-6 6"],
  arrow: ["M4 12h15", "M13 6l6 6-6 6"],
  refresh: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
  external: ["M14 4h6v6", "M20 4l-9.5 9.5", "M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"],
  book: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z", "M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"],
  code: ["M8 6l-6 6 6 6", "M16 6l6 6-6 6"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  shield: ["M12 2l8 3.5V11c0 5-3.2 8.7-8 11-4.8-2.3-8-6-8-11V5.5z", "M9 11.5l2 2 4.5-4.5"],
  key: ["M15.5 7.5a4.5 4.5 0 1 1-4.4 5.6L4 20.2 3 21l.8-1 1-1.8 1.8-.7.7-1.8 1 1 1.4-1.4A4.5 4.5 0 0 1 15.5 7.5z", "M16.8 6.2h.01"],
  film: ["M3 5h18v14H3z", "M7 5v14", "M17 5v14", "M3 9.5h4", "M3 14.5h4", "M17 9.5h4", "M17 14.5h4"],
  database: ["M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3z", "M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6", "M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
  terminal: ["M4 17l6-5-6-5", "M12 19h8"],
  cpu: ["M9 9h6v6H9z", "M5 9h14M5 15h14", "M9 5v14M15 5v14"],
  layers: ["M12 2l9 5-9 5-9-5z", "M3 12l9 5 9-5", "M3 17l9 5 9-5"],
  camera: ["M4.5 8h3.2l1.8-2.5h5l1.8 2.5h3.2V19h-15z", "M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  dot: ["M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"],
  inbox: ["M4 4h16v16H4z", "M4 7l8 6 8-6"],
  star: ["M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"],
  user: ["M19 21v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V21", "M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
  sun: ["M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 1.5v2.2", "M12 20.3v2.2", "M4.2 4.2l1.6 1.6", "M18.2 18.2l1.6 1.6", "M1.5 12h2.2", "M20.3 12h2.2", "M4.2 19.8l1.6-1.6", "M18.2 5.8l1.6-1.6"],
  moon: ["M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"],
  auto: ["M3 5h18v12H3z", "M8 21h8", "M12 17v4"],
  logout: ["M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4", "M10 17l5-5-5-5", "M15 12H3"]
};

function ic(name, size) {
  var paths = ICONS[name] || ICONS.dot;
  var out = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (size) out += ' width="' + size + '" height="' + size + '"';
  out += ">";
  for (var i = 0; i < paths.length; i++) out += '<path d="' + paths[i] + '"/>';
  return out + "</svg>";
}

var ST_ICONS = { ok: "check", warn: "alert", err: "xc", off: "slash", info: "dot", idle: "clock" };
function st(kind, label) {
  return '<span class="st st--' + kind + '">' + ic(ST_ICONS[kind] || "dot") + esc(label) + "</span>";
}
function boolSt(v, okLabel, offLabel) {
  return v ? st("ok", okLabel) : st("off", offLabel || "Unavailable");
}

/* Platform brand marks — inline SVG simplified from each vendor's official
   logo geometry (currentColor except Cursor's solid black/white tile).
   Static markup only — no scripts, no external assets, CSP-safe. */
var PLATFORM_LOGOS = {
  chatgpt: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 8.2774V5.9448a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  claude: '<svg viewBox="0 0 46 32" width="24" height="24" aria-hidden="true"><rect width="46" height="32" rx="4" fill="#D97757"/><path fill="#FFF" d="M8.85 21.5h13.1l-1.4-2.6H9.05l1.7-3.15h4.7l-1.13-2.6H10.6L9.7 10.5H7.05l-6.2 11h11.9zm8.12-11h2.45l5.65 10.05 1.25-2.5 1.25 5.5h2.45l-2.47-11h-6.83v.95l3.45 5.55-3.45-5.55H18zm12 11h2.45l2.7-9.7 2.65 9.7h4.65l-4.55-11h-2.4l-3.5 8.15-2.8-8.15h-2.2zm3.92-13.35l1.65 1.55-1.05 3.1-.6-4.65z"/></svg>',
  cursor: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect width="24" height="24" rx="5" fill="#000"/><path d="M5 4.8L18.9 12 5 19.2V4.8z" fill="#fff"/></svg>',
  vscode: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#007ACC" d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zM18.212 16.25l-7.493-4.25 7.493-4.25v8.5z"/></svg>',
  "claude-code": ""
};
PLATFORM_LOGOS["claude-code"] = PLATFORM_LOGOS.claude;

function platLogo(id, icon) {
  var mark = PLATFORM_LOGOS[id];
  return '<span class="plat-logo" aria-hidden="true">' + (mark || ic(icon || "plug", 22)) + "</span>";
}

/* theme — explicit choice persisted in localStorage; "auto" follows the OS. */
var THEME_KEY = "demo_theme_v1";
function themeMode() {
  try {
    var v = localStorage.getItem(THEME_KEY) || "auto";
    return (v === "light" || v === "dark") ? v : "auto";
  } catch (e) { return "auto"; }
}
function applyStoredTheme() {
  var root = document.documentElement, m = themeMode();
  if (m === "light" || m === "dark") root.setAttribute("data-theme", m);
  else root.removeAttribute("data-theme");
  root.setAttribute("data-theme-mode", m);
  var btn = qs("#theme-btn");
  if (btn) {
    btn.setAttribute("data-theme-state", m);
    btn.setAttribute("aria-label", "Theme: " + (m === "auto" ? "system" : m) + ". Switch theme.");
    btn.setAttribute("title", "Theme: " + (m === "auto" ? "system" : m));
  }
}
function cycleTheme() {
  var order = ["auto", "light", "dark"], cur = themeMode();
  var next = order[(order.indexOf(cur) + 1) % order.length];
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyStoredTheme();
  toast("Theme: " + (next === "auto" ? "system" : next));
}

/* app state helpers */
function body() { return document.body; }
/**
 * Browser/storage capability flags.
 *
 * GET /health answers with the flags at the TOP level (browser, screenshots,
 * videoFrames, ...) - it has no nested capabilities object; GET /platform/stats
 * is the surface that nests them. Reading S.health.capabilities therefore
 * always yielded undefined, and the Browser capability rendered "Unavailable"
 * on a deployment whose own /health and /platform/stats both reported it as
 * available. Read the flat flags first and fall back to the nested shapes so a
 * future response change cannot silently invert a status again.
 */
function caps() {
  var h = S.health || {};
  var nested = h.capabilities || {};
  var stats = (S.stats && S.stats.capabilities) || {};
  function flag(flat, alias) {
    if (typeof h[flat] === "boolean") return h[flat];
    var name = alias || flat;
    if (typeof nested[name] === "boolean") return nested[name];
    if (typeof stats[name] === "boolean") return stats[name];
    return undefined;
  }
  return {
    browserAvailable: flag("browser", "browserAvailable") === true,
    screenshots: flag("screenshots") === true,
    videoFrames: flag("videoFrames") === true,
    liveView: flag("liveView") === true,
    handoff: flag("humanHandoff") === true,
    videoArtifacts: flag("videoArtifacts") === true,
    reason: typeof h.browserReason === "string" ? h.browserReason : null
  };
}
function statCaps() { return (S.stats && S.stats.capabilities) || {}; }
function hv(k) { return S.health ? S.health[k] : undefined; }

function toolAvail(key) {
  if (!S.health && !S.stats) {
    if (key === "always") return { s: "ok", l: "Available" };
    if (key === "oauth") return { s: "warn", l: "Protected · OAuth" };
    return { s: "idle", l: "Checking" };
  }
  var c = caps(), sc = statCaps();
  switch (key) {
    case "browser": return c.browserAvailable ? { s: "ok", l: "Available" } : { s: "off", l: "Unavailable" };
    case "youtube": return sc.youtube && sc.youtube.available ? { s: "ok", l: "Available" } : { s: "off", l: "Needs API key" };
    case "jev": return sc.jevDecisionEngine && sc.jevDecisionEngine.available ? { s: "ok", l: "Available" } : { s: "off", l: "Not configured" };
    case "laya": return sc.layaDecisionProvider && sc.layaDecisionProvider.available ? { s: "ok", l: "Available" } : { s: "off", l: "Not configured" };
    case "transcription": return hv("videoTranscription") ? { s: "ok", l: "Available" } : { s: "off", l: "Needs AI provider" };
    case "vision": return hv("videoVisionAnalysis") ? { s: "ok", l: "Available" } : { s: "warn", l: "Optional provider" };
    case "frames": return hv("videoFrames") ? { s: "ok", l: "Available" } : { s: "off", l: "Needs browser binding" };
    case "artifacts": return hv("videoArtifacts") ? { s: "ok", l: "Available" } : { s: "off", l: "Needs R2" };
    case "snapshots": return sc.expanded && sc.expanded.webMonitor ? { s: "ok", l: "Available" } : { s: "off", l: "Needs R2" };
    case "oauth": return { s: "warn", l: "Protected · OAuth" };
    default: return { s: "ok", l: "Available" };
  }
}

function catStatus(id) {
  var c = caps(), sc = statCaps();
  if (id === "browser") {
    if (!S.health) return S.healthErr ? { s: "err", l: "Unreachable" } : { s: "idle", l: "Checking" };
    return c.browserAvailable ? { s: "ok", l: "Operational" } : { s: "off", l: "Unavailable" };
  }
  if (id === "video") {
    if (!S.health) return S.healthErr ? { s: "err", l: "Unreachable" } : { s: "idle", l: "Checking" };
    if (hv("videoFrames") && hv("videoBytesRetrieval")) return { s: "ok", l: "Operational" };
    if (hv("videoResolution") || hv("videoBytesRetrieval") || hv("publicVideo")) return { s: "warn", l: "Limited" };
    return { s: "off", l: "Unavailable" };
  }
  if (id === "web") {
    if (!S.stats) return S.statsErr ? { s: "err", l: "Unreachable" } : { s: "idle", l: "Checking" };
    return { s: "ok", l: "Operational" };
  }
  if (id === "intelligence") {
    if (!S.stats) return S.statsErr ? { s: "err", l: "Unreachable" } : { s: "idle", l: "Checking" };
    var jev = sc.jevDecisionEngine || {}, laya = sc.layaDecisionProvider || {};
    if (jev.available || laya.available) return { s: "ok", l: "Operational" };
    return { s: "warn", l: "Limited" };
  }
  if (id === "reverse") {
    if (!S.health) return S.healthErr ? { s: "err", l: "Unreachable" } : { s: "idle", l: "Checking" };
    if (hv("reverseEngineering")) return hv("reverseEngineeringAnalyzer") ? { s: "ok", l: "Operational" } : { s: "warn", l: "Static only" };
    return { s: "off", l: "Disabled" };
  }
  if (id === "infrastructure") {
    if (!S.stats) {
      if (S.statsErr && S.healthErr) return { s: "err", l: "Unreachable" };
      if (S.health) return { s: "warn", l: "Partial" };
      return { s: "idle", l: "Checking" };
    }
    return S.stats.status === "online" ? { s: "ok", l: "Operational" } : { s: "warn", l: "Degraded" };
  }
  return { s: "idle", l: "Checking" };
}

function videoPipe() {
  if (!S.health) return S.healthErr ? { s: "err", l: "Unreachable" } : { s: "idle", l: "Checking" };
  if (hv("videoFrames") && hv("videoBytesRetrieval")) return { s: "ok", l: "Operational" };
  if (hv("videoResolution") || hv("videoBytesRetrieval") || hv("publicVideo")) return { s: "warn", l: "Limited" };
  return { s: "off", l: "Unavailable" };
}

function storageState() {
  if (!S.health && !S.stats) {
    if (S.healthErr && S.statsErr) return { s: "err", l: "Unreachable" };
    return { s: "idle", l: "Checking" };
  }
  var c = caps(), sc = statCaps();
  var r2 = c.screenshots || hv("videoArtifacts") || (sc.expanded && sc.expanded.webMonitor);
  return r2 ? { s: "ok", l: "Available" } : { s: "off", l: "Not configured" };
}

function decisionsState() {
  var sc = statCaps();
  if (!S.stats) return S.statsErr ? { s: "err", l: "Unreachable" } : { s: "idle", l: "Checking" };
  var jev = sc.jevDecisionEngine || {}, laya = sc.layaDecisionProvider || {};
  if (jev.available || laya.available) return { s: "ok", l: "Operational" };
  return { s: "warn", l: "Built-in rules" };
}

/* navigation */
function sectionMeta(id) {
  var secs = DATA.SECTIONS || [];
  for (var i = 0; i < secs.length; i++) if (secs[i].id === id) return secs[i];
  return { id: "notfound", label: "Not found", icon: "search", blurb: "" };
}
function primarySections() {
  return (DATA.SECTIONS || []).filter(function (s) { return s.nav === "primary"; });
}
function secondarySections() {
  return (DATA.SECTIONS || []).filter(function (s) { return s.nav === "secondary"; });
}
function routeFromHash() {
  var h = (location.hash || "").replace(/^#\/?/, "").split("?")[0];
  if (!h) return "overview";
  var secs = DATA.SECTIONS || [];
  for (var i = 0; i < secs.length; i++) if (secs[i].id === h) return h;
  return "notfound";
}
function go(route) {
  if (location.hash === "#/" + route) { renderView(); enterRoute(); return; }
  location.hash = "#/" + route;
}

/* rendering */
function externalLinks() {
  var proj = DATA.PROJECT || {};
  var out = "";
  if (proj.docsTreeUrl) out += '<a href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("book") + "<span>Docs</span></a>";
  if (proj.repoUrl) out += '<a href="' + esc(proj.repoUrl) + '" target="_blank" rel="noreferrer noopener" aria-label="Source repository on GitHub">' + ic("code") + "<span>Source</span></a>";
  return out;
}

function renderShell() {
  var app = qs("#app");
  if (!app) return;
  var prim = primarySections(), sec = secondarySections();
  var nav = "";
  for (var i = 0; i < prim.length; i++) {
    nav += '<a href="#/' + prim[i].id + '" data-route="' + prim[i].id + '"' + (S.route === prim[i].id ? ' aria-current="page"' : "") + ">" +
      ic(prim[i].icon) + "<span>" + esc(prim[i].label) + "</span></a>";
  }
  nav += externalLinks();
  var menuSec = "";
  for (var k = 0; k < sec.length; k++) {
    menuSec += '<a class="mi" href="#/' + sec[k].id + '" data-route="' + sec[k].id + '"' + (S.route === sec[k].id ? ' aria-current="page"' : "") + ">" +
      ic(sec[k].icon) + "<span>" + esc(sec[k].label) + "</span></a>";
  }
  var menuPrim = "";
  for (var m = 0; m < prim.length; m++) {
    menuPrim += '<a class="mi" href="#/' + prim[m].id + '" data-route="' + prim[m].id + '"' + (S.route === prim[m].id ? ' aria-current="page"' : "") + ">" +
      ic(prim[m].icon) + "<span>" + esc(prim[m].label) + "</span></a>";
  }
  var proj = DATA.PROJECT || {};
  app.innerHTML =
    '<a class="skip" href="#main">Skip to content</a>' +
    '<div class="layout">' +
      '<header class="header">' +
        '<div class="header-in">' +
          '<a class="brand" href="#/overview" aria-label="DEMO home">' +
            '<span class="brand-mark" aria-hidden="true">D</span>' +
            '<span><span class="brand-name">' + esc(proj.name || "DEMO") + "</span> " +
            '<span class="brand-ver" id="brand-ver">' + esc(VERSION ? "v" + VERSION : "") + "</span></span>" +
          "</a>" +
          '<nav class="nav" aria-label="Primary">' + nav + "</nav>" +
          '<span class="grow"></span>' +
          '<div class="header-actions">' +
            '<button class="btn btn--smhide" type="button" data-act="palette-open" aria-label="Search (Ctrl+K)">' + ic("search") + '<span class="lbl">Search</span></button>' +
            '<button class="btn theme-btn" id="theme-btn" type="button" data-act="theme-toggle" data-theme-state="auto" aria-label="Theme: system. Switch theme." title="Theme: system">' +
              '<span class="th-ico th-sun">' + ic("sun") + '</span><span class="th-ico th-moon">' + ic("moon") + '</span><span class="th-ico th-auto">' + ic("auto") + "</span></button>" +
            '<button class="btn btn--primary" type="button" data-act="connect-open">' + ic("plug") + "<span>Connect MCP</span></button>" +
            '<button class="menu-btn" type="button" data-act="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="menu">' + ic("menu") + "</button>" +
          "</div>" +
        "</div>" +
        '<nav class="menu" id="menu" aria-label="Menu">' +
          '<div class="menu-in">' + menuPrim +
            (menuSec ? '<div class="mi-sec">Explore</div>' + menuSec : "") +
            '<div class="mi-sec">Resources</div>' +
            (proj.docsTreeUrl ? '<a class="mi" href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("book") + "<span>Docs</span></a>" : "") +
            (proj.repoUrl ? '<a class="mi" href="' + esc(proj.repoUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("code") + "<span>Source on GitHub</span></a>" : "") +
            '<div class="mi-cta"><button class="btn btn--primary" type="button" data-act="connect-open">' + ic("plug") + "<span>Connect MCP</span></button></div>" +
          "</div>" +
        "</nav>" +
      "</header>" +
      '<main id="main" class="content" tabindex="-1"><div id="view"></div></main>' +
      '<footer class="foot"><div class="foot-in" id="foot"></div></footer>' +
    "</div>" +
    '<div class="overlay" id="connect-overlay" hidden><div class="modal connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" aria-describedby="connect-sub"><div id="connect-root">' + connectHtml() + "</div></div></div>" +
    '<div class="overlay" id="palette-overlay" hidden><div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">' + paletteBody() + "</div></div>" +
    '<div class="toasts" id="toasts" role="status" aria-live="polite"></div>';
}

function renderHeaderState() {
  qsa("[data-route]").forEach(function (a) {
    if (a.getAttribute("data-route") === S.route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  var ver = qs("#brand-ver");
  var live = (S.stats && S.stats.version) || VERSION;
  if (ver) ver.textContent = live ? "v" + live : "";
}

function renderView() {
  var meta = sectionMeta(S.route);
  renderHeaderState();
  var views = {
    overview: overviewView, capabilities: capabilitiesView, tools: toolsView, status: statusView,
    browser: browserView, video: videoView, research: researchView, routing: routingView,
    skills: skillsView, about: aboutView, collab: collabView, notfound: notfoundView
  };
  var fn = views[S.route] || notfoundView;
  var view = qs("#view");
  if (view) view.innerHTML = fn();
  renderFoot();
  document.title = (meta.label ? meta.label + " · " : "") + "DEMO";
}

function renderFoot() {
  var f = qs("#foot");
  if (!f) return;
  var proj = DATA.PROJECT || {};
  var bits = [];
  if (S.stats) {
    bits.push('<span class="mono">v' + esc(S.stats.version || VERSION || "—") + "</span>");
    bits.push('<span class="mono">' + S.stats.toolCount + ' tools</span>');
    if (S.stats.generatedAt) bits.push("<span>telemetry " + esc(fmtTs(S.stats.generatedAt)) + "</span>");
    if (typeof S.stats.uptimeSeconds === "number") bits.push("<span>isolate age " + esc(fmtDur(S.stats.uptimeSeconds)) + "</span>");
  } else {
    bits.push('<span class="mono">' + CAT.length + ' tools</span>');
  }
  bits.push("<span>public tools · no login · no tracking</span>");
  var links = '<span class="foot-links">' +
    '<a href="#/capabilities">Capabilities</a><a href="#/status">Status</a>' +
    (proj.docsTreeUrl ? '<a href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">Docs</a>' : "") +
    (proj.repoUrl ? '<a href="' + esc(proj.repoUrl) + '" target="_blank" rel="noreferrer noopener">Source</a>' : "") +
    "</span>";
  f.innerHTML = bits.join('<span aria-hidden="true">·</span>') + links;
}

/* shared */
function panel(title, icon, bodyHtml, opts) {
  opts = opts || {};
  var head = '<div class="panel-hd">' + (icon ? '<span class="hd-ic">' + ic(icon) + "</span>" : "") + "<h3>" + esc(title) + "</h3>" +
    (opts.right ? '<div class="hd-note">' + opts.right + "</div>" : "") + "</div>";
  var bd = bodyHtml == null ? "" : (opts.flush ? '<div class="panel-bd--flush">' + bodyHtml + "</div>" : '<div class="panel-bd">' + bodyHtml + "</div>");
  return '<section class="panel' + (opts.cls ? " " + opts.cls : "") + '" aria-label="' + esc(title) + '">' + head + bd + "</section>";
}

function kv(label, valueHtml, detailHtml) {
  return '<div class="kv"><span class="k">' + esc(label) + '</span><span class="v">' + (valueHtml == null ? "" : valueHtml) +
    (detailHtml ? '<span class="d">' + detailHtml + "</span>" : "") + "</span></div>";
}

function statusCard(title, icon, rows, opts) {
  return panel(title, icon, rows.join(""), Object.assign({ flush: true }, opts || {}));
}

function skeletonPanel(lines) {
  var s = '<div class="panel-bd">';
  for (var i = 0; i < (lines || 3); i++) s += '<div class="skel" style="width:' + (100 - i * 12) + '%"></div>';
  return s + "</div>";
}

function errPanel(title, path, key, msg) {
  return panel(title || "Telemetry unavailable", "alert",
    '<p class="note">' + esc(msg || "Could not read this deployment status.") + "</p>" +
    '<p class="hint mono" style="margin-top:8px">GET ' + esc(path || "/platform/stats") + "</p>" +
    '<div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="retry" data-key="' + esc(key || "") + '">' + ic("refresh") + "Try again</button>" +
    '<a class="btn" href="' + esc(path || "/platform/stats") + '" target="_blank" rel="noreferrer noopener">Raw response</a></div>',
    { cls: "err-card" });
}

function emptyState(icon, title, text, actionHtml) {
  return '<div class="empty-state">' + ic(icon || "search", 32) +
    "<h4>" + esc(title || "Nothing here") + "</h4>" +
    (text ? "<p>" + esc(text) + "</p>" : "") +
    (actionHtml || "") + "</div>";
}

function techDetails(summary, obj) {
  var json = "";
  try { json = JSON.stringify(obj, null, 2) || ""; } catch (e) { json = String(obj); }
  if (json.length > 20000) json = json.slice(0, 20000) + "\n… (truncated)";
  return '<details class="tech"><summary>' + ic("chev", 14) + esc(summary || "Technical details") + "</summary>" +
    '<div class="tech-bd"><pre class="codeblock">' + esc(json) + "</pre></div></details>";
}

function pageHead(eyebrow, title, blurb) {
  return '<div class="page-head"><div class="eyebrow">' + esc(eyebrow) + "</div><h1>" + esc(title) + "</h1>" +
    (blurb ? "<p>" + esc(blurb) + "</p>" : "") + "</div>";
}

function note(html) { return '<p class="note">' + html + "</p>"; }

/* overview */
function heroBlock() {
  var proj = DATA.PROJECT || {};
  var dot = "live-dot--idle live-dot--pulse", t = "Checking status", sub = "Reading live deployment telemetry";
  var icon = "clock";
  if (S.stats) {
    if (S.stats.status === "online") { dot = ""; t = "Operational"; sub = "MCP endpoint available"; icon = "checkc"; }
    else { dot = "live-dot--warn"; t = "Degraded"; sub = "Deployment answered with an unexpected status"; icon = "alert"; }
  } else if (S.statsErr && S.healthErr) {
    dot = "live-dot--err"; t = "Status unavailable"; sub = "Could not reach deployment telemetry"; icon = "xc";
  } else if (S.statsErr || S.healthErr) {
    dot = "live-dot--warn"; t = "Partial telemetry"; sub = "Some deployment signals did not answer"; icon = "alert";
  }
  return '<div class="hero">' +
    '<div class="eyebrow"><span>' + esc(proj.name || "DEMO") + ' — v' + esc((S.stats && S.stats.version) || VERSION || "1.1.0") + "</span></div>" +
    "<h1>Execution infrastructure for AI agents.</h1>" +
    '<p class="lede">' + esc(proj.blurb || "") + "</p>" +
    '<div class="hero-cta">' +
      '<button class="btn btn--primary btn--lg" type="button" data-act="connect-open">' + ic("plug") + "Connect MCP</button>" +
      '<a class="btn btn--lg" href="#/capabilities">Explore capabilities</a>' +
      '<button class="btn btn--lg" type="button" data-act="palette-open" aria-label="Command palette">' + ic("search") + "Search tools</button>" +
    "</div>" +
    '<div class="hero-status"><span class="live-dot ' + dot + '" aria-hidden="true"></span>' +
      '<span style="display:inline-flex;align-items:center;gap:6px">' + ic(icon, 14) + "<b>" + esc(t) + "</b> · " + esc(sub) + "</span>" +
      ((S.statsErr && S.healthErr) ? '<button class="link-btn" type="button" data-act="refresh" style="margin-left:6px">Retry</button>' : "") +
    "</div>" +
  "</div>";
}

function catCard(cat) {
  var cs = catStatus(cat.id);
  var n = 0;
  for (var i = 0; i < CAT.length; i++) if (cat.groups && cat.groups.indexOf(CAT[i].group) !== -1) n++;
  var count = cat.groups && cat.groups.length ? n + (n === 1 ? " tool" : " tools") : "live status";
  var tags = "";
  for (var t = 0; t < (cat.highlights || []).length; t++) tags += '<span class="cat-tag">' + esc(cat.highlights[t]) + "</span>";
  return '<a class="cat" href="#/' + esc(cat.route || "capabilities") + '" title="' + esc(cat.title + " — " + (cat.description || "")) + '">' +
    '<div class="cat-top"><span class="cat-ic">' + ic(cat.icon) + "</span><h3>" + esc(cat.title) + "</h3>" + st(cs.s, cs.l) + "</div>" +
    "<p>" + esc(cat.description || "") + "</p>" +
    '<div class="cat-tags">' + tags + "</div>" +
    '<div class="cat-foot"><span>' + esc(count) + '</span><span style="margin-left:auto" class="link-arrow">Open ' + ic("arrow") + "</span></div>" +
  "</a>";
}

function overviewStatusRows() {
  var c = caps(), sc = statCaps();
  var live = !!S.health;
  var vp = videoPipe(), stor = storageState(), dec = decisionsState();
  var laya = sc.layaDecisionProvider || {}, jev = sc.jevDecisionEngine || {};
  return [
    kv("DEMO version", (live || S.stats) ? '<code class="chip-v">v' + esc((S.stats && S.stats.version) || VERSION || "—") + "</code>" : st("idle", "Loading")),
    kv("MCP endpoint", S.stats ? (S.stats.status === "online" ? st("ok", "Operational") : st("warn", "Degraded")) : (S.statsErr ? st("err", "Unreachable") : st("idle", "Checking")), "<code class=\"chip-v\">/mcp</code>"),
    kv("Browser", live ? boolSt(c.browserAvailable, "Operational") : (S.healthErr ? st("err", "Unreachable") : st("idle", "Checking")), c.reason ? '<span class="hint">' + esc(c.reason) + "</span>" : ""),
    kv("Video pipeline", st(vp.s, vp.l)),
    kv("Decisions", st(dec.s, dec.l), (jev.available || laya.available) ? '<span class="hint mono">' + esc(hv("decisionRoutingMode") || laya.routingMode || "auto") + "</span>" : '<span class="hint">built-in rules decide until a provider is configured</span>'),
    kv("Storage", st(stor.s, stor.l), '<span class="hint">R2 artifacts · expiring</span>'),
    kv("Skills", S.stats || S.health ? st("ok", "Available") : (S.statsErr && S.healthErr ? st("err", "Unreachable") : st("idle", "Checking")), '<span class="hint">built-ins + skills.sh · no key required</span>')
  ];
}

function accessPanel() {
  var proj = DATA.PROJECT || {};
  return panel("Access model", "shield",
    '<div class="row" style="margin-bottom:12px"><span class="badge-secure">' + ic("shield") + "Public tools · no login</span></div>" +
    note("Connect DEMO directly to your MCP-compatible client. The browser, video, research, reverse engineering and utility tools work immediately with no account or login.") +
    '<div class="row" style="margin-top:14px">' +
      '<button class="btn btn--primary" type="button" data-act="connect-open">' + ic("plug") + "Connect MCP</button>" +
      (proj.docsTreeUrl ? '<a class="btn" href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("book") + "Docs</a>" : "") +
    "</div>");
}

function overviewView() {
  if (S.statsErr && S.healthErr) {
    return heroBlock() + '<div style="height:16px"></div>' + errPanel("Backend unreachable — telemetry unavailable", "/platform/stats", "core",
      "The Worker did not answer. Try again or inspect deployment status.") +
      '<div style="height:16px"></div>' + techDetails("Technical details", {
        healthError: S.healthErr ? String(S.healthErr.message || S.healthErr) : null,
        statsError: S.statsErr ? String(S.statsErr.message || S.statsErr) : null
      });
  }
  var cards = "";
  for (var i = 0; i < CATS.length; i++) cards += catCard(CATS[i]);
  return (
    heroBlock() +
    '<div class="sec-head"><h2>Capabilities</h2><p>Six surfaces, one endpoint. Every status below is live.</p><a class="link-arrow" href="#/capabilities">Explore all tools ' + ic("arrow") + "</a></div>" +
    '<div class="cat-grid">' + cards + "</div>" +
    '<div class="sec-head"><h2>Status</h2><p>Live deployment state.</p><a class="link-arrow" href="#/status">Full status ' + ic("arrow") + "</a></div>" +
    '<div class="grid grid--2">' +
      statusCard("Deployment", "gauge", overviewStatusRows(), { right: '<a class="link-arrow" href="#/status">Details ' + ic("arrow") + "</a>" }) +
      accessPanel() +
    "</div>"
  );
}

/* capability explorer */
function filterDef(id) {
  for (var i = 0; i < EXPLORER_FILTERS.length; i++) if (EXPLORER_FILTERS[i].id === id) return EXPLORER_FILTERS[i];
  return EXPLORER_FILTERS[0];
}
function toolInFilter(t, fid) {
  if (!fid) return true;
  var def = filterDef(fid);
  if (def.availability) return def.availability.indexOf(t.availability) !== -1;
  if (def.groups) return def.groups.indexOf(t.group) !== -1;
  return true;
}
function filterCount(fid) {
  var n = 0;
  for (var i = 0; i < CAT.length; i++) if (toolInFilter(CAT[i], fid)) n++;
  return n;
}

function filteredTools() {
  var q = S.tf.q.toLowerCase();
  var out = [];
  for (var i = 0; i < CAT.length; i++) {
    var t = CAT[i];
    if (!toolInFilter(t, S.tf.group)) continue;
    if (S.tf.avail) {
      var a = toolAvail(t.availability).s;
      if (S.tf.avail === "ok" && a !== "ok") continue;
      if (S.tf.avail === "off" && a !== "off" && a !== "idle") continue;
      if (S.tf.avail === "warn" && t.availability !== "oauth") continue;
    }
    if (q) {
      var hay = (t.name + " " + t.title + " " + (t.description || "") + " " + t.group).toLowerCase();
      if (hay.indexOf(q) === -1) continue;
    }
    out.push(t);
  }
  return out;
}

function toolRow(t) {
  var a = toolAvail(t.availability);
  var open = S.openTool === t.name;
  return '<button class="trow" type="button" data-act="open-tool" data-name="' + esc(t.name) + '" aria-expanded="' + (open ? "true" : "false") + '" title="' + esc(t.name + " — " + (t.description || t.title)) + '">' +
    '<span class="tname"><span class="tstat tstat--' + a.s + '" title="' + esc(a.l) + '"><span class="vh">' + esc(a.l) + "</span></span>" + esc(t.name) + "</span>" +
    '<span class="tdesc">' + esc(t.description || t.title) + "</span>" +
    '<span class="tgrp">' + esc(t.group) + "</span>" +
    '<span class="tw">' + ic("chev", 16) + "</span>" +
    "</button>";
}

function toolDetail(t) {
  var a = toolAvail(t.availability);
  var hint = HINTS[t.availability] || "";
  var inputs = t.inputs || [];
  var shown = inputs.slice(0, 2).map(function (n) { return '"' + n + '": "…"'; }).join(", ");
  var example = '{"name": "' + t.name + '", "arguments": {' + shown + "}}";
  return '<div class="tdetail">' +
    '<div class="row" style="gap:8px;margin-bottom:10px">' + st(a.s, a.l) + (hint ? '<span class="hint">' + esc(hint) + "</span>" : "") + "</div>" +
    '<p class="tdesc-full">' + esc(t.title) + (t.description ? " — " + esc(t.description) : " — description is available via tools/list over /mcp.") + "</p>" +
    (inputs.length ? "<h4>Inputs</h4>" + '<div class="pill-row">' + inputs.map(function (n) {
      return '<span class="in-chip">' + esc(n) + "</span>";
    }).join("") + "</div>" : "") +
    "<h4>Example usage</h4>" + '<pre class="codeblock">POST /mcp · tools/call\n' + esc(example) + "</pre>" +
    '<p class="hint" style="margin-top:10px">Results come back as MCP content blocks. The full JSON Schema for every field comes from tools/list on /mcp — nothing here is mocked.</p>' +
    '<div class="tfoot"><button class="btn btn--sm" type="button" data-act="copy" data-copy="' + esc(t.name) + '">' + ic("copy", 13) + "Copy name</button>" +
    '<button class="btn btn--sm" type="button" data-act="copy" data-copy="' + esc(SERVER_URL) + '">' + ic("copy", 13) + "Copy endpoint</button>" +
    '<span class="hint">Invoke it from any connected MCP client.</span></div>' +
    "</div>";
}

function toolsRowsHtml() {
  var list = filteredTools();
  var rows = "";
  for (var r = 0; r < list.length; r++) {
    rows += toolRow(list[r]);
    if (S.openTool === list[r].name) rows += toolDetail(list[r]);
  }
  if (!list.length) {
    rows = emptyState("search", "No matching tools", "Try a different search or clear the filters to see all " + CAT.length + " tools.", '<button class="btn btn--sm" type="button" data-act="clear-filters" style="margin-top:8px">' + ic("x", 13) + 'Clear filters</button>');
  }
  return rows;
}

function explorerPanel() {
  var list = filteredTools();
  var chips = "";
  for (var i = 0; i < EXPLORER_FILTERS.length; i++) {
    var f = EXPLORER_FILTERS[i];
    chips += '<button class="chip" type="button" data-act="filter-group" data-g="' + esc(f.id) + '" aria-pressed="' + (S.tf.group === f.id ? "true" : "false") + '">' + esc(f.label) + '<span class="cnt">' + filterCount(f.id) + "</span></button>";
  }
  var availChips = [["", "Any state"], ["ok", "Available"], ["off", "Needs setup"], ["warn", "Protected"]].map(function (o) {
    return '<button class="chip" type="button" data-act="filter-avail" data-a="' + o[0] + '" aria-pressed="' + (S.tf.avail === o[0] ? "true" : "false") + '">' + o[1] + "</button>";
  }).join("");

  var activeFilters = S.tf.group || S.tf.avail || S.tf.q;
  var clearBtn = activeFilters ? '<button class="btn btn--sm" type="button" data-act="clear-filters">' + ic("x", 12) + "Clear</button>" : "";

  var head = '<div class="panel-bd" style="border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:12px;align-items:center">' +
    '<div class="search">' + ic("search") + '<input id="tool-search" type="search" placeholder="Search ' + CAT.length + ' tools by name, description or group…" aria-label="Search tools" value="' + esc(S.tf.q) + '"></div>' +
    '<span class="tcount" id="tool-count">' + list.length + " shown · " + (S.stats ? S.stats.toolCount + " live on /mcp" : CAT.length + " in catalog") + "</span>" + clearBtn + "</div>" +
    '<div style="padding:12px 18px;border-bottom:1px solid var(--border)"><div class="chips" role="group" aria-label="Filter by capability">' + chips + "</div></div>" +
    '<div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="eyebrow" style="margin-right:6px">State</span><div class="chips" role="group" aria-label="Filter by availability">' + availChips + "</div></div>";

  return panel("Tool explorer", "tools", head + '<div class="panel-bd--flush" id="tool-rows">' + toolsRowsHtml() + "</div>", {
    flush: true,
    right: S.health || S.stats ? '<span class="hint mono">' + list.length + "/" + CAT.length + "</span>" : '<span class="hint">resolving live state…</span>'
  });
}

function capabilitiesView() {
  var showCats = !S.tf.q && !S.tf.group && !S.tf.avail;
  var cats = "";
  if (showCats) {
    var cards = "";
    for (var i = 0; i < CATS.length; i++) cards += catCard(CATS[i]);
    cats = '<div class="cat-grid" style="margin-bottom:20px">' + cards + "</div>";
  }
  var rePanel = "";
  if (showCats) {
    var reTools = CAT.filter(function (t) { return t.group === "Reverse Engineering"; });
    var reRules = '<ul class="list">' + (DATA.REVERSE_ENGINEERING_RULES || []).map(function (r) {
      return '<li><span class="li-k">' + esc(r) + "</span></li>";
    }).join("") + "</ul>";
    rePanel = '<div class="grid grid--2" style="margin-bottom:20px">' +
      panel("Reverse Engineering — evidence contract", "info", reRules, { right: '<span class="hint">evidence rules</span>' }) +
      panel("Reverse Engineering tools — " + reTools.length, "cpu", '<div class="panel-bd--flush">' +
        (reTools.length ? reTools.map(function (t) { return toolRow(t); }).join("") : emptyState("cpu", "No reverse-engineering tools", "This deployment has no reverse-engineering tools registered.")) +
        "</div>", { flush: true }) +
      "</div>";
  }
  return pageHead("Capabilities", "Capability explorer", "Every MCP tool DEMO exposes, with live availability. Select a tool for its inputs and usage.") +
    '<div style="height:20px"></div>' + cats + rePanel + explorerPanel();
}

function toolsView() {
  return pageHead("Capabilities", "Tools", "Every MCP tool DEMO exposes, with live availability.") +
    '<div style="height:20px"></div>' + explorerPanel();
}

/* status */
function deploymentRows() {
  var c = caps();
  var live = !!S.health;
  return [
    kv("DEMO version", (live || S.stats) ? '<code class="chip-v">v' + esc((S.stats && S.stats.version) || VERSION || "—") + "</code>" : st("idle", "Loading")),
    kv("MCP endpoint", S.stats ? (S.stats.status === "online" ? st("ok", "Operational") : st("warn", "Degraded")) : (S.statsErr ? st("err", "Unreachable") : st("idle", "Checking")), "<code class=\"chip-v\">/mcp</code>"),
    kv("Tools live", S.stats ? st("info", String(S.stats.toolCount)) : st("idle", "Checking"), 'inventory at <code class="chip-v">/tools</code>'),
    kv("Telemetry", S.stats && S.stats.generatedAt ? '<span class="hint mono">' + esc(fmtTs(S.stats.generatedAt)) + "</span>" : "—"),
    kv("Isolate age", S.stats && typeof S.stats.uptimeSeconds === "number" ? '<span class="hint">' + esc(fmtDur(S.stats.uptimeSeconds)) + " · " + S.stats.requestCountSinceIsolateStart + " req (this isolate)</span>" : "—")
  ];
}

function capabilityRows() {
  var c = caps(), sc = statCaps();
  var live = !!S.health;
  var vp = videoPipe(), stor = storageState();
  var jev = sc.jevDecisionEngine || {}, laya = sc.layaDecisionProvider || {};
  return [
    kv("Browser", live ? boolSt(c.browserAvailable, "Operational") : (S.healthErr ? st("err", "Unreachable") : st("idle", "Checking")), c.reason && !c.browserAvailable ? '<span class="hint">' + esc(c.reason) + "</span>" : ""),
    kv("Browser sessions", live ? (c.sessionStorage === "durable-object" ? st("ok", "Durable Object") : st("warn", "In-memory")) : st("idle", "…"), c.provider ? '<span class="hint mono">' + esc(c.provider) + "</span>" : ""),
    kv("Screenshots", live ? boolSt(c.screenshots, "Available") : st("idle", "…"), c.screenshotReason ? '<span class="hint">' + esc(c.screenshotReason) + "</span>" : ""),
    kv("Live view", live ? boolSt(c.liveView, "Available") : st("idle", "…")),
    kv("Human handoff", live ? boolSt(c.handoff, "Available") : st("idle", "…")),
    kv("Accessibility snapshots", live ? boolSt(c.accessibilitySnapshot, "Available") : st("idle", "…")),
    kv("Video pipeline", st(vp.s, vp.l)),
    kv("Video artifacts", hv("videoArtifacts") != null ? boolSt(hv("videoArtifacts"), "Available") : (S.healthErr ? st("err", "Unreachable") : st("idle", "…"))),
    kv("Transcription", hv("videoTranscription") != null ? (hv("videoTranscription") ? st("ok", "Configured") : st("off", "No provider")) : st("idle", "…"), hv("transcriptionProvider") ? '<span class="hint mono">' + esc(hv("transcriptionProvider")) + "</span>" : ""),
    kv("Vision analysis", hv("videoVisionAnalysis") != null ? (hv("videoVisionAnalysis") ? st("ok", "Configured") : st("warn", "Optional")) : st("idle", "…"), hv("visionProvider") ? '<span class="hint mono">' + esc(hv("visionProvider")) + "</span>" : ""),
    kv("Storage (R2)", st(stor.s, stor.l), '<span class="hint">screenshots · video artifacts · snapshots</span>'),
    kv("Skills", (S.stats || S.health) ? st("ok", "Available") : st("idle", "…"), '<span class="hint">built-ins + skills.sh · no key required</span>'),
    kv("YouTube", sc.youtube ? (sc.youtube.available ? st("ok", "Configured") : st("off", "No API key")) : (S.statsErr ? st("err", "Unreachable") : st("idle", "…"))),
    kv("Jev engine", S.stats ? (jev.available ? st("ok", "Operational") : st("off", "Not configured")) : st("idle", "…"), jev.model ? '<span class="hint mono">' + esc(jev.model) + "</span>" : ""),
    kv("Laya provider", S.stats ? (laya.available ? st("ok", "Operational") : st("off", "Not configured")) : st("idle", "…"), laya.endpointHost ? '<span class="hint mono">' + esc(laya.endpointHost) + "</span>" : ""),
    kv("Reverse engineering", live ? (hv("reverseEngineering") ? (hv("reverseEngineeringAnalyzer") ? st("ok", "Static + service") : st("warn", "Static only")) : st("off", "Disabled")) : st("idle", "…"),
      hv("reverseEngineeringDynamic") ? '<span class="hint">dynamic analysis enabled</span>' : '<span class="hint">static analysis only</span>')
  ];
}

function statusView() {
  if (S.statsErr && S.healthErr) {
    return pageHead("Status", "System status", "Live deployment state, read from this Worker's own telemetry.") +
      '<div style="height:16px"></div>' + errPanel("Backend unreachable — telemetry unavailable", "/platform/stats", "core",
        "The Worker did not answer. Try again or inspect deployment status.") +
      '<div style="height:16px"></div>' + techDetails("Technical details", {
        healthError: S.healthErr ? String(S.healthErr.message || S.healthErr) : null,
        statsError: S.statsErr ? String(S.statsErr.message || S.statsErr) : null
      });
  }
  var conns = "";
  if (S.stats && S.stats.connections) {
    conns = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Connection</th><th>Type</th><th class="t-r">State</th></tr></thead><tbody>';
    for (var i = 0; i < S.stats.connections.length; i++) {
      var cn = S.stats.connections[i];
      conns += "<tr><td>" + esc(cn.name) + "</td><td class=\"muted\">" + esc(cn.type) + "</td><td class=\"t-r\">" + (cn.connected ? st("ok", "Connected") : st("off", "Disconnected")) + "</td></tr>";
    }
    conns += "</tbody></table></div>";
  } else {
    conns = skeletonPanel(6);
  }
  var epHtml = "";
  if (S.stats && S.stats.endpoints) {
    var keys = Object.keys(S.stats.endpoints);
    for (var j = 0; j < keys.length; j++) {
      epHtml += kv(keys[j], '<code class="chip-v">' + esc(S.stats.endpoints[keys[j]]) + "</code>");
    }
  } else {
    epHtml = skeletonPanel(4);
  }
  var lastRefresh = S.stats && S.stats.generatedAt ? '<span class="hint mono">Last refresh ' + esc(fmtTs(S.stats.generatedAt)) + '</span>' : "";
  return (
    pageHead("Status", "System status", "Live deployment state — every value below is read from this Worker's own telemetry, never hardcoded.") +
    '<div style="height:20px"></div>' +
    '<div class="grid grid--2">' +
      statusCard("Deployment", "gauge", deploymentRows(), { right: lastRefresh }) +
      statusCard("Capabilities", "cpu", capabilityRows(), { right: '<button class="btn btn--sm" type="button" data-act="refresh">' + ic("refresh", 12) + "Refresh</button>" }) +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:16px">' +
      panel("Connections", "users", conns, { flush: true, right: S.stats ? '<span class="hint">' + S.stats.connections.length + " connections</span>" : "" }) +
      panel("Endpoints (same origin)", "terminal", '<div class="panel-bd--flush">' + epHtml + "</div>", { flush: true, right: '<span class="hint mono">same-origin only</span>' }) +
    "</div>" +
    '<div style="margin-top:16px">' + techDetails("Technical details", { health: S.health, stats: S.stats }) + "</div>"
  );
}

/* 404 */
function notfoundView() {
  return '<div class="center-404">' +
    '<div class="eyebrow">DEMO</div>' +
    "<h1>Page not found</h1>" +
    "<p>That route doesn't exist. Check the URL or return to the overview.</p>" +
    '<div class="row" style="justify-content:center"><a class="btn btn--primary btn--lg" href="#/overview">' + ic("arrow", 14) + "Back to DEMO</a><a class=\"btn btn--lg\" href=\"#/capabilities\">Browse capabilities</a></div>" +
  "</div>";
}

/* browser */
function browserView() {
  if (!S.health) {
    if (S.healthErr) return pageHead("Browser", "Browser", "Persistent sessions, screenshots, and human handoff.") + '<div style="height:16px"></div>' +
      errPanel("Browser status unavailable", "/health", "core", "The Worker did not answer, so browser availability is unknown right now.");
    return pageHead("Browser", "Browser", "Persistent sessions, screenshots, and human handoff.") + '<div style="height:16px"></div>' +
      panel("Browser subsystem", "globe", skeletonPanel(6));
  }
  var c = caps();
  var rows = [
    kv("Provider", '<code class="chip-v">' + esc(c.provider || "—") + "</code>"),
    kv("Availability", boolSt(c.browserAvailable, "Operational"), c.browserAvailable ? "" : esc(c.reason || "Browser Rendering binding not attached")),
    kv("Session storage", c.sessionStorage === "durable-object" ? st("ok", "Durable Object") : st("warn", "In-memory (dev fallback)")),
    kv("Keep-alive", c.keepAliveMs ? '<span class="mono">' + (c.keepAliveMs / 1000) + "s</span>" : "—"),
    kv("Screenshots", boolSt(c.screenshots, "R2 available"), c.screenshotReason ? esc(c.screenshotReason) : ""),
    kv("Full-page capture", boolSt(c.fullPageScreenshot, "Supported")),
    kv("Accessibility snapshot", boolSt(c.accessibilitySnapshot, "Supported")),
    kv("Live view", boolSt(c.liveView, "Available")),
    kv("Human handoff", boolSt(c.handoff, "Available")),
    kv("Video frame sampling", boolSt(c.videoFrames, "Available")),
    kv("Guardrails · SSRF", boolSt(c.guardrails, "Active"), "private/internal targets refused")
  ].join("");

  var flow = (DATA.BROWSER_FLOW || []).map(function (s, idx) {
    return '<div class="flow-step"><span class="flow-num">' + (idx + 1) + "</span>" +
      '<div class="flow-txt"><code>' + esc(s.tool) + '</code><div class="fx-d">' + esc(s.text) + "</div></div></div>";
  }).join("");

  var bt = CAT.filter(function (t) { return t.group === "Browser"; });
  var trows = bt.length ? bt.map(function (t) { return toolRow(t); }).join("") : emptyState("globe", "No browser tools", "The browser binding is not attached on this deployment.");

  return (
    pageHead("Browser", "Browser", "A real persistent browser, driven by an MCP client through these tools. Sessions are scoped to the conversation that opened them.") +
    '<div style="height:20px"></div>' +
    '<div class="grid grid--2">' +
      panel("Subsystem state", "gauge", '<div class="panel-bd--flush">' + rows + "</div>", { flush: true, right: c.browserAvailable ? st("ok", "Operational") : st("off", "Unavailable") }) +
      panel("Session workflow — via MCP tools", "terminal", '<div class="flow">' + flow + "</div>", {
        flush: true,
        right: (DATA.PROJECT && DATA.PROJECT.docsTreeUrl) ? '<a class="btn btn--sm" href="' + esc(DATA.PROJECT.docsTreeUrl + "/BROWSER.md") + '" target="_blank" rel="noreferrer noopener">' + ic("book", 13) + "Docs</a>" : ""
      }) +
    "</div>" +
    '<div style="margin-top:16px">' + panel("Browser tools — " + bt.length + " registered", "camera", '<div class="panel-bd--flush">' + trows + "</div>", {
      flush: true,
      right: '<button class="btn btn--sm" type="button" data-act="tools-tab">Open explorer</button>'
    }) + "</div>" +
    '<div style="margin-top:16px">' + note("This page shows live capability state and never drives the browser itself. Screenshots land in R2 and are readable at <code class=\"chip-v\">/screenshots/:id</code> until they expire. Login walls and CAPTCHAs are surfaced for a human through the Live View and never bypassed.") + "</div>"
  );
}

/* video */
function videoView() {
  var v = S.lazy.video, err = S.lazyErr.video;
  var head = pageHead("Video", "Video", "Public video understanding with explicit, inspectable evidence. Every claim must be grounded in delivered frames or transcript.") + '<div style="height:20px"></div>';
  if (err && !v) return head + errPanel("Video capabilities unavailable", LAZY_ROUTES.video, "video", "The capability report did not return. Try again or inspect deployment status.");

  var stages = (DATA.VIDEO_STAGES || []).map(function (s) {
    var on = hv(s.flag);
    var pill = on == null ? (S.healthErr ? st("err", "Unreachable") : st("idle", "Checking")) : (on ? st("ok", "Operational") : st("off", "Unavailable"));
    return kv(s.label, pill, esc(s.detail));
  }).join("");

  var platforms = "";
  if (v && v.supportedPlatforms) {
    for (var i = 0; i < v.supportedPlatforms.length; i++) {
      var p = v.supportedPlatforms[i];
      var open = !!S.expandedPlatforms[p.platform];
      var notes = p.notes || "";
      platforms += '<button class="trow" type="button" data-act="plat" data-p="' + esc(p.platform) + '" aria-expanded="' + (open ? "true" : "false") + '" title="' + esc(p.platform + " — " + notes.slice(0, 200)) + '">' +
        '<span class="tname">' + esc(p.platform) + "</span>" +
        '<span class="tdesc">' + esc(open ? notes : notes.slice(0, 160)) + (notes.length > 160 && !open ? "…" : "") + "</span>" +
        '<span class="tgrp">' + (p.frameDecoding ? "frames" : "metadata") + "</span>" +
        '<span class="tw">' + ic("chev", 16) + "</span></button>";
      if (open && notes.length > 160) {
        platforms += '<div class="tdetail"><p class="tdesc-full">' + esc(notes) + "</p></div>";
      }
    }
  }

  var providers = "";
  if (v && v.providers) {
    providers = v.providers.map(function (pr) {
      return kv(pr.id, boolSt(pr.configured, "Configured", "Not bound"), pr.enables ? esc(pr.enables) : "");
    }).join("");
  }

  var limits = "";
  if (v && v.limits) {
    var L = v.limits;
    limits = '<div class="pill-row" style="margin-top:0">' +
      '<span class="chip" style="cursor:default">≤ ' + L.maxDownloadMb + " MB download</span>" +
      '<span class="chip" style="cursor:default">≤ ' + L.maxDurationSeconds + "s duration</span>" +
      '<span class="chip" style="cursor:default">≤ ' + L.maxFrames + " frames / call</span>" +
      '<span class="chip" style="cursor:default">≤ ' + L.audioMaxSeconds + "s audio</span>" +
      '<span class="chip" style="cursor:default">artifact TTL ' + Math.round((L.artifactTtlSeconds || 0) / 60) + " min</span>" +
      '<span class="chip" style="cursor:default">' + L.rateLimitPerMinute + "/min rate limit</span></div>";
  }

  var honesty = '<ul class="list">' + (DATA.HONESTY_RULES || []).map(function (r) {
    return "<li><span class=\"li-k\">" + esc(r) + "</span></li>";
  }).join("") + "</ul>";

  var vt = CAT.filter(function (t) { return t.group === "Video" || t.group === "YouTube"; });
  var vrows = vt.length ? vt.map(function (t) { return toolRow(t); }).join("") : emptyState("play", "No video tools", "Video capability is not available on this deployment.");

  return (
    head +
    panel("Pipeline stages", "film", '<div class="panel-bd--flush">' + stages + "</div>", { flush: true, right: S.health ? st(videoPipe().s, videoPipe().l) : "" }) +
    '<div style="margin-top:16px">' + panel("Platform support", "layers", v ? '<div class="panel-bd--flush">' + platforms + "</div>" : skeletonPanel(4), {
      flush: true,
      right: v ? '<span class="hint mono">' + esc(v.schema || "") + "</span>" : ""
    }) + "</div>" +
    (providers ? '<div style="margin-top:16px">' + panel("Providers — presence only, never values", "cpu", '<div class="panel-bd--flush">' + providers + "</div>", { flush: true }) + "</div>" : "") +
    (limits ? '<div style="margin-top:16px">' + panel("Guardrails", "shield", limits + note("Every URL and redirect hop passes the SSRF guard. Signed CDN URLs are never persisted — only the original public page URL is stored. Manifests (HLS/DASH) are reported, never assembled.")) + "</div>" : "") +
    '<div class="grid grid--2" style="margin-top:16px">' +
      panel("Honesty contract", "info", honesty, { right: '<span class="hint">evidence rules</span>' }) +
      panel("Video & YouTube tools — " + vt.length, "play", '<div class="panel-bd--flush">' + vrows + "</div>", { flush: true }) +
    "</div>" +
    '<div style="margin-top:16px">' + note("Artifacts are temporary and expiring: retrieved bytes are served from <code class=\"chip-v\">/video-assets/:ref</code> (Range-aware for playback), decoded frames from <code class=\"chip-v\">/screenshots/:id</code>. This page shows pipeline capability, not results — never claim a video was analyzed unless the connected client received real frames or a transcript from the tool.") + "</div>"
  );
}

/* research */
function researchView() {
  var e = S.lazy.expanded, err = S.lazyErr.expanded;
  var head = pageHead("Web & Research", "Web & research", "Fetch, extract, and compare public sources — with full provenance. Every finding keeps its source URL and retrieval timestamp.") + '<div style="height:20px"></div>';
  if (err && !e) return head + errPanel("Expanded capabilities report unavailable", LAZY_ROUTES.expanded, "expanded", "The report endpoint did not return. Try again or inspect deployment status.");
  var g = e;
  if (!g) return head + panel("Research capabilities", "search", skeletonPanel(6));

  function flagRow(label, val, detail) {
    var pill = val === true ? st("ok", "Available") : val === false ? st("off", "Unavailable") : st("info", String(val));
    return kv(label, pill, detail ? esc(detail) : "");
  }

  var cards = "";
  cards += panel("Web extraction · diff · monitor", "file",
    flagRow("Extract readable content", g.web && g.web.extract) +
    flagRow("Versioned diff", g.web && g.web.diff) +
    flagRow("Monitors (R2)", g.web && g.web.monitor) +
    flagRow("Snapshot storage", !!(g.web && g.web.snapshots), g.web ? g.web.snapshotStorage : "") +
    flagRow("Scheduled checks", !!(g.web && g.web.scheduledChecks), "opt-in") +
    flagRow("Screenshot diff", !!(g.web && g.web.screenshotDiff))
  , { flush: true });

  cards += panel("Sources & provenance", "database",
    '<div class="panel-bd"><p class="note">Every finding keeps its <b>source URL, retrieval timestamp and the exact result</b>; conflicting sources are reported side by side instead of silently merged. Nothing is cited that was not fetched, and a missing archive snapshot is reported as missing — never invented.</p>' +
    '<p class="hint" style="margin-top:8px">provenance · ' + esc((g.research && g.research.provenance) || "per-source URL + retrieval time") + "</p>" +
    '<p class="hint">human handoff · ' + esc((g.research && g.research.humanHandoff) || "challenges pause for a human") + "</p></div>");

  var sub = "";
  if (g.git) sub += flagRow("Public Git (smart-HTTP)", true, "≤ " + g.git.maxPackMb + " MB · " + g.git.rateLimitPerMinute + "/min · private repos refused") + "";
  if (g.internetArchive) sub += flagRow("Internet Archive / Wayback", g.internetArchive.available, (g.internetArchive.endpoints || []).length + " public endpoints, no key");
  if (g.feeds) sub += flagRow("Feeds", g.feeds.available, (g.feeds.formats || []).join(" · "));
  if (g.pdf) sub += flagRow("PDF intelligence", g.pdf.available, g.pdf.ocr ? "OCR via " + g.pdf.ocrProvider : "text layer only — no OCR provider bound");
  if (g.images) sub += flagRow("Image analysis", g.images.available, g.images.vision ? "vision via " + g.images.visionProvider : "info only — vision not bound");
  if (g.openapi) sub += flagRow("OpenAPI inspection", g.openapi.available, "read-only; never calls the described APIs");
  if (g.network) sub += flagRow("Network diagnostics", true, (g.network.dns ? "DNS · " : "") + "HTTP timings · " + (g.network.tls || "TLS info"));
  if (g.utilities) sub += flagRow("Local utilities", true, "schema · JWT decode · cron · text diff — no external calls");
  if (g.urlSafety) sub += flagRow("URL safety inspector", g.urlSafety.available, g.urlSafety.usesSharedSsrfGuard ? "shares the SSRF guard" : "");
  if (sub) cards += panel("Retrieval surfaces", "globe", '<div class="panel-bd--flush">' + sub + "</div>", { flush: true });

  var rt = CAT.filter(function (t) {
    return ["Git", "Internet Archive", "Feeds", "Documents", "Web Intelligence", "Research", "Network"].indexOf(t.group) !== -1;
  });
  var rtRows = rt.length ? rt.map(function (t) { return toolRow(t); }).join("") : emptyState("search", "No research tools", "Research capabilities are not available.");
  cards += panel("Research tool surface — " + rt.length + " tools", "search", '<div class="panel-bd--flush">' + rtRows + "</div>", {
    flush: true,
    right: '<button class="btn btn--sm" type="button" data-act="tools-tab">Open explorer</button>'
  });

  return head + '<div class="stack">' + cards + "</div>" +
    '<div style="margin-top:16px">' + note("Run research from an MCP client — ask it to call <code class=\"chip-v\">web_research</code>, <code class=\"chip-v\">web_extract</code>, <code class=\"chip-v\">feed_read</code> or <code class=\"chip-v\">wayback</code>. This page shows live capability state only; it never fabricates results, sources or timestamps.") + "</div>";
}

/* routing */
function routingView() {
  var sc = statCaps();
  var jev = sc.jevDecisionEngine || {}, laya = sc.layaDecisionProvider || {};
  var mode = hv("decisionRoutingMode") || laya.routingMode || "auto";

  function secretRow(name, ok, detail) {
    return kv(name, ok === true ? st("ok", "Configured") : ok === false ? st("off", "Not configured") : st("idle", "Unknown"),
      (ok === true ? "secret value hidden" : detail ? esc(detail) : ""));
  }

  var jevDetail = jev.available ? "Model " + jev.model + " · thresholds review " + jev.reviewThreshold + " / accept " + jev.acceptThreshold : (jev.reason || "No credential — DEMO's own deterministic rules decide.");
  var layaDetail = laya.available ? "Endpoint host " + (laya.endpointHost || "—") + " · model " + laya.model : (laya.reason || "No Laya endpoint configured on this Worker.");

  var commands = (DATA.MCP_COMMANDS || []).map(function (cmd) {
    return kv(cmd.name, '<span class="hint">' + esc(cmd.description) + "</span>", "via MCP");
  }).join("");

  var dt = CAT.filter(function (t) { return t.group === "JEV" || t.group === "Laya"; });
  var dtRows = dt.length ? dt.map(function (t) { return toolRow(t); }).join("") : emptyState("cpu", "No decision tools", "Decision routing is using built-in rules.");
  var head = pageHead("Routing", "Decision routing", "Typed Jev and Laya judgments — advisory only, never authoritative. They can influence frame sampling or task splitting, never authorize tools or bypass checks.") + '<div style="height:20px"></div>';

  return (
    head +
    '<div class="grid grid--2">' +
      panel("Decision routing", "branch",
        '<div class="row" style="gap:12px;align-items:baseline"><span class="mono" style="font-size:24px;letter-spacing:-.02em;font-weight:700">' + esc(mode) + "</span>" + st("info", "auto: Laya → Jev → deterministic rules") + "</div>" +
        note("Typed decisions are <b>advisory only</b>. Jev and Laya are components of DEMO's decision layer — they can influence which frames to sample or how to split a task, but they never authorize tools, bypass checks or touch credentials.") +
        "<div class=\"note-warn\">DEMO's permissions, confirmations and security policy stay authoritative no matter what a routing answer says.</div>") +
      panel("Configuration — safe metadata only", "key",
        '<div class="panel-bd--flush">' +
        secretRow("Jev (TypeSafe engine)", jev.credentialConfigured, "no credential present on this Worker") +
        secretRow("Laya endpoint", laya.configured, laya.available ? "" : "not bound") +
        secretRow("Laya credential", laya.credentialConfigured, "optional") +
        secretRow("YouTube Data API", sc.youtube ? sc.youtube.available : undefined, "key configured server-side") +
        "</div>" +
        '<div class="panel-bd"><div class="hint">These rows read <b>presence booleans</b> from <code class="chip-v">/platform/stats</code>. Secret values live only as Worker secrets — they are never sent to a browser, never logged, never rendered. Per-tool OAuth protects <code class="chip-v">jev_decide</code> and <code class="chip-v">collab_*</code>; public tools remain available without a login.</div></div>',
        { flush: false }) +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:16px">' +
      panel("Jev decision engine", "cpu",
        '<div class="row">' + (jev.available ? st("ok", "Operational") : st("off", "Not configured")) + (jev.enabled ? st("info", "enabled") : "") + "</div>" +
        '<p class="note" style="margin-top:12px">' + esc(jevDetail) + "</p>" +
        '<p class="hint">Full policy: <code class="chip-v">GET /capabilities/jev</code> — presence + policy, never the credential.</p>') +
      panel("Laya decision provider", "layers",
        '<div class="row">' + (laya.available ? st("ok", "Operational") : st("off", "Not configured")) + (laya.configured ? st("info", "endpoint bound") : "") + "</div>" +
        '<p class="note" style="margin-top:12px">' + esc(layaDetail) + "</p>" +
        '<p class="hint">HTTPS-only and SSRF-guarded on every call. Full policy: <code class="chip-v">GET /capabilities/laya</code>.</p>') +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:16px">' +
      panel("Commands — run in your MCP client", "terminal", '<div class="panel-bd--flush">' + commands + "</div>", { flush: true }) +
      panel("Decision tools", "zap", '<div class="panel-bd--flush">' + dtRows + "</div>", { flush: true }) +
    "</div>"
  );
}

/* collaboration + build your own x */
function collabView() {
  var collab = S.lazy.collab, err = S.lazyErr.collab;
  var byox = S.lazy.byox, byoxErr = S.lazyErr.byox;
  var spaces = S.lazy.collabWorkspaces, spacesErr = S.lazyErr.collabWorkspaces;

  var head = pageHead("Collaboration", "Shared workspace",
    "DEMO coordinates ChatGPT, Jev and Laya on real repository work: task planning, isolated patches, conflict detection, review, recorded tests and typed delegation. DEMO executes no code itself and never reports that a collaborator did something it cannot verify.") + '<div style="height:20px"></div>';

  if (!collab && !err) {
    return head + '<div class="grid grid--2">' + skeletonPanel(4) + skeletonPanel(4) + "</div>" +
      '<div style="height:16px"></div><div class="grid grid--2">' + skeletonPanel(3) + skeletonPanel(3) + "</div>";
  }
  if (!collab) {
    return head + errPanel("Collaboration status unavailable", LAZY_ROUTES.collab, "collab", "The capability report did not return. Try again or inspect deployment status.");
  }

  var env = collab.environment || {};
  var policy = collab.policy || {};

  function capChip(label, value) {
    return '<span class="chip">' + esc(label) + ": " + (value === true ? "yes" : value === false ? "no" : esc(String(value))) + "</span>";
  }

  var collaboratorRows = (collab.collaborators || []).map(function (person) {
    var caps = person.capabilities || {};
    var chips = [
      capChip("patches", caps.submit_patch), capChip("review", caps.review),
      capChip("records tests", caps.record_tests), capChip("applies patches", caps.apply_patch),
      capChip("writes to GitHub", caps.write_to_github), capChip("typed decisions", caps.typed_decisions),
      capChip("executes code", caps.execute_code)
    ].join("");
    var limits = (person.limitations || []).map(function (line) { return "<li>" + esc(line) + "</li>"; }).join("");
    return '<div class="panel-bd--flush" style="padding:14px 16px;border-bottom:1px solid var(--line)">' +
      '<div class="row" style="gap:10px;align-items:baseline;flex-wrap:wrap">' +
      '<b>' + esc(person.label || person.id) + "</b>" +
      st(person.status === "available" ? "ok" : "off", person.status === "available" ? "Available" : "Unavailable") +
      '<span class="hint">' + esc(person.kind || "") + " · execution: " + esc(person.execution || "none") + "</span></div>" +
      '<p class="hint" style="margin:6px 0 8px">' + esc(person.channel || "") + "</p>" +
      '<div class="pill-row">' + chips + "</div>" +
      (limits ? '<ul class="hint" style="margin:10px 0 0 18px">' + limits + "</ul>" : "") +
      "</div>";
  }).join("");

  var envRows = [
    kv("Workspace storage", env.workspaceStorage === "durable-object" ? st("ok", "Durable Object") : st("off", "Unavailable"), "DEMO_ACCOUNTS object · namespaced keys · no extra binding"),
    kv("Patch application", env.patchApplicationEnabled === false ? st("off", "Disabled by configuration") : st("ok", "Enabled"), "COLLAB_ALLOW_APPLY"),
    kv("Jev typed decisions", env.jevDecisionProvider ? st("ok", "Configured") : st("off", "Not configured"), "TYPESAFE_API_KEY"),
    kv("Laya typed decisions", env.layaDecisionProvider ? st("ok", "Configured") : st("off", "Not configured"), "LAYA_BASE_URL + LAYA_API_KEY"),
    kv("GitHub dispatch", env.githubActionsTokenConfigured ? st("ok", "Token configured") : st("off", "No token"), "GITHUB_ACTIONS_TOKEN (actions: write)"),
    kv("Workspaces", env.workspaceCount == null ? st("idle", "Unknown") : '<span class="mono">' + esc(String(env.workspaceCount)) + "</span>", "bounded list, oldest evicted")
  ].join("");

  var policyHtml = [
    note(esc(policy.execution || "DEMO executes no code.")),
    note(esc(policy.githubWrites || "")),
    note(esc(policy.attribution || "")),
    note(esc(policy.untrustedContent || "")),
    note("Protected paths: <code class=\"chip-v\">" + esc((policy.protectedPaths || []).join(", ")) + "</code> — a patch to one of these additionally needs <code class=\"chip-v\">approve_protected</code>.")
  ].join("");

  var spaceRows = "";
  if (!spaces && !spacesErr) spaceRows = skeletonPanel(2);
  else if (spacesErr) spaceRows = '<div class="panel-bd"><p class="note">' + esc(spacesErr.message || "The workspace list did not return.") + "</p></div>";
  else {
    var list = (spaces && spaces.workspaces) || [];
    spaceRows = list.length
      ? '<div class="panel-bd--flush">' + list.map(function (ws) {
          return '<div class="panel-bd--flush" style="padding:12px 16px;border-bottom:1px solid var(--line)">' +
            '<div class="row" style="gap:10px;align-items:baseline;flex-wrap:wrap"><b class="mono">' + esc(ws.id) + "</b>" +
            '<span class="hint">' + esc(ws.repo) + "@" + esc(ws.ref) + "</span></div>" +
            '<div class="hint" style="margin-top:6px">' + esc(ws.title) + " · " + esc(String(ws.tasks)) + " tasks · " + esc(String(ws.patches)) + " patches · " + esc(String(ws.tests)) + " tests · updated " + esc(fmtTs(ws.updatedAt)) + "</div></div>";
        }).join("") + "</div>"
      : '<div class="panel-bd">' + emptyState("users", "No workspaces yet", "Open one over MCP with collab_workspace { action: \"open\", repo, ref } — it needs a collab:write DEMO OAuth grant because workspace content is project code.") + "</div>";
  }

  var byoxPanel;
  if (!byox && !byoxErr) byoxPanel = panel("Build Your Own X catalog", "spark", skeletonPanel(3));
  else if (byoxErr) byoxPanel = errPanel("Catalog unavailable", LAZY_ROUTES.byox, "byox", "The catalog report did not return. An administrator may need to run byox_refresh_index.");
  else {
    var cat = byox.catalog || {};
    var topCats = (byox.categories || []).slice(0, 8).map(function (category) {
      return '<span class="chip">' + esc(category.title) + ": " + esc(String(category.count)) + "</span>";
    }).join("");
    var topLangs = (byox.languages || []).slice(0, 8).map(function (language) {
      return '<span class="chip">' + esc(language.name) + ": " + esc(String(language.count)) + "</span>";
    }).join("");
    byoxPanel = panel("Build Your Own X catalog", "spark",
      '<div class="row" style="gap:10px;flex-wrap:wrap">' +
        (byox.indexed ? st("ok", cat.entries + " entries") : st("off", "Not indexed yet")) +
        (cat.stale ? st("warn", "Stale") : (byox.indexed ? st("ok", "Fresh") : "")) +
        st("info", "metadata only") +
      "</div>" +
      '<div class="hint" style="margin-top:10px">Source: <span class="mono">' + esc((byox.source && byox.source.repo) || "codecrafters-io/build-your-own-x") + "</span> · last checked " + esc(cat.lastCheckedAt ? fmtTs(cat.lastCheckedAt) : "—") + " · storage " + esc((byox.storage && byox.storage.backend) || "—") + "</div>" +
      (topCats ? '<div class="pill-row" style="margin-top:10px">' + topCats + "</div>" : "") +
      (topLangs ? '<div class="pill-row" style="margin-top:6px">' + topLangs + "</div>" : "") +
      note("DEMO stores references — title, languages, category and the original link — and never re-hosts or summarizes a tutorial. Reading one page is an explicit single-page action with access checks.") +
      '<div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">' +
        '<a class="btn" href="/byox/search?q=renderer&amp;limit=5" target="_blank" rel="noreferrer noopener">' + ic("external") + "<span>Sample search</span></a>" +
        '<a class="btn" href="' + esc(LAZY_ROUTES.byox) + '" target="_blank" rel="noreferrer noopener">Raw report</a>' +
      "</div>", { cls: "panel--wide" });
  }

  var tools = CAT.filter(function (t) { return t.group === "Collaboration" || t.group === "Build Your Own X"; });
  var toolRows = tools.length ? tools.map(function (t) { return toolRow(t); }).join("") : "";

  return head +
    '<div class="grid grid--2">' +
      panel("Collaborators — real capabilities", "users",
        collaboratorRows || '<div class="panel-bd">' + emptyState("users", "No collaborator data", "The capability report returned no collaborators.") + "</div>", { flush: true }) +
      '<div>' + panel("Environment", "key", envRows, { flush: true }) + '<div style="height:16px"></div>' + panel("Policy", "shield", policyHtml) + "</div>" +
    "</div>" +
    '<div style="height:16px"></div>' + byoxPanel +
    '<div style="height:16px"></div>' +
    '<div class="grid grid--2">' +
      panel("Workspaces", "database", spaceRows, { flush: true }) +
      panel("Collaboration tools", "tools", '<div class="panel-bd--flush">' + toolRows + "</div>", { flush: true }) +
    "</div>";
}

/* skills */
function skillsView() {
  var cards = (DATA.BUILTIN_SKILLS || []).map(function (sk) {
    return panel(sk.title, "zap",
      '<div class="row" style="justify-content:space-between"><span class="mono muted">' + esc(sk.name) + '</span><span class="row" style="gap:8px">' + st("ok", "bundled") + '<code class="chip-v">' + esc(sk.invoke) + "</code></span></div>" +
      note(esc(sk.description)) +
      '<div class="row" style="margin-top:12px;justify-content:space-between">' +
        '<span class="hint">' + esc(sk.note || "") + (sk.license ? " · " + esc(sk.license) : "") + "</span>" +
        (sk.source ? '<a class="btn btn--sm" href="' + esc(sk.source) + '" target="_blank" rel="noreferrer noopener">' + ic("external", 13) + esc(sk.sourceLabel || "source") + "</a>" : "") +
      "</div>");
  }).join('<div style="height:16px"></div>');

  var skt = CAT.filter(function (t) { return t.group === "Skills"; });
  var sktRows = skt.length ? skt.map(function (t) { return toolRow(t); }).join("") : emptyState("puzzle", "No skill tools", "Skills are not available.");

  return pageHead("Skills", "Skills", "Bundled skills plus the live skills.sh catalog — text in, guidance out, nothing executed. DEMO does not install or run skill code.") +
    '<div style="height:20px"></div>' +
    '<div class="grid grid--2">' + cards + "</div>" +
    '<div style="margin-top:16px">' + panel("skills.sh surface — via MCP tools", "layers",
      '<div class="panel-bd"><p class="note">Live search, browse, retrieval and security audit run through the <b>skills_* tools over /mcp</b> against the public skills.sh catalog. No account, no local install, no execution: skill text is returned for review, and the <code class="chip-v">npx skills add …</code> line is printed, never run.</p>' +
      '<div class="row" style="margin-top:12px"><button class="btn btn--sm" type="button" data-act="skills-tools">' + ic("search", 13) + "Search & browse skills tools</button>" +
      '<span class="hint">' + skt.length + " skill tools · filterable with the live availability of each</span></div></div>" +
      '<div class="panel-bd--flush">' + sktRows + "</div>", { flush: true }) + "</div>";
}

/* about */
function aboutView() {
  var proj = DATA.PROJECT || {};
  var routes = (DATA.API_ROUTES || []).map(function (rt) {
    return kv(rt.path, '<span class="d">' + esc(rt.note) + "</span>");
  }).join("");
  var priv = (DATA.PRIVACY_FACTS || []).map(function (p) {
    return "<li><span class=\"li-k\">" + esc(p) + "</span></li>";
  }).join("");
  var s1 = S.stats;
  var info =
    kv("Repository", proj.repoUrl ? '<a href="' + esc(proj.repoUrl) + '" target="_blank" rel="noreferrer noopener">' + esc(proj.repoLabel || proj.repoUrl) + "</a>" : "—") +
    kv("Runtime", '<span class="hint">Cloudflare Workers · Durable Objects · R2 · Browser Rendering · Workers AI</span>') +
    kv("Version", '<code class="chip-v">v' + esc((s1 && s1.version) || VERSION || "—") + "</code>") +
    kv("MCP endpoint", '<span class="copy-inline"><code class="chip-v">' + esc(ENDPOINT) + '</code><button class="btn btn--sm" type="button" data-act="copy" data-copy="' + esc(ENDPOINT) + '">' + ic("copy", 13) + "Copy</button></span>") +
    kv("Tools", (s1 ? s1.toolCount : CAT.length) + " registered on /mcp") +
    kv("Docs", (proj.docsTreeUrl ? '<a href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">docs/ in the repository</a>' : "—") + (proj.readmeUrl ? ' · <a href="' + esc(proj.readmeUrl) + '" target="_blank" rel="noreferrer noopener">README</a>' : ""));

  return (
    '<div class="page-head"><div class="eyebrow">' + esc(proj.name || "DEMO") + "</div>" +
      "<h1>" + esc(proj.tagline || "Execution infrastructure for AI agents.") + "</h1>" +
      "<p>" + esc(proj.blurb || "") + "</p>" +
      '<div class="row" style="margin-top:18px">' +
        '<button class="btn btn--primary btn--lg" type="button" data-act="connect-open">' + ic("plug") + "Connect MCP</button>" +
        (proj.repoUrl ? '<a class="btn btn--lg" href="' + esc(proj.repoUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("code") + "Source repository</a>" : "") +
        (proj.docsTreeUrl ? '<a class="btn btn--lg" href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("book") + "Documentation</a>" : "") +
      "</div>" +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:20px">' +
      panel("Project", "info", '<div class="panel-bd--flush">' + info + "</div>", { flush: true }) +
      panel("Security & privacy", "shield", '<ul class="list">' + priv + "</ul>", { flush: true, right: '<span class="badge-secure">' + ic("shield", 12) + 'No login</span>' }) +
    "</div>" +
    '<div style="margin-top:16px">' + panel("This Worker's routes", "terminal", '<div class="panel-bd--flush">' + routes + "</div>", { flush: true, right: '<span class="hint mono">same-origin</span>' }) + "</div>" +
    '<div style="margin-top:16px">' + panel("Architecture", "layers",
      '<pre class="codeblock">' + esc(DATA.ARCHITECTURE_TEXT || "") + "</pre>" +
      note("DEMO is open source: read it, self-host it, extend it. The inspector and <code class=\"chip-v\">/mcp</code> share one Worker. Public tools need no login; protected tools use per-tool OAuth.")) +
    "</div>"
  );
}

/* connect modal — provider URLs only from BOOT.clients */
function clientById(id) {
  for (var i = 0; i < CLIENTS.length; i++) if (CLIENTS[i].id === id) return CLIENTS[i];
  return null;
}
function safeHref(url) {
  if (!url) return "";
  if (url.indexOf("https://") === 0) return url;
  if (url.indexOf("cursor://anysphere.cursor-deeplink/mcp/install?") === 0) return url;
  if (url.indexOf("vscode:mcp/install?") === 0) return url;
  if (url.indexOf("vscode-insiders:mcp/install?") === 0) return url;
  return "";
}
function pillClass(method) {
  if (method === "direct-prefill" || method === "direct-install") return "pill pill--verified";
  if (method === "official-screen") return "pill";
  return "pill pill--manual";
}
function connectHeader(title, sub, back) {
  var lead = back
    ? '<button class="btn btn--icon" type="button" data-act="connect-back" aria-label="Back to clients">' + ic("chevL") + "</button>"
    : '<span class="modal-ic">' + ic("plug") + "</span>";
  return '<div class="modal-hd">' + lead +
    '<div><h3 id="connect-title">' + esc(title) + '</h3><p class="sub" id="connect-sub">' + esc(sub) + "</p></div>" +
    '<button class="btn btn--icon x" type="button" data-act="connect-close" aria-label="Close dialog">' + ic("x") + "</button></div>";
}
function connectFooter(withUrl) {
  var extra = "";
  if (withUrl) {
    extra = '<code id="mcp-endpoint" class="connect-ft-url">' + esc(SERVER_URL) + "</code>" +
      '<button class="btn btn--sm" type="button" id="copy-endpoint" data-act="copy" data-copy="' + esc(SERVER_URL) + '" data-swap="Copied!">' + ic("copy", 13) + "Copy</button>";
  }
  return '<div class="modal-ft connect-ft"><span class="connect-ft-note">' + ic("shield") + "<span>Public tools need no login. Protected tools require per-tool OAuth where supported; this dialog never confirms a connection.</span></span>" + extra + "</div>";
}
function endpointBlock(primary) {
  var cls = primary ? "btn btn--primary" : "btn";
  return '<p class="endpoint-label">DEMO MCP endpoint</p>' +
    '<div class="endpoint"><code id="mcp-endpoint" tabindex="0">' + esc(SERVER_URL) + "</code>" +
    '<button class="' + cls + '" type="button" id="copy-endpoint" data-act="copy" data-copy="' + esc(SERVER_URL) + '" data-swap="Copied!">' + ic("copy") + "Copy endpoint</button></div>";
}
function stepsHtml(steps) {
  if (!steps || !steps.length) return "";
  var html = '<ol class="modal-steps">';
  for (var i = 0; i < steps.length; i++) {
    html += '<li><span class="n">' + (i + 1) + "</span><span>" + esc(steps[i]) + "</span></li>";
  }
  return html + "</ol>";
}
function limitsHtml(items) {
  if (!items || !items.length) return "";
  var html = '<ul class="connect-notes">';
  for (var i = 0; i < items.length; i++) html += "<li>" + esc(items[i]) + "</li>";
  return html + "</ul>";
}
function snippetBlock(title, body, copyLabel) {
  if (!body) return "";
  return '<div class="connect-config"><div class="connect-config-hd"><span>' + esc(title) + "</span>" +
    '<button class="btn btn--sm" type="button" data-act="copy" data-copy="' + esc(body) + '" data-swap="Copied!">' + ic("copy", 13) + esc(copyLabel) + "</button></div>" +
    "<pre>" + esc(body) + "</pre></div>";
}
function metaLine(c) {
  var parts = [];
  var plats = c.platforms || [];
  for (var i = 0; i < plats.length; i++) parts.push(plats[i]);
  parts.push("Streamable HTTP");
  parts.push(c.authentication === "mixed" ? "Mixed Authentication · per-tool OAuth" : "Public tools · no login");
  return parts.join(" · ");
}
function providerButton(c) {
  return '<button class="prov" type="button" data-act="connect-pick" data-client="' + esc(c.id) + '" aria-label="' + esc(c.name + ". " + c.badge + ". " + c.summary) + '">' +
    '<span class="prov-mark">' + ic(c.icon || "plug") + "</span>" +
    '<span class="prov-txt"><span class="prov-name">' + esc(c.name) + ' <span class="' + pillClass(c.method) + '">' + esc(c.badge) + "</span></span>" +
    '<span class="prov-sum">' + esc(c.summary) + "</span></span>" +
    '<span class="prov-chev" aria-hidden="true">' + ic("chev", 16) + "</span></button>";
}
function launchAnchor(c) {
  var href = safeHref(c.connectionUrl);
  if (!href) return "";
  var app = c.connectionOpensIn === "app";
  var aria = c.actionLabel + (app ? ", opens the app" : ", opens in a new tab");
  var extra = app ? "" : ' target="_blank" rel="noreferrer noopener"';
  return '<a class="btn btn--primary" id="connect-primary" data-act="connect-launch" data-protocol="' + (app ? "1" : "0") + '" href="' + esc(href) + '"' + extra + ' aria-label="' + esc(aria) + '">' +
    esc(c.actionLabel) + (app ? "" : ic("external")) + "</a>";
}
function linksHtml(c) {
  var html = '<div class="connect-links">';
  var any = false;
  if (c.documentationUrl) {
    any = true;
    var docs = safeHref(c.documentationUrl);
    if (docs) html += '<a href="' + esc(docs) + '" target="_blank" rel="noreferrer noopener">' + ic("book", 12) + "Official documentation" + ic("external", 12) + "</a>";
  }
  var alts = c.alternates || [];
  for (var i = 0; i < alts.length; i++) {
    any = true;
    var a = alts[i];
    var app = a.kind === "app";
    var href = safeHref(a.url);
    if (!href) continue;
    html += '<a href="' + esc(href) + '"' +
      (app
        ? ' data-act="connect-launch" data-protocol="1"'
        : ' target="_blank" rel="noreferrer noopener"') + ">" +
      esc(a.label) + (app ? "" : ic("external", 12)) + "</a>";
  }
  if (!any) return "";
  return html + "</div>";
}
var FEATURED_CLIENTS = ["chatgpt", "claude", "cursor", "claude-code", "vscode"];

function platCard(c) {
  return '<button class="plat-card prov" type="button" data-act="connect-pick" data-client="' + esc(c.id) + '" aria-label="' + esc(c.name + ". " + c.badge) + '">' +
    platLogo(c.id, c.icon) +
    '<span class="plat-name">' + esc(c.name) + ' <span class="' + pillClass(c.method) + '">' + esc(c.badge) + "</span></span>" +
    '<span class="plat-desc">' + esc(c.summary) + "</span>" +
    '<span class="plat-cta">Setup ' + ic("arrow") + "</span></button>";
}

function pickerHtml() {
  var title = CONNECT.title || "Connect DEMO";
  var sub = CONNECT.subtitle || "Choose where you want to connect DEMO.";
  var body = "";
  if (!CLIENTS.length) {
    body = '<p class="connect-callout">Client list unavailable. Copy the endpoint and add it manually.</p>' + endpointBlock(true);
  } else {
    var featured = "", others = "";
    for (var i = 0; i < FEATURED_CLIENTS.length; i++) {
      var c = clientById(FEATURED_CLIENTS[i]);
      if (c) featured += platCard(c);
    }
    for (var j = 0; j < CLIENTS.length; j++) {
      if (FEATURED_CLIENTS.indexOf(CLIENTS[j].id) === -1) others += providerButton(CLIENTS[j]);
    }
    body = '<div class="plat-grid" role="group" aria-label="Choose where you want to connect DEMO">' + featured + "</div>";
    if (others) body += '<div class="prov-list">' + others + "</div>";
  }
  return connectHeader(title, sub, false) +
    '<div class="modal-bd connect-pane" id="connect-panel">' + body + "</div>" +
    connectFooter(!CLIENTS.length ? false : true);
}
function confirmHtml(c) {
  var copyIsPrimary = c.method === "manual" && !c.manualCommand;
  var actions = "";
  var launch = c.connectionUrl ? launchAnchor(c) : "";
  if (launch || c.manualCommand || (c.connectionUrl && c.connectionOpensIn === "app")) {
    actions = '<div class="connect-actions">';
    if (launch) actions += launch;
    if (c.connectionOpensIn === "app" && safeHref(c.connectionUrl)) {
      actions += '<button class="btn" type="button" data-act="copy" data-copy="' + esc(c.connectionUrl) + '" data-swap="Copied!">' + ic("copy") + "Copy install link</button>";
    }
    if (!launch && c.manualCommand) {
      actions += '<button class="btn btn--primary" type="button" id="connect-primary" data-act="copy" data-copy="' + esc(c.manualCommand) + '" data-swap="Copied!">' + ic("copy") + esc(c.actionLabel || "Copy command") + "</button>";
    }
    actions += "</div>";
  }
  var logoHead = '<div class="plat-detail-head">' + platLogo(c.id, c.icon) + "<div>" +
    '<div class="plat-name" style="font-size:16px">' + esc(c.name) + ' <span class="' + pillClass(c.method) + '">' + esc(c.badge) + "</span></div>" +
    '<div class="plat-desc">' + esc(metaLine(c)) + "</div></div></div>";
  return connectHeader(c.confirmTitle, c.confirmBody, true) +
    '<div class="modal-bd connect-pane" id="connect-panel">' +
      logoHead +
      endpointBlock(copyIsPrimary) +
      (c.callout ? '<p class="connect-callout">' + esc(c.callout) + "</p>" : "") +
      actions +
      '<p id="connect-status" class="connect-status" role="status" aria-live="polite"></p>' +
      stepsHtml(c.steps) +
      snippetBlock(c.manualCommand ? "Terminal" : "", c.manualCommand, "Copy") +
      snippetBlock(c.manualConfigTitle || "Configuration", c.manualConfig, "Copy") +
      limitsHtml(c.limitations) +
      linksHtml(c) +
    "</div>" +
    connectFooter(false);
}
function connectHtml() {
  var client = S.connectId ? clientById(S.connectId) : null;
  if (S.connectId && !client) S.connectId = "";
  if (!client) return pickerHtml();
  return confirmHtml(client);
}
function renderConnect() {
  var root = qs("#connect-root");
  if (root) root.innerHTML = connectHtml();
}
function focusClient(id) {
  var btn = id ? qs('.prov[data-client="' + id + '"]') : null;
  if (btn) btn.focus();
  else {
    var first = qs(".prov");
    if (first) first.focus();
  }
}
function showClient(id) {
  S.connectId = id;
  S.connectNote = "";
  renderConnect();
  var back = qs('[data-act="connect-back"]');
  if (back) back.focus();
}
function backToClients() {
  var id = S.connectId;
  S.connectId = "";
  S.connectNote = "";
  renderConnect();
  focusClient(id);
}

/* command palette */
function paletteItems() {
  var items = [];
  var secs = DATA.SECTIONS || [];
  for (var i = 0; i < secs.length; i++) {
    (function (s) {
      if (s.nav === "hidden") return;
      items.push({ label: s.label, hint: s.blurb || "section", icon: s.icon, group: "Navigate", run: function () { go(s.id); } });
    })(secs[i]);
  }
  items.push({ label: "Copy MCP endpoint", hint: "https URL", icon: "copy", group: "Actions", run: function () { copyText(SERVER_URL || ENDPOINT, true); } });
  items.push({ label: "Connect MCP — show dialog", hint: "modal", icon: "plug", group: "Actions", run: function () { openConnect(); } });
  items.push({ label: "Refresh telemetry", hint: "re-fetch", icon: "refresh", group: "Actions", run: function () { loadCore(true); loadRoblox(true); } });
  items.push({ label: "Capability explorer", hint: CAT.length + " tools", icon: "search", group: "Navigate", run: function () { go("capabilities"); setTimeout(function () { var el = qs("#tool-search"); if (el) el.focus(); }, 60); } });
  var cmds = DATA.MCP_COMMANDS || [];
  for (var j = 0; j < cmds.length; j++) {
    (function (cmd) {
      items.push({ label: "Command " + cmd.name, hint: "via MCP", icon: "terminal", group: "Commands", run: function () { go(cmd.name === "/mcp" ? "overview" : "routing"); } });
    })(cmds[j]);
  }
  if (DATA.PROJECT && DATA.PROJECT.repoUrl) items.push({ label: "Open source repository", hint: "new tab", icon: "code", group: "Resources", run: function () { window.open(DATA.PROJECT.repoUrl, "_blank", "noopener"); } });
  if (DATA.PROJECT && DATA.PROJECT.docsTreeUrl) items.push({ label: "Open documentation", hint: "new tab", icon: "book", group: "Resources", run: function () { window.open(DATA.PROJECT.docsTreeUrl, "_blank", "noopener"); } });
  return items;
}

function paletteBody() {
  return '<div class="p-search">' + ic("search") +
    '<input id="palette-input" type="text" placeholder="Jump to a section or run an action…" aria-label="Command palette" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="palette-results"><kbd>Esc</kbd></div>' +
    '<div class="p-results" id="palette-results" role="listbox" aria-label="Commands"></div>';
}

function renderPalette() {
  var box = qs("#palette-results");
  if (!box) return;
  var q = S.pQuery.toLowerCase();
  var all = paletteItems();
  var items = [];
  for (var i = 0; i < all.length; i++) {
    var it = all[i];
    if (!q || (it.label + " " + (it.hint || "") + " " + (it.group || "")).toLowerCase().indexOf(q) !== -1) items.push(it);
  }
  if (S.pSel >= items.length) S.pSel = items.length ? items.length - 1 : 0;
  if (S.pSel < 0) S.pSel = 0;
  if (!items.length) {
    box.innerHTML = '<div class="p-empty">' + ic("search", 24) + '<p style="margin:8px 0 0">Nothing matches that.</p><p class="hint" style="margin-top:4px">Try a different term or browse capabilities.</p></div>';
    S.pItems = [];
    return;
  }
  var html = "";
  var lastGroup = "";
  for (var k = 0; k < items.length; k++) {
    var m = items[k];
    if (m.group !== lastGroup) {
      html += '<div class="mi-sec" style="padding:12px 12px 4px">' + esc(m.group || "Other") + "</div>";
      lastGroup = m.group || "";
    }
    html += '<button class="p-item" type="button" role="option" aria-selected="' + (k === S.pSel ? "true" : "false") + '" data-pidx="' + k + '" id="p-opt-' + k + '">' +
      ic(m.icon) + '<span class="p-lbl">' + esc(m.label) + "</span>" +
      (m.hint ? '<span class="p-kind">' + esc(m.hint) + "</span>" : "") + "</button>";
  }
  box.innerHTML = html;
  S.pItems = items;
  var input = qs("#palette-input");
  if (input) input.setAttribute("aria-activedescendant", "p-opt-" + S.pSel);
}

function runPalette(i) {
  var it = (S.pItems || [])[i];
  closeOverlays();
  if (it && it.run) it.run();
}

/* overlays — focus trap, scroll lock, return focus */
function lockScroll() {
  var sb = window.innerWidth - document.documentElement.clientWidth;
  body().style.overflow = "hidden";
  if (sb > 0) body().style.paddingRight = sb + "px";
}
function unlockScroll() {
  body().style.overflow = "";
  body().style.paddingRight = "";
}

function getFocusable(root) {
  if (!root) return [];
  return qsa('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root).filter(function (el) {
    return el.offsetParent !== null || el === document.activeElement;
  });
}

function openOverlay(overlaySel, focusSel) {
  var ov = qs(overlaySel);
  if (!ov) return;
  S.lastFocus = document.activeElement;
  ov.hidden = false;
  lockScroll();
  document.addEventListener("keydown", overlayKeys, true);
  var f = qs(focusSel || "input, button", ov);
  if (f) f.focus();
}
function closeOverlays() {
  var a = qs("#connect-overlay"), b = qs("#palette-overlay");
  var wasOpen = (a && !a.hidden) || (b && !b.hidden);
  if (a) a.hidden = true;
  if (b) b.hidden = true;
  S.modalOpen = false;
  S.paletteOpen = false;
  document.removeEventListener("keydown", overlayKeys, true);
  if (wasOpen) unlockScroll();
  if (S.lastFocus && S.lastFocus.focus) { try { S.lastFocus.focus(); } catch (e) {} }
  S.lastFocus = null;
}
function openConnect() {
  setMenu(false);
  S.modalOpen = true;
  S.connectId = "";
  S.connectNote = "";
  renderConnect();
  openOverlay("#connect-overlay", ".prov, #copy-endpoint");
}
function openPalette() {
  setMenu(false);
  S.paletteOpen = true;
  S.pQuery = "";
  S.pSel = 0;
  openOverlay("#palette-overlay", "#palette-input");
  renderPalette();
  var inp = qs("#palette-input");
  if (inp) inp.value = "";
}
function overlayKeys(ev) {
  if (ev.key === "Escape") { ev.preventDefault(); closeOverlays(); return; }
  if (ev.key === "Tab") {
    var scope = S.paletteOpen ? qs("#palette-overlay") : qs("#connect-overlay");
    if (!scope || scope.hidden) return;
    var f = getFocusable(scope);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    return;
  }
  if (S.modalOpen && !S.paletteOpen && (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Home" || ev.key === "End")) {
    var provs = qsa(".prov", qs("#connect-overlay"));
    if (!provs.length) return;
    var idx = -1;
    for (var pi = 0; pi < provs.length; pi++) if (provs[pi] === document.activeElement) idx = pi;
    if (idx !== -1 || ev.key === "Home" || ev.key === "End") {
      ev.preventDefault();
      var next = idx;
      if (ev.key === "ArrowDown") next = Math.min(provs.length - 1, idx + 1);
      else if (ev.key === "ArrowUp") next = Math.max(0, idx - 1);
      else if (ev.key === "Home") next = 0;
      else next = provs.length - 1;
      if (next < 0) next = 0;
      provs[next].focus();
      return;
    }
  }
  if (S.paletteOpen) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); S.pSel++; renderPalette(); var e1 = qs("#p-opt-" + S.pSel); if (e1 && e1.scrollIntoView) e1.scrollIntoView({ block: "nearest" }); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); S.pSel = Math.max(0, S.pSel - 1); renderPalette(); var e2 = qs("#p-opt-" + S.pSel); if (e2 && e2.scrollIntoView) e2.scrollIntoView({ block: "nearest" }); }
    else if (ev.key === "Enter") { ev.preventDefault(); runPalette(S.pSel); }
  }
}

function setMenu(open) {
  var isOpen = !!open;
  var wasOpen = body().classList.contains("menu-open");
  body().classList.toggle("menu-open", isOpen);
  var btn = qs('[data-act="menu-toggle"]');
  if (btn) {
    btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    btn.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
  }
  if (isOpen && !wasOpen) {
    lockScroll();
    var fi = qs("#menu a.mi, #menu button.mi");
    if (fi) fi.focus();
    // focus trap for menu
    document.addEventListener("keydown", menuKeys, true);
    document.addEventListener("click", menuOutside, true);
  } else if (!isOpen && wasOpen) {
    unlockScroll();
    document.removeEventListener("keydown", menuKeys, true);
    document.removeEventListener("click", menuOutside, true);
  }
}
function menuKeys(ev) {
  if (ev.key === "Escape") { ev.preventDefault(); setMenu(false); var b = qs('[data-act="menu-toggle"]'); if (b) b.focus(); return; }
  if (ev.key === "Tab") {
    var scope = qs("#menu");
    if (!scope) return;
    var f = getFocusable(scope);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
}
function menuOutside(ev) {
  var menu = qs("#menu");
  var btn = qs('[data-act="menu-toggle"]');
  if (!menu || !body().classList.contains("menu-open")) return;
  if (menu.contains(ev.target) || (btn && btn.contains(ev.target))) return;
  setMenu(false);
}

/* toast */
function toast(msg) {
  var box = qs("#toasts");
  if (!box) return;
  var el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = ic("checkc") + "<span>" + esc(msg) + "</span>";
  box.appendChild(el);
  setTimeout(function () { el.style.opacity = "0"; el.style.transform = "translateY(4px)"; el.style.transition = "opacity 180ms var(--ease-out), transform 180ms var(--ease-out)"; }, 2200);
  setTimeout(function () { el.remove(); }, 2500);
}

function copyText(text, notify) {
  function done(okFlag) {
    if (okFlag && notify) toast("Copied!");
    return okFlag;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return done(true); }, function () { return done(fallbackCopy(text)); });
  }
  return Promise.resolve(done(fallbackCopy(text)));
}
function fallbackCopy(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* data loads */
function loadCore(force) {
  if (S.core && !force) return S.core;
  S.statsErr = null;
  S.healthErr = null;
  S.core = Promise.all([
    jfetch("/health").then(function (d) { S.health = d; }, function (e) { S.healthErr = e; }),
    jfetch("/platform/stats").then(function (d) { S.stats = d; }, function (e) { S.statsErr = e; })
  ]).then(function () {
    S.core = null;
    renderView();
  });
  return S.core;
}

function loadLazy(key) {
  if (S.lazy[key] || S.lazyInflight[key]) return;
  var path = LAZY_ROUTES[key];
  if (!path) return;
  S.lazyInflight[key] = true;
  jfetch(path).then(function (d) {
    S.lazy[key] = d;
    S.lazyErr[key] = null;
  }, function (e) {
    S.lazyErr[key] = e;
  }).then(function () {
    S.lazyInflight[key] = false;
    if (S.route === "video" || S.route === "research" || S.route === "collab") renderView();
  });
}

/* events */
document.addEventListener("click", function (ev) {
  var t = ev.target;
  if (!t || !t.closest) return;

  var navLink = t.closest('a[href^="#/"]');
  if (navLink) {
    setMenu(false);
    return;
  }

  var pitem = t.closest(".p-item");
  if (pitem) { runPalette(Number(pitem.getAttribute("data-pidx"))); return; }

  var el = t.closest("[data-act]");
  if (!el) {
    if (t.id === "connect-overlay" || t.id === "palette-overlay") closeOverlays();
    return;
  }
  var act = el.getAttribute("data-act");

  if (act === "tools-tab") go("capabilities");
  else if (act === "skills-tools") { S.tf.group = "skills"; S.tf.avail = ""; S.tf.q = ""; go("capabilities"); }
  else if (act === "open-tool") {
    var nm = el.getAttribute("data-name");
    if (S.route !== "tools" && S.route !== "capabilities") {
      S.tf.group = "";
      S.tf.avail = "";
      S.tf.q = "";
      S.openTool = nm;
      go("capabilities");
    } else {
      S.openTool = S.openTool === nm ? null : nm;
      var rowsBox = qs("#tool-rows");
      if (rowsBox) {
        rowsBox.innerHTML = toolsRowsHtml();
        if (S.openTool === nm) {
          var detail = rowsBox.querySelector(".tdetail");
          if (detail && detail.scrollIntoView) detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      } else {
        renderView();
      }
    }
  }
  else if (act === "plat") {
    var pk = el.getAttribute("data-p");
    S.expandedPlatforms[pk] = !S.expandedPlatforms[pk];
    renderView();
  }
  else if (act === "copy") {
    var txt = el.getAttribute("data-copy") || "";
    var swap = el.getAttribute("data-swap");
    copyText(txt, !swap).then(function (okFlag) {
      if (okFlag && swap) {
        var orig = el.getAttribute("data-label");
        if (orig == null) { orig = el.innerHTML; el.setAttribute("data-label", orig); }
        el.innerHTML = ic("check") + esc(swap);
        setTimeout(function () { el.innerHTML = orig; }, 1600);
      } else if (!okFlag) {
        toast("Copy blocked — select the text and copy manually.");
      }
    });
  }
  else if (act === "connect-open") openConnect();
  else if (act === "connect-close") closeOverlays();
  else if (act === "connect-pick") showClient(el.getAttribute("data-client") || "");
  else if (act === "connect-back") backToClients();
  else if (act === "connect-launch") {
    var note = qs("#connect-status");
    var protocol = el.getAttribute("data-protocol") === "1";
    var msg = protocol
      ? "If the app did not open, it is not installed or this browser blocked the link. Use the manual setup below. DEMO cannot tell whether it launched."
      : "Finish in the new tab. DEMO cannot tell whether you approved the connection.";
    if (note) note.textContent = msg;
  }
  else if (act === "palette-open") openPalette();
  else if (act === "palette-close") closeOverlays();
  else if (act === "menu-toggle") setMenu(!body().classList.contains("menu-open"));
  else if (act === "filter-group") {
    S.tf.group = S.tf.group === el.getAttribute("data-g") ? "" : el.getAttribute("data-g");
    renderView();
  }
  else if (act === "filter-avail") {
    S.tf.avail = S.tf.avail === el.getAttribute("data-a") ? "" : el.getAttribute("data-a");
    renderView();
  }
  else if (act === "clear-filters") {
    S.tf.group = ""; S.tf.avail = ""; S.tf.q = "";
    var inp = qs("#tool-search");
    if (inp) inp.value = "";
    renderView();
  }
  else if (act === "refresh") {
    loadCore(true);
    toast("Refreshing telemetry…");
  }
  else if (act === "retry") {
    var key = el.getAttribute("data-key");
    if (!key || key === "core") { S.core = null; loadCore(true); }
    else { S.lazyErr[key] = null; S.lazy[key] = null; loadLazy(key); }
  }
  else if (act === "theme-toggle") cycleTheme();
});

document.addEventListener("input", function (ev) {
  var el = ev.target;
  if (!el) return;
  if (el.id === "tool-search") {
    S.tf.q = el.value;
    var rowsBox = qs("#tool-rows");
    if (rowsBox) rowsBox.innerHTML = toolsRowsHtml();
    else { renderView(); return; }
    var count = qs("#tool-count");
    if (count) {
      var n = filteredTools().length;
      count.textContent = n + " shown · " + (S.stats ? S.stats.toolCount + " live on /mcp" : CAT.length + " in catalog");
    }
    var tcount2 = qs(".panel-hd .hd-note .mono");
    if (tcount2) {
      var list = filteredTools();
      tcount2.textContent = list.length + "/" + CAT.length;
    }
  }
  if (el.id === "palette-input") {
    S.pQuery = el.value;
    S.pSel = 0;
    renderPalette();
  }
});

document.addEventListener("keydown", function (ev) {
  if ((ev.metaKey || ev.ctrlKey) && String(ev.key).toLowerCase() === "k") {
    ev.preventDefault();
    if (S.paletteOpen) closeOverlays();
    else openPalette();
  } else if (ev.key === "Escape" && !S.modalOpen && !S.paletteOpen && body().classList.contains("menu-open")) {
    setMenu(false);
    var b = qs('[data-act="menu-toggle"]');
    if (b) b.focus();
  }
});

window.addEventListener("hashchange", function () {
  var next = routeFromHash();
  if (next !== S.route) { S.route = next; S.openTool = null; }
  renderView();
  enterRoute();
});

/* boot */
function enterRoute() {
  if (S.route === "video") loadLazy("video");
  if (S.route === "research") loadLazy("expanded");
  if (S.route === "collab") { loadLazy("collab"); loadLazy("byox"); loadLazy("collabWorkspaces"); }
}

function boot() {
  S.route = routeFromHash();
  applyStoredTheme();
  renderShell();
  renderView();
  loadCore(false);
  enterRoute();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();`;
