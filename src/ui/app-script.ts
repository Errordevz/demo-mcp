/**
 * DEMO inspector UI — client application.
 *
 * A zero-dependency, self-contained single-page app. It is inlined into the
 * one HTML document the Worker serves (the CSP locks the page to inline
 * script + same-origin fetches, which is why this is a string and not a
 * bundler app — and why there is deliberately no framework here).
 *
 * Every panel renders from live data fetched off the Worker's own public
 * routes (/health, /platform/stats, /capabilities/*, /oauth/roblox/status)
 * or from static facts generated out of this repository (the tool catalog is
 * extracted from the real tool registrations). Nothing is mocked, no metrics
 * are invented, and there is no login: DEMO is open by default.
 *
 * Style constraints for this file:
 *  - it is embedded via String.raw, so the body must not contain backticks
 *    or dollar-brace sequences;
 *  - the Roblox connect control is pinned by tests to the exact assignment
 *    location.href='/oauth/roblox/start' and the labels "Connect Roblox
 *    account" / "Disconnect" — keep those literals.
 */
export const APP_SCRIPT = String.raw`(function () {
"use strict";

var BOOT = window.__DEMO_BOOT__ || {};
var CAT = BOOT.catalog || [];
var GROUPS = BOOT.groups || [];
var DATA = BOOT.data || {};
var ENDPOINT = BOOT.endpoint || "";
var VERSION = BOOT.version || "";
var HINTS = DATA.AVAILABILITY_HINTS || {};

var S = {
  route: "",
  health: null, healthErr: null,
  stats: null, statsErr: null,
  roblox: null, robloxErr: null, robloxLoading: true, robloxInflight: false,
  lazy: {}, lazyErr: {}, lazyInflight: {},
  openTool: null,
  tf: { q: "", group: "", avail: "" },
  expandedPlatforms: {},
  core: null,
  modalOpen: false, paletteOpen: false, lastFocus: null, pSel: 0, pQuery: "", pItems: []
};

var LAZY_ROUTES = {
  video: "/capabilities/video",
  expanded: "/capabilities/expanded"
};

/* ------------------------------------------------------------- utilities */

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function jfetch(path, opts) {
  opts = opts || {};
  var init = { cache: "no-store", headers: { Accept: "application/json" } };
  if (opts.method) init.method = opts.method;
  return fetch(path, init).then(function (r) {
    return r.text().then(function (t) {
      var j = null;
      try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
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
  tools: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M3 12h18", "M12 3c2.7 2.6 4 5.6 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.6-4-9s1.3-6.4 4-9z"],
  play: ["M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M10.5 9.2l4.3 2.8-4.3 2.8z"],
  search: ["M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z", "M21 21l-4.35-4.35"],
  branch: ["M6 4v16", "M18 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z", "M18 9c0 4-4 5.5-12 5.5"],
  game: ["M6.5 7h11a4.5 4.5 0 0 1 0 9h-1.3a3 3 0 0 1-2.3-1.1l-.5-.6a2.2 2.2 0 0 0-3.4 0l-.5.6A3 3 0 0 1 7.8 16H6.5a4.5 4.5 0 0 1 0-9z", "M7.5 12h2", "M15.5 11.5h.01", "M17 13h.01"],
  zap: ["M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"],
  info: ["M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z", "M12 11v5", "M12 8h.01"],
  plug: ["M9 7V3", "M15 7V3", "M7 7h10v3a5 5 0 0 1-10 0z", "M12 15v6"],
  copy: ["M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  check: ["M20 6L9 17l-5-5"],
  checkc: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M8.5 12.5l2.5 2.5 5-5.5"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  alert: ["M12 3.5L21.5 20h-19z", "M12 10v4", "M12 17h.01"],
  xc: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M14.5 9.5l-5 5", "M9.5 9.5l5 5"],
  slash: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M5.6 5.6l12.8 12.8"],
  clock: ["M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z", "M12 7.5V12l3 2"],
  chev: ["M9 6l6 6-6 6"],
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
  dot: ["M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"]
};

function ic(name, size) {
  var paths = ICONS[name] || ICONS.dot;
  var out = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (size) out += ' width="' + size + '" height="' + size + '"';
  for (var i = 0; i < paths.length; i++) out += '<path d="' + paths[i] + '"/>';
  return out + "</svg>";
}

/* status pill — icon + text; color is never the only signal */
var ST_ICONS = { ok: "check", warn: "alert", err: "xc", off: "slash", info: "dot", idle: "clock" };
function st(kind, label) {
  return '<span class="st st--' + kind + '">' + ic(ST_ICONS[kind] || "dot") + esc(label) + "</span>";
}
function boolSt(v, okLabel, offLabel) {
  return v ? st("ok", okLabel) : st("off", offLabel || "Unavailable");
}

/* ------------------------------------------------------------- app state */

function body() { return document.body; }
function caps() { return (S.health && S.health.capabilities) || {}; }
function statCaps() { return (S.stats && S.stats.capabilities) || {}; }
function hv(k) { return S.health ? S.health[k] : undefined; }

function toolAvail(key) {
  if (!S.health && !S.stats) {
    if (key === "always") return { s: "ok", l: "Available" };
    if (key === "bearer") return { s: "warn", l: "Private · credential" };
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
    case "bearer": return { s: "warn", l: "Private · credential" };
    default: return { s: "ok", l: "Available" };
  }
}

/* ------------------------------------------------------------ navigation */

function routeFromHash() {
  var h = (location.hash || "").replace(/^#\/?/, "").split("?")[0];
  var secs = DATA.SECTIONS || [];
  for (var i = 0; i < secs.length; i++) if (secs[i].id === h) return h;
  return "overview";
}
function go(route) {
  if (location.hash === "#/" + route) { renderView(); enterRoute(); return; }
  location.hash = "#/" + route;
}

/* ------------------------------------------------------------- rendering */

function sectionMeta(id) {
  var secs = DATA.SECTIONS || [];
  for (var i = 0; i < secs.length; i++) if (secs[i].id === id) return secs[i];
  return secs[0] || { id: "overview", label: "Overview", icon: "gauge", blurb: "" };
}

function renderShell() {
  var app = qs("#app");
  if (!app) return;
  var secs = DATA.SECTIONS || [];
  var nav = "";
  for (var i = 0; i < secs.length; i++) {
    var s = secs[i];
    var flag = navFlag(s.id);
    nav += '<a href="#/' + s.id + '" data-route="' + s.id + '"' + (S.route === s.id ? ' aria-current="page"' : "") + ' title="' + esc(s.label) + '">' +
      ic(s.icon) + '<span class="lbl">' + esc(s.label) + "</span>" + (flag || "") + "</a>";
  }
  var proj = DATA.PROJECT || {};
  app.innerHTML =
    '<a class="skip" href="#main">Skip to content</a>' +
    '<div class="layout">' +
      '<aside class="sidebar" id="sidebar" aria-label="Main navigation">' +
        '<div class="brand">' +
          '<div class="brand-mark" aria-hidden="true">D</div>' +
          '<div class="brand-text"><div class="brand-name">' + esc(proj.name || "DEMO") + "</div>" +
          '<div class="brand-sub">' + esc(proj.tagline || "execution layer") + "</div></div>" +
        "</div>" +
        '<nav class="nav" aria-label="Sections"><div class="nav-sec">Platform</div>' + nav + "</nav>" +
        '<div class="side-foot">' +
          '<div class="side-note"><b>No account required.</b> Connect an MCP client and start using DEMO.</div>' +
          '<div class="row" style="gap:6px">' +
            (proj.repoUrl ? '<a class="btn btn--sm btn--icon" href="' + esc(proj.repoUrl) + '" rel="noreferrer noopener" target="_blank" aria-label="Source repository on GitHub" title="Source repository">' + ic("code") + "</a>" : "") +
            (proj.docsTreeUrl ? '<a class="btn btn--sm btn--icon" href="' + esc(proj.docsTreeUrl) + '" rel="noreferrer noopener" target="_blank" aria-label="Documentation" title="Documentation">' + ic("book") + "</a>" : "") +
            '<button class="collapse-btn" type="button" data-act="collapse" aria-label="Collapse sidebar" title="Collapse sidebar">' + ic("chev", 13) + "</button>" +
          "</div>" +
        "</div>" +
      "</aside>" +
      '<div class="scrim" data-act="drawer-close" aria-hidden="true"></div>' +
      '<div class="main-col">' +
        '<header class="topbar">' +
          '<button class="menu-btn" type="button" data-act="drawer-open" aria-label="Open navigation">' + ic("menu") + "</button>" +
          '<h2 id="tb-title"></h2><span class="tb-sub" id="tb-sub"></span>' +
          '<span class="grow"></span>' +
          '<div class="topbar-actions">' +
            '<button class="btn" type="button" data-act="palette-open" aria-label="Open command palette">' + ic("search") + '<span class="lbl">Search</span><kbd>⌘K</kbd></button>' +
            '<button class="btn btn--primary" type="button" data-act="connect-open">' + ic("plug") + '<span class="lbl">Connect MCP</span></button>' +
          "</div>" +
        "</header>" +
        '<main id="main" class="content" tabindex="-1"><div id="view"></div></main>' +
        '<footer class="foot" id="foot"></footer>' +
      "</div>" +
    "</div>" +
    '<div class="overlay" id="connect-overlay" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">' + connectModalBody() + "</div></div>" +
    '<div class="overlay" id="palette-overlay" hidden><div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">' + paletteBody() + "</div></div>" +
    '<div class="toasts" id="toasts" role="status" aria-live="polite"></div>';
}

function navFlag(id) {
  if (!S.health && !S.stats) return "";
  if (id === "tools") {
    var n = S.stats ? S.stats.toolCount : CAT.length;
    if (n) return '<span class="nav-flag mono faint">' + n + "</span>";
    return "";
  }
  var cls = "", label = "";
  if (id === "roblox") {
    var r = robloxState();
    if (r.s === "warn" || r.s === "err") { cls = "st--" + r.s + " st--dot"; label = r.short; }
  } else if (id === "browser" && caps().browserAvailable === false) {
    cls = "st--off st--dot"; label = "Browser unavailable";
  }
  if (!cls) return "";
  return '<span class="nav-flag st ' + cls + '" title="' + esc(label) + '"><span class="vh">' + esc(label) + "</span></span>";
}

function renderView() {
  var meta = sectionMeta(S.route);
  var t = qs("#tb-title"); if (t) t.textContent = meta.label;
  var sub = qs("#tb-sub"); if (sub) sub.textContent = meta.blurb || "";
  qsa(".nav a").forEach(function (a) {
    if (a.getAttribute("data-route") === S.route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  var views = {
    overview: overviewView, tools: toolsView, browser: browserView, video: videoView,
    research: researchView, routing: routingView, roblox: robloxView, skills: skillsView, about: aboutView
  };
  var fn = views[S.route] || overviewView;
  var view = qs("#view");
  if (view) view.innerHTML = fn();
  renderFoot();
  document.title = meta.label + " · DEMO inspector";
}

function renderShellNav() {
  qsa(".nav a").forEach(function (a) {
    var old = qs(".nav-flag", a);
    if (old) old.remove();
    var flag = navFlag(a.getAttribute("data-route"));
    if (flag) a.insertAdjacentHTML("beforeend", flag);
  });
}

function renderFoot() {
  var f = qs("#foot");
  if (!f) return;
  if (S.statsErr || !S.stats) {
    f.innerHTML = "<span>no cookies · no tracking · no login</span>";
    return;
  }
  var s1 = S.stats;
  var bits = [];
  bits.push('<span class="mono">v' + esc(s1.version || VERSION || "—") + "</span>");
  bits.push('<span class="mono">' + s1.toolCount + " tools</span>");
  if (s1.generatedAt) bits.push("<span>telemetry " + esc(fmtTs(s1.generatedAt)) + "</span>");
  if (typeof s1.uptimeSeconds === "number") bits.push("<span>isolate age " + esc(fmtDur(s1.uptimeSeconds)) + " · " + s1.requestCountSinceIsolateStart + " req (this isolate)</span>");
  bits.push("<span>no cookies · no tracking · no login</span>");
  f.innerHTML = bits.join("<span aria-hidden=\"true\">·</span>");
}

/* ---------------------------------------------------------------- shared */

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
    '<p class="hint mono" style="margin-top:6px">GET ' + esc(path || "/platform/stats") + "</p>" +
    '<div class="row" style="margin-top:10px"><button class="btn" type="button" data-act="retry" data-key="' + esc(key || "") + '">' + ic("refresh") + "Try again</button>" +
    '<a class="btn" href="' + esc(path || "/platform/stats") + '" target="_blank" rel="noreferrer noopener">Raw response</a></div>',
    { cls: "err-card" });
}

function note(html) { return '<p class="note">' + html + "</p>"; }

/* -------------------------------------------------------------- overview */

function robloxState() {
  if (S.robloxLoading && !S.roblox && !S.robloxErr) return { s: "idle", l: "Checking", short: "Checking" };
  if (S.robloxErr) {
    var p = S.robloxErr.payload || {};
    if (p.error === "not_configured" || S.robloxErr.status === 503) return { s: "off", l: "Not configured", short: "Not configured" };
    return { s: "err", l: "Status unavailable", short: "Error" };
  }
  var r = S.roblox || {};
  var conf = r.configuration || {};
  if (conf.enabled === false) {
    var missing = !conf.clientIdConfigured || !conf.clientSecretConfigured;
    return missing ? { s: "off", l: "Not configured", short: "Not configured" } : { s: "off", l: "Disabled", short: "Disabled" };
  }
  if (r.connected && r.account) {
    var granted = r.account.grantedScopes || [];
    var requested = (r.configuration && r.configuration.requestedScopes) || [];
    for (var g2 = 0; g2 < requested.length; g2++) {
      if (granted.indexOf(requested[g2]) === -1) return { s: "warn", l: "Insufficient scope", short: "Scope gap", missing: requested[g2] };
    }
    return { s: "ok", l: "Connected", short: "Connected" };
  }
  if (r.account && r.account.reauthorizationRequired) return { s: "warn", l: "Authorization required", short: "Re-auth required" };
  return { s: "idle", l: "Not connected", short: "Not connected" };
}

function overviewView() {
  if (S.statsErr && S.healthErr) {
    return heroBlock() + '<div style="height:14px"></div>' + errPanel("Backend unreachable — telemetry unavailable", "/platform/stats", "core",
      "The Worker did not answer. Try again or inspect deployment status.");
  }
  var c = caps(), sc = statCaps();
  var live = !!S.health;

  var rows1 = [
    kv("DEMO version", live || S.stats ? '<code class="chip-v">' + esc((S.stats && S.stats.version) || VERSION || "—") + "</code>" : st("idle", "Loading")),
    kv("MCP endpoint", S.stats ? st("ok", "Operational") : st("idle", "Checking"), '<code class="chip-v">' + (S.stats ? "/mcp" : "…") + "</code>"),
    kv("Tools", S.stats ? st("info", String(S.stats.toolCount)) : st("idle", "Checking"), 'inventory at <code class="chip-v">/tools</code>'),
    kv("Browser", live ? boolSt(c.browserAvailable, "Operational") : st("idle", "Checking"), c.reason ? '<span class="hint">' + esc(c.reason) + "</span>" : ""),
    kv("Browser sessions", live ? (c.sessionStorage === "durable-object" ? st("ok", "Durable Object") : st("warn", "In-memory")) : st("idle", "…"), c.provider ? '<span class="hint mono">' + esc(c.provider) + "</span>" : ""),
    kv("Live view", live ? boolSt(c.liveView, "Available") : st("idle", "…")),
    kv("Screenshots", live ? boolSt(c.screenshots, "R2 storage") : st("idle", "…"), c.screenshotReason ? '<span class="hint">' + esc(c.screenshotReason) + "</span>" : ""),
    kv("Human handoff", live ? boolSt(c.handoff, "Enabled") : st("idle", "…")),
    kv("Accessibility snapshots", live ? boolSt(c.accessibilitySnapshot, "Enabled") : st("idle", "…"))
  ];
  var jev = sc.jevDecisionEngine || {}, laya = sc.layaDecisionProvider || {};
  var rows2 = [
    kv("Video bytes", hv("videoBytesRetrieval") != null ? boolSt(hv("videoBytesRetrieval"), "Available") : st("idle", "…")),
    kv("Frame decoding", hv("videoFrames") != null ? boolSt(hv("videoFrames"), "Operational") : st("idle", "…")),
    kv("Transcription", hv("videoTranscription") != null ? (hv("videoTranscription") ? st("ok", "Configured") : st("off", "No provider")) : st("idle", "…"), hv("transcriptionProvider") ? '<span class="hint mono">' + esc(hv("transcriptionProvider")) + "</span>" : ""),
    kv("Vision analysis", hv("videoVisionAnalysis") != null ? (hv("videoVisionAnalysis") ? st("ok", "Configured") : st("warn", "Optional")) : st("idle", "…"), hv("visionProvider") ? '<span class="hint mono">' + esc(hv("visionProvider")) + "</span>" : ""),
    kv("Video artifacts", hv("videoArtifacts") != null ? boolSt(hv("videoArtifacts"), "Available") : st("idle", "…")),
    kv("YouTube", sc.youtube ? (sc.youtube.available ? st("ok", "Configured") : st("off", "No API key")) : st("idle", "…")),
    kv("Git (public)", sc.expanded && sc.expanded.git ? st("ok", "Available") : st("idle", "…"), "public repos only · no key"),
    kv("Internet Archive", sc.expanded && sc.expanded.internetArchive ? st("ok", "Available") : st("idle", "…")),
    kv("Research", sc.expanded && sc.expanded.webResearch ? st("ok", "Available") : st("idle", "…")),
    kv("Jev engine", S.stats ? (jev.available ? st("ok", "Operational") : st("off", "Not configured")) : st("idle", "…"), jev.model ? '<span class="hint mono">' + esc(jev.model) + "</span>" : ""),
    kv("Laya engine", S.stats ? (laya.available ? st("ok", "Operational") : st("off", "Not configured")) : st("idle", "…"), laya.endpointHost ? '<span class="hint mono">' + esc(laya.endpointHost) + "</span>" : ""),
    kv("Roblox (optional)", st(robloxState().s, robloxState().l), "external authorization — not a DEMO login")
  ];

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
    for (var j2 = 0; j2 < keys.length; j2++) {
      epHtml += kv(keys[j2], '<code class="chip-v">' + esc(S.stats.endpoints[keys[j2]]) + "</code>");
    }
  } else {
    epHtml = skeletonPanel(4);
  }

  var noLogin = '<section class="panel" aria-label="Access model"><div class="panel-bd" style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">' +
    '<span class="badge-secure">' + ic("shield") + "Public by design</span>" +
    '<div class="note" style="flex:1;min-width:240px">DEMO access needs <b>no account and no sign-in</b> — the MCP endpoint, browser, video, research and utility tools are usable immediately. External authorization is asked for only where a capability genuinely needs it: today that is <b>Roblox OAuth</b>, and only for Roblox-account features. <a href="#/roblox">Roblox status →</a></div>' +
    "</div></section>";

  return (
    heroBlock() +
    '<div class="grid grid--status" style="margin-top:14px">' +
      statusCard("Deployment", "gauge", rows1) +
      statusCard("Capabilities", "cpu", rows2) +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:14px">' +
      panel("Connections", "users", conns, { flush: true }) +
      panel("Endpoints (same origin)", "terminal", '<div class="panel-bd--flush">' + epHtml + "</div>", { flush: true }) +
    "</div>" +
    '<div style="margin-top:14px">' + noLogin + "</div>"
  );
}

function heroBlock() {
  var online = S.stats ? S.stats.status === "online" : null;
  var proj = DATA.PROJECT || {};
  return '<div class="hero">' +
    '<div class="hero-main">' +
      '<div class="eyebrow">' + esc(proj.name || "DEMO") + " · " + esc(proj.tagline || "the open execution layer") + "</div>" +
      "<h1>Open infrastructure. No account required.</h1>" +
      "<p>" + esc(proj.blurb || "") + "</p>" +
      '<div class="row">' +
        (online === false ? st("err", "Degraded") : online ? st("ok", "Online") : st("idle", "Checking status")) +
        (S.stats ? st("info", S.stats.toolCount + " MCP tools") : "") +
        (S.health && caps().browserAvailable ? st("ok", "Browser ready") : S.health ? st("off", "Browser unavailable") : "") +
      "</div>" +
    "</div>" +
    '<div class="hero-side">' +
      '<button class="btn btn--primary" type="button" data-act="connect-open">' + ic("plug") + "Connect MCP</button>" +
      '<button class="btn" type="button" data-act="refresh">' + ic("refresh") + "Refresh telemetry</button>" +
      '<div class="hero-fine">demo-mcp on Cloudflare Workers · open by default</div>' +
    "</div>" +
  "</div>";
}

/* ----------------------------------------------------------------- tools */

function filteredTools() {
  var q = S.tf.q.toLowerCase();
  var out = [];
  for (var i = 0; i < CAT.length; i++) {
    var t = CAT[i];
    if (S.tf.group && t.group !== S.tf.group) continue;
    if (S.tf.avail) {
      var a = toolAvail(t.availability).s;
      if (S.tf.avail === "ok" && a !== "ok") continue;
      if (S.tf.avail === "off" && a !== "off" && a !== "idle") continue;
      if (S.tf.avail === "warn" && t.availability !== "bearer") continue;
    }
    if (q) {
      var hay = (t.name + " " + t.title + " " + (t.description || "") + " " + t.group).toLowerCase();
      if (hay.indexOf(q) === -1) continue;
    }
    out.push(t);
  }
  return out;
}

function toolRow(t, groupLabel) {
  var a = toolAvail(t.availability);
  var open = S.openTool === t.name;
  return '<button class="trow" type="button" data-act="open-tool" data-name="' + esc(t.name) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
    "<span>" + st(a.s, a.l) + "</span>" +
    '<span class="tname">' + esc(t.name) + "</span>" +
    '<span class="tdesc">' + esc(t.description || t.title) + "</span>" +
    '<span class="tgrp">' + esc(groupLabel || t.group) + "</span>" +
    '<span class="tw">' + ic("chev", 14) + "</span>" +
    "</button>";
}

function toolDetail(t) {
  var a = toolAvail(t.availability);
  var hint = HINTS[t.availability] || "";
  return '<div class="tdetail">' +
    '<p class="tdesc-full">' + esc(t.title) + (t.description ? " — " + esc(t.description) : " — description is available via tools/list over /mcp.") + "</p>" +
    (t.inputs && t.inputs.length ? '<h4>Input fields</h4><div class="pill-row">' + t.inputs.map(function (n) {
      return '<span class="in-chip">' + esc(n) + "</span>";
    }).join("") + '</div><p class="hint" style="margin-top:8px">Field names as registered on the MCP server. The full JSON Schema comes from tools/list on /mcp.</p>' : "") +
    '<h4>Availability</h4><div class="row" style="gap:8px">' + st(a.s, a.l) + (hint ? '<span class="hint">' + esc(hint) + "</span>" : "") + "</div>" +
    '<div class="tfoot"><button class="btn btn--sm" type="button" data-act="copy" data-copy="' + esc(t.name) + '">' + ic("copy", 13) + "Copy name</button>" +
    '<span class="hint">Invoke it from any connected MCP client — tools run through the same Worker that serves this page.</span></div>' +
    "</div>";
}

function toolsRowsHtml() {
  var list = filteredTools();
  var rows = "";
  for (var r = 0; r < list.length; r++) {
    rows += toolRow(list[r]);
    if (S.openTool === list[r].name) rows += toolDetail(list[r]);
  }
  if (!list.length) rows = '<div class="p-empty">No tool matches this filter.</div>';
  return rows;
}

function toolsView() {
  var gc = {};
  for (var i = 0; i < CAT.length; i++) gc[CAT[i].group] = (gc[CAT[i].group] || 0) + 1;
  var list = filteredTools();
  var chips = '<button class="chip" type="button" data-act="filter-group" data-g="" aria-pressed="' + (S.tf.group === "" ? "true" : "false") + '">All<span class="cnt">' + CAT.length + "</span></button>";
  var order = GROUPS.slice().sort();
  for (var g2 = 0; g2 < order.length; g2++) {
    var g = order[g2];
    chips += '<button class="chip" type="button" data-act="filter-group" data-g="' + esc(g) + '" aria-pressed="' + (S.tf.group === g ? "true" : "false") + '">' + esc(g) + '<span class="cnt">' + gc[g] + "</span></button>";
  }
  var availChips = [["", "Any state"], ["ok", "Available"], ["off", "Needs setup"], ["warn", "Private"]].map(function (o) {
    return '<button class="chip" type="button" data-act="filter-avail" data-a="' + o[0] + '" aria-pressed="' + (S.tf.avail === o[0] ? "true" : "false") + '">' + o[1] + "</button>";
  }).join("");

  var head = '<div class="panel-bd" style="border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
    '<div class="search">' + ic("search") + '<input id="tool-search" type="search" placeholder="Filter ' + CAT.length + ' tools by name, description or group…" aria-label="Filter tools" value="' + esc(S.tf.q) + '"></div>' +
    '<span class="tcount" id="tool-count">' + list.length + " shown · " + (S.stats ? S.stats.toolCount + " live on /mcp" : CAT.length + " in catalog") + "</span></div>" +
    '<div style="padding:10px 14px;border-bottom:1px solid var(--border)"><div class="chips">' + chips + "</div></div>" +
    '<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="eyebrow" style="margin-right:4px">State</span><div class="chips">' + availChips + "</div></div>";

  return panel("Tool explorer", "tools", head + '<div class="panel-bd--flush" id="tool-rows">' + toolsRowsHtml() + "</div>", {
    flush: true,
    right: S.health || S.stats ? "" : '<span class="hint">resolving live state…</span>'
  });
}

/* --------------------------------------------------------------- browser */

function browserView() {
  if (!S.health) return panel("Browser subsystem", "globe", skeletonPanel(6));
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
  var trows = bt.map(function (t) { return toolRow(t); }).join("");

  return (
    '<div class="grid grid--2">' +
      panel("Subsystem state", "gauge", '<div class="panel-bd--flush">' + rows + "</div>", { flush: true }) +
      panel("Session workflow — via MCP tools", "terminal", '<div class="flow">' + flow + "</div>", {
        flush: true,
        right: (DATA.PROJECT && DATA.PROJECT.docsTreeUrl) ? '<a class="btn btn--sm" href="' + esc(DATA.PROJECT.docsTreeUrl + "/BROWSER.md") + '" target="_blank" rel="noreferrer noopener">' + ic("book", 13) + "Docs</a>" : ""
      }) +
    "</div>" +
    '<div style="margin-top:14px">' + panel("Browser tools — " + bt.length + " registered", "camera", '<div class="panel-bd--flush">' + trows + "</div>", {
      flush: true,
      right: '<button class="btn btn--sm" type="button" data-act="tools-tab">Open explorer</button>'
    }) + "</div>" +
    '<div style="margin-top:14px">' + note("The browser is driven by an MCP client through these tools — this page shows live capability state and never drives the browser itself. Screenshots land in R2 and are readable at <code class=\"chip-v\">/screenshots/:id</code> until they expire. Login walls and CAPTCHAs are surfaced for a human through the Live View and never bypassed. Active sessions are scoped to the MCP conversation that opened them; there is no shared, cross-user session browser.") + "</div>"
  );
}

/* ----------------------------------------------------------------- video */

function videoView() {
  var v = S.lazy.video, err = S.lazyErr.video;
  if (err && !v) return errPanel("Video capabilities unavailable", LAZY_ROUTES.video, "video", "The capability report did not return. Try again or inspect deployment status.");

  var stages = (DATA.VIDEO_STAGES || []).map(function (s) {
    var on = hv(s.flag);
    var pill = on == null ? st("idle", "Checking") : (on ? st("ok", "Operational") : st("off", "Unavailable"));
    return kv(s.label, pill, esc(s.detail));
  }).join("");

  var platforms = "";
  if (v && v.supportedPlatforms) {
    for (var i = 0; i < v.supportedPlatforms.length; i++) {
      var p = v.supportedPlatforms[i];
      var open = !!S.expandedPlatforms[p.platform];
      var notes = p.notes || "";
      platforms += '<button class="trow" type="button" data-act="plat" data-p="' + esc(p.platform) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
        "<span>" + (p.frameDecoding ? st("ok", "Frames") : st("warn", "Metadata")) + "</span>" +
        '<span class="tname">' + esc(p.platform) + "</span>" +
        '<span class="tdesc">' + esc(open ? notes : notes.slice(0, 160)) + (notes.length > 160 && !open ? "…" : "") + "</span>" +
        '<span class="tgrp">' + (p.shortLinks ? "short links · " : "") + (p.directStreamDiscovery ? "stream discovery" : "page parsing") + "</span>" +
        '<span class="tw">' + ic("chev", 14) + "</span></button>";
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
  var vrows = vt.map(function (t) { return toolRow(t); }).join("");

  return (
    panel("Pipeline stages", "film", '<div class="panel-bd--flush">' + stages + "</div>", { flush: true }) +
    '<div style="margin-top:14px">' + panel("Platform support", "layers", v ? '<div class="panel-bd--flush">' + platforms + "</div>" : skeletonPanel(4), {
      flush: true,
      right: v ? '<span class="hint mono">' + esc(v.schema || "") + "</span>" : ""
    }) + "</div>" +
    (providers ? '<div style="margin-top:14px">' + panel("Providers — presence only, never values", "cpu", '<div class="panel-bd--flush">' + providers + "</div>", { flush: true }) + "</div>" : "") +
    (limits ? '<div style="margin-top:14px">' + panel("Guardrails", "shield", limits + note("Every URL and redirect hop passes the SSRF guard. Signed CDN URLs are never persisted — only the original public page URL is stored. Manifests (HLS/DASH) are reported, never assembled.")) + "</div>" : "") +
    '<div class="grid grid--2" style="margin-top:14px">' +
      panel("Honesty contract", "info", honesty) +
      panel("Video & YouTube tools — " + vt.length, "play", '<div class="panel-bd--flush">' + vrows + "</div>", { flush: true }) +
    "</div>" +
    '<div style="margin-top:14px">' + note("Artifacts are temporary and expiring: retrieved bytes are served from <code class=\"chip-v\">/video-assets/:ref</code> (Range-aware for playback), decoded frames from <code class=\"chip-v\">/screenshots/:id</code>. This page shows pipeline capability, not results — never claim a video was analyzed unless the connected client received real frames or a transcript from the tool.") + "</div>"
  );
}

/* -------------------------------------------------------------- research */

function researchView() {
  var e = S.lazy.expanded, err = S.lazyErr.expanded;
  if (err && !e) return errPanel("Expanded capabilities report unavailable", LAZY_ROUTES.expanded, "expanded", "The report endpoint did not return. Try again or inspect deployment status.");
  var g = e;
  if (!g) return panel("Research capabilities", "search", skeletonPanel(6));

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
  cards += panel("Research tool surface — " + rt.length + " tools", "search", '<div class="panel-bd--flush">' + rt.map(function (t) { return toolRow(t); }).join("") + "</div>", {
    flush: true,
    right: '<button class="btn btn--sm" type="button" data-act="tools-tab">Open explorer</button>'
  });

  return '<div class="stack">' + cards + "</div>" +
    '<div style="margin-top:14px">' + note("Run research from an MCP client — ask it to call <code class=\"chip-v\">web_research</code>, <code class=\"chip-v\">web_extract</code>, <code class=\"chip-v\">feed_read</code> or <code class=\"chip-v\">wayback</code>. This page shows live capability state only; it never fabricates results, sources or timestamps.") + "</div>";
}

/* --------------------------------------------------------------- routing */

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

  return (
    '<div class="grid grid--2">' +
      panel("Decision routing", "branch",
        '<div class="row" style="gap:10px;align-items:baseline"><span class="mono" style="font-size:22px;letter-spacing:-.02em">' + esc(mode) + "</span>" + st("info", "auto: Laya → Jev → deterministic rules") + "</div>" +
        note("Typed decisions are <b>advisory only</b>. Jev and Laya are components of DEMO's decision layer — they can influence which frames to sample or how to split a task, but they never authorize tools, bypass checks or touch credentials.") +
        "<div class=\"note-warn\">DEMO's permissions, confirmations and security policy stay authoritative no matter what a routing answer says.</div>") +
      panel("Configuration — safe metadata only", "key",
        '<div class="panel-bd--flush">' +
        secretRow("Jev (TypeSafe engine)", jev.credentialConfigured, "no credential present on this Worker") +
        secretRow("Laya endpoint", laya.configured, laya.available ? "" : "not bound") +
        secretRow("Laya credential", laya.credentialConfigured, "optional") +
        secretRow("YouTube Data API", sc.youtube ? sc.youtube.available : undefined, "key configured server-side") +
        secretRow("Roblox OAuth client", sc.robloxOAuth ? sc.robloxOAuth.configured : undefined, "id + secret configured server-side") +
        secretRow("Roblox token vault", sc.robloxOAuth ? sc.robloxOAuth.storage === "durable-object" : undefined, sc.robloxOAuth ? "encryption: " + sc.robloxOAuth.tokenEncryption : "") +
        "</div>" +
        '<div class="panel-bd"><div class="hint">These rows read <b>presence booleans</b> from <code class="chip-v">/platform/stats</code>. Secret values live only as Worker secrets — they are never sent to a browser, never logged, never rendered. The private-tool bearer used by <code class="chip-v">roblox_account_*</code> and <code class="chip-v">jev_decide</code> is deliberately not reported publicly.</div></div>',
        { flush: false }) +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:14px">' +
      panel("Jev decision engine", "cpu",
        '<div class="row">' + (jev.available ? st("ok", "Operational") : st("off", "Not configured")) + (jev.enabled ? st("info", "enabled") : "") + "</div>" +
        '<p class="note" style="margin-top:10px">' + esc(jevDetail) + "</p>" +
        '<p class="hint">Full policy: <code class="chip-v">GET /capabilities/jev</code> — presence + policy, never the credential.</p>') +
      panel("Laya decision provider", "layers",
        '<div class="row">' + (laya.available ? st("ok", "Operational") : st("off", "Not configured")) + (laya.configured ? st("info", "endpoint bound") : "") + "</div>" +
        '<p class="note" style="margin-top:10px">' + esc(layaDetail) + "</p>" +
        '<p class="hint">HTTPS-only and SSRF-guarded on every call. Full policy: <code class="chip-v">GET /capabilities/laya</code>.</p>') +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:14px">' +
      panel("Commands — run in your MCP client", "terminal", '<div class="panel-bd--flush">' + commands + "</div>", { flush: true }) +
      panel("Decision tools", "zap", '<div class="panel-bd--flush">' + dt.map(function (t) { return toolRow(t); }).join("") + "</div>", { flush: true }) +
    "</div>"
  );
}

/* ---------------------------------------------------------------- roblox */

function robloxView() {
  var s = robloxState();
  var r = S.roblox;
  var conf = (r && r.configuration) || {};
  var acc = (r && r.account) || null;
  // Connect is offered whenever this browser is not linked and the flow could
  // plausibly work; not-configured / disabled states explain setup instead.
  var canConnect = (s.l === "Not connected" || s.l === "Authorization required" || s.l === "Insufficient scope" || s.l === "Checking");

  var head = '<div class="hero" style="padding:18px 20px">' +
    '<div class="hero-main">' +
      '<div class="eyebrow">Optional external authorization — not a DEMO login</div>' +
      '<h1 style="font-size:20px;margin:6px 0 6px">Roblox account connection</h1>' +
      '<div class="row" style="gap:10px">' + st(s.s, s.l) +
        (acc && acc.username ? '<span class="mono" style="font-size:14px">@' + esc(acc.username) + "</span>" : "") +
      "</div>" +
      (s.s === "err" && S.robloxErr ? note(esc(S.robloxErr.message || "Status could not be read.")) : "") +
      (s.l === "Not configured" && S.robloxErr && S.robloxErr.payload && S.robloxErr.payload.hint ? note("<b>Setup:</b> " + esc(S.robloxErr.payload.hint)) : "") +
      (s.l === "Insufficient scope" ? note("<b>Missing scope:</b> " + esc(s.missing || "a requested scope") + " is not on the granted token. Reconnect and approve every scope — account tools report <code class=\"chip-v\">scope_required</code> until then.") : "") +
      (s.l === "Disabled" && conf.disabledReason ? note(esc(conf.disabledReason)) : "") +
      (s.l === "Not configured" && conf.enabled === false && conf.disabledReason ? note(esc(conf.disabledReason)) : "") +
    "</div>" +
    '<div class="hero-side">' +
      (s.l === "Connected" ? '<button class="btn btn--danger btn--touch" type="button" data-act="roblox-disconnect">' + ic("x") + "Disconnect</button>" :
        canConnect ? '<button class="btn btn--primary btn--touch" type="button" data-act="roblox-connect">' + ic("external") + "Connect Roblox account</button>" : "") +
      '<button class="btn" type="button" data-act="roblox-refresh">' + ic("refresh") + "Re-check status</button>" +
    "</div></div>";

  var connectNote = "";
  if (canConnect) {
    connectNote = note("Connecting opens <b>Roblox's own consent page</b> (OAuth 2.0 + PKCE) in a top-level navigation — no login form here, no password, no cookie ever asked for. DEMO itself has no account system. Tokens stay server-side in the encrypted vault; this page only ever sees the safe status below.");
  } else if (s.l === "Connected") {
    connectNote = note("Linked through Roblox's official OAuth. Identity comes from Roblox's verified userinfo (<code class=\"chip-v\">sub</code> claim), so a rename never breaks the link. Public lookups (<code class=\"chip-v\">roblox_user</code>, <code class=\"chip-v\">roblox_game</code>) work without any connection — they are separate, keyless tools.");
  }

  var details;
  if (r) {
    var sec = r.security || {};
    var ep = r.endpoints || {};
    var rows = [];
    if (acc) {
      rows.push(kv("User id (sub)", '<code class="chip-v">' + esc(acc.userId || "—") + "</code>"));
      rows.push(kv("Granted scopes", (acc.grantedScopes || []).map(function (x) { return '<span class="in-chip">' + esc(x) + "</span>"; }).join(" ") || "—"));
      rows.push(kv("Expiry", '<span class="mono">' + esc(fmtTs(acc.accessTokenExpiresAt)) + "</span>", acc.canRefresh ? "refresh available" : "cannot refresh"));
      if (acc.sessionExpiresAt) rows.push(kv("Session valid until", '<span class="mono">' + esc(fmtTs(acc.sessionExpiresAt)) + "</span>"));
      if (acc.reauthorizationRequired && acc.reauthorizationReason) rows.push(kv("Re-authorization", st("warn", "Required"), esc(acc.reauthorizationReason)));
    }
    rows.push(kv("Flow", st("ok", "OAuth 2.0 + PKCE " + (conf.pkce || "S256"))));
    rows.push(kv("State validation", '<span class="hint">' + esc(sec.stateValidation || "single-use, expiring, browser-bound") + "</span>"));
    rows.push(kv("Cookie flags", '<code class="chip-v">' + esc(sec.cookieFlags || "HttpOnly; Secure; SameSite=Lax") + "</code>"));
    rows.push(kv("Token storage", conf.storage === "durable-object" ? st("ok", "Durable Object · encrypted at rest") : st("warn", "Isolate memory (temporary)"), esc(conf.tokenEncryptionReason || conf.tokenEncryption || "")));
    rows.push(kv("Client credentials", (conf.clientIdConfigured ? st("ok", "id present") : st("off", "id missing")) + " " + (conf.clientSecretConfigured ? st("ok", "secret present") : st("off", "secret missing"))));
    rows.push(kv("Requested scopes", (conf.requestedScopes || []).map(function (x) { return '<span class="in-chip">' + esc(x) + "</span>"; }).join(" ") || "—"));
    rows.push(kv("Tokens exposed to this page", boolSt(false, "", "Never")));
    if (conf.redirectUri) rows.push(kv("Redirect URI to register", '<span class="copy-inline"><code class="chip-v">' + esc(conf.redirectUri) + '</code><button class="btn btn--sm" type="button" data-act="copy" data-copy="' + esc(conf.redirectUri) + '">' + ic("copy", 13) + "Copy</button></span>", "at create.roblox.com"));
    if (ep.start) rows.push(kv("Start route", '<code class="chip-v">' + esc(ep.start) + "</code>"));
    details = panel("Connection details", "shield", '<div class="panel-bd--flush">' + rows.join("") + "</div>", { flush: true });
  } else if (S.robloxLoading) {
    details = panel("Connection details", "shield", skeletonPanel(5));
  } else {
    var p = (S.robloxErr && S.robloxErr.payload) || {};
    details = panel("What this means", "info",
      note(esc(p.message || (S.robloxErr && S.robloxErr.message) || "The Roblox status route did not answer.")) +
      (p.hint ? note("<b>Hint:</b> " + esc(p.hint)) : "") +
      note("Roblox is optional infrastructure. Every other DEMO capability — browser, video, research, skills, utilities — works without it, and none of them require any account."));
  }

  var rtools = CAT.filter(function (t) { return t.group === "Roblox"; });

  return '<div style="margin-bottom:14px">' + head + "</div>" + connectNote +
    '<div style="margin-top:14px">' + details + "</div>" +
    '<div style="margin-top:14px">' + panel("Roblox tools", "game", '<div class="panel-bd--flush">' + rtools.map(function (t) { return toolRow(t); }).join("") + "</div>", { flush: true }) + "</div>";
}

/* ---------------------------------------------------------------- skills */

function skillsView() {
  var cards = (DATA.BUILTIN_SKILLS || []).map(function (sk) {
    return panel(sk.title, "zap",
      '<div class="row" style="justify-content:space-between"><span class="mono muted">' + esc(sk.name) + '</span><span class="row" style="gap:6px">' + st("ok", "bundled") + '<code class="chip-v">' + esc(sk.invoke) + "</code></span></div>" +
      note(esc(sk.description)) +
      '<div class="row" style="margin-top:10px;justify-content:space-between">' +
        '<span class="hint">' + esc(sk.note || "") + (sk.license ? " · " + esc(sk.license) : "") + "</span>" +
        (sk.source ? '<a class="btn btn--sm" href="' + esc(sk.source) + '" target="_blank" rel="noreferrer noopener">' + ic("external", 13) + esc(sk.sourceLabel || "source") + "</a>" : "") +
      "</div>");
  }).join('<div style="height:14px"></div>');

  var skt = CAT.filter(function (t) { return t.group === "Skills"; });

  return '<div class="grid grid--2">' + cards + "</div>" +
    '<div style="margin-top:14px">' + panel("skills.sh surface — via MCP tools", "layers",
      '<div class="panel-bd"><p class="note">Live search, browse, retrieval and security audit run through the <b>skills_* tools over /mcp</b> against the public skills.sh catalog. No account, no local install, no execution: skill text is returned for review, and the <code class="chip-v">npx skills add …</code> line is printed, never run.</p>' +
      '<div class="row" style="margin-top:10px"><button class="btn btn--sm" type="button" data-act="skills-tools">' + ic("search", 13) + "Search & browse skills tools</button>" +
      '<span class="hint">' + skt.length + " skill tools · filterable with the live availability of each</span></div></div>" +
      '<div class="panel-bd--flush">' + skt.map(function (t) { return toolRow(t); }).join("") + "</div>", { flush: true }) + "</div>";
}

/* ----------------------------------------------------------------- about */

function aboutView() {
  var proj = DATA.PROJECT || {};
  var routes = (DATA.API_ROUTES || []).map(function (rt) {
    return kv(rt.path, '<span class="d">' + esc(rt.note) + "</span>");
  }).join("");
  var priv = (DATA.PRIVACY_FACTS || []).map(function (p) {
    return '<li><span class="li-k">' + esc(p) + "</span></li>";
  }).join("");
  var s1 = S.stats;
  var info =
    kv("Repository", proj.repoUrl ? '<a href="' + esc(proj.repoUrl) + '" target="_blank" rel="noreferrer noopener">' + esc(proj.repoLabel || proj.repoUrl) + "</a>" : "—") +
    kv("Runtime", '<span class="hint">Cloudflare Workers · Durable Objects · R2 · Browser Rendering · Workers AI</span>') +
    kv("Version", '<code class="chip-v">' + esc((s1 && s1.version) || VERSION || "—") + "</code>") +
    kv("MCP endpoint", '<span class="copy-inline"><code class="chip-v">' + esc(ENDPOINT) + '</code><button class="btn btn--sm" type="button" data-act="copy" data-copy="' + esc(ENDPOINT) + '">' + ic("copy", 13) + "Copy</button></span>") +
    kv("Tools", (s1 ? s1.toolCount : CAT.length) + " registered on /mcp") +
    kv("Docs", (proj.docsTreeUrl ? '<a href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">docs/ in the repository</a>' : "—") + (proj.readmeUrl ? ' · <a href="' + esc(proj.readmeUrl) + '" target="_blank" rel="noreferrer noopener">README</a>' : ""));

  return (
    '<div class="hero" style="flex-direction:column;gap:10px">' +
      '<div class="eyebrow">' + esc(proj.name || "DEMO") + "</div>" +
      "<h1>" + esc(proj.tagline || "The open execution layer") + "</h1>" +
      "<p>" + esc(proj.blurb || "") + "</p>" +
      '<div class="row">' +
        '<button class="btn btn--primary" type="button" data-act="connect-open">' + ic("plug") + "Connect MCP</button>" +
        (proj.repoUrl ? '<a class="btn" href="' + esc(proj.repoUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("code") + "Source repository</a>" : "") +
        (proj.docsTreeUrl ? '<a class="btn" href="' + esc(proj.docsTreeUrl) + '" target="_blank" rel="noreferrer noopener">' + ic("book") + "Documentation</a>" : "") +
      "</div>" +
    "</div>" +
    '<div class="grid grid--2" style="margin-top:14px">' +
      panel("Project", "info", '<div class="panel-bd--flush">' + info + "</div>", { flush: true }) +
      panel("Security & privacy", "shield", '<ul class="list">' + priv + "</ul>", { flush: true }) +
    "</div>" +
    '<div style="margin-top:14px">' + panel("This Worker's routes", "terminal", '<div class="panel-bd--flush">' + routes + "</div>", { flush: true }) + "</div>" +
    '<div style="margin-top:14px">' + panel("Architecture", "layers",
      '<pre class="codeblock">' + esc(DATA.ARCHITECTURE_TEXT || "") + "</pre>" +
      note("DEMO is open source: read it, self-host it, extend it. The inspector you are using is served by the same Worker as <code class=\"chip-v\">/mcp</code> — one deployment, no separate control plane, no login.")) +
    "</div>"
  );
}

/* --------------------------------------------------------- connect modal */

function connectModalBody() {
  return '<div class="modal-hd">' + ic("plug") + '<h3 id="connect-title">Connect DEMO</h3>' +
    '<button class="btn btn--icon x" type="button" data-act="connect-close" aria-label="Close dialog">' + ic("x") + "</button></div>" +
    '<div class="modal-bd">' +
      '<p class="modal-instruction">Put this in the AI plugins</p>' +
      '<div class="endpoint"><code id="mcp-endpoint" tabindex="0">' + esc(ENDPOINT) + "</code>" +
      '<button class="btn btn--primary" type="button" id="copy-endpoint" data-act="copy" data-copy="' + esc(ENDPOINT) + '" data-swap="Copied!">' + ic("copy") + "Copy</button></div>" +
      '<p class="modal-note"><b>No DEMO account required.</b> The endpoint works with any MCP client — no login, no onboarding, nothing to install.</p>' +
    "</div>" +
    '<div class="modal-ft">' + ic("shield") + "<span>Public endpoint · requests go straight to this Worker</span></div>";
}

/* ------------------------------------------------------- command palette */

function paletteItems() {
  var items = [];
  var secs = DATA.SECTIONS || [];
  for (var i = 0; i < secs.length; i++) {
    (function (s) {
      items.push({ label: s.label, hint: s.blurb || "section", icon: s.icon, run: function () { go(s.id); } });
    })(secs[i]);
  }
  items.push({ label: "Copy MCP endpoint", hint: "clipboard", icon: "copy", run: function () { copyText(ENDPOINT, true); } });
  items.push({ label: "Connect MCP — show dialog", hint: "modal", icon: "plug", run: function () { openConnect(); } });
  items.push({ label: "Refresh telemetry", hint: "re-fetch", icon: "refresh", run: function () { loadCore(true); loadRoblox(true); } });
  items.push({ label: "Tool explorer", hint: CAT.length + " tools", icon: "search", run: function () { go("tools"); setTimeout(function () { var el = qs("#tool-search"); if (el) el.focus(); }, 60); } });
  var cmds = DATA.MCP_COMMANDS || [];
  for (var j = 0; j < cmds.length; j++) {
    (function (cmd) {
      items.push({ label: "Command " + cmd.name, hint: "via MCP", icon: "terminal", run: function () { go(cmd.name === "/mcp" ? "overview" : "routing"); } });
    })(cmds[j]);
  }
  if (DATA.PROJECT && DATA.PROJECT.repoUrl) items.push({ label: "Open source repository", hint: "new tab", icon: "code", run: function () { window.open(DATA.PROJECT.repoUrl, "_blank", "noopener"); } });
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
    if (!q || (it.label + " " + (it.hint || "")).toLowerCase().indexOf(q) !== -1) items.push(it);
  }
  if (S.pSel >= items.length) S.pSel = items.length ? items.length - 1 : 0;
  if (S.pSel < 0) S.pSel = 0;
  if (!items.length) {
    box.innerHTML = '<div class="p-empty">Nothing matches that.</div>';
    S.pItems = [];
    return;
  }
  var html = "";
  for (var k = 0; k < items.length; k++) {
    var m = items[k];
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

/* ------------------------------------------------------------- overlays */

function openOverlay(overlaySel, focusSel) {
  var ov = qs(overlaySel);
  if (!ov) return;
  S.lastFocus = document.activeElement;
  ov.hidden = false;
  document.addEventListener("keydown", overlayKeys, true);
  var f = qs(focusSel || "input, button", ov);
  if (f) f.focus();
}
function closeOverlays() {
  var a = qs("#connect-overlay"), b = qs("#palette-overlay");
  if (a) a.hidden = true;
  if (b) b.hidden = true;
  S.modalOpen = false;
  S.paletteOpen = false;
  document.removeEventListener("keydown", overlayKeys, true);
  if (S.lastFocus && S.lastFocus.focus) { try { S.lastFocus.focus(); } catch (e) { /* noop */ } }
  S.lastFocus = null;
}
function openConnect() {
  S.modalOpen = true;
  openOverlay("#connect-overlay", "#copy-endpoint");
}
function openPalette() {
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
    if (!scope) return;
    var f = qsa('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])', scope);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    return;
  }
  if (S.paletteOpen) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); S.pSel++; renderPalette(); var e1 = qs("#p-opt-" + S.pSel); if (e1 && e1.scrollIntoView) e1.scrollIntoView({ block: "nearest" }); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); S.pSel = Math.max(0, S.pSel - 1); renderPalette(); var e2 = qs("#p-opt-" + S.pSel); if (e2 && e2.scrollIntoView) e2.scrollIntoView({ block: "nearest" }); }
    else if (ev.key === "Enter") { ev.preventDefault(); runPalette(S.pSel); }
  }
}

/* ---------------------------------------------------------------- toast */

function toast(msg) {
  var box = qs("#toasts");
  if (!box) return;
  var el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = ic("checkc") + "<span>" + esc(msg) + "</span>";
  box.appendChild(el);
  setTimeout(function () { el.style.opacity = "0"; el.style.transition = "opacity 160ms"; }, 1900);
  setTimeout(function () { el.remove(); }, 2150);
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

/* ------------------------------------------------------------ data loads */

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
    renderShellNav();
  });
  return S.core;
}

function loadRoblox(force) {
  if (S.roblox && !force) return Promise.resolve();
  if (S.robloxInflight) return Promise.resolve();
  S.robloxInflight = true;
  S.robloxLoading = true;
  return jfetch("/oauth/roblox/status").then(function (d) {
    S.roblox = d;
    S.robloxErr = null;
  }, function (e) {
    S.robloxErr = e;
    S.roblox = null;
  }).then(function () {
    S.robloxLoading = false;
    S.robloxInflight = false;
    renderView();
    renderShellNav();
    renderFoot();
  });
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
    if (S.route === "video" || S.route === "research") renderView();
  });
}

/* ---------------------------------------------------------------- events */

document.addEventListener("click", function (ev) {
  var t = ev.target;
  if (!t || !t.closest) return;

  var navLink = t.closest("a[data-route]");
  if (navLink) {
    body().classList.remove("drawer");
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

  if (act === "tools-tab") go("tools");
  else if (act === "skills-tools") { S.tf.group = "Skills"; S.tf.avail = ""; S.tf.q = ""; go("tools"); }
  else if (act === "open-tool") {
    var nm = el.getAttribute("data-name");
    if (S.route !== "tools") {
      S.tf.group = "";
      S.tf.avail = "";
      S.tf.q = "";
      S.openTool = nm;
      go("tools");
    } else {
      S.openTool = S.openTool === nm ? null : nm;
      renderView();
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
  else if (act === "palette-open") openPalette();
  else if (act === "palette-close") closeOverlays();
  else if (act === "filter-group") {
    S.tf.group = S.tf.group === el.getAttribute("data-g") ? "" : el.getAttribute("data-g");
    renderView();
  }
  else if (act === "filter-avail") {
    S.tf.avail = S.tf.avail === el.getAttribute("data-a") ? "" : el.getAttribute("data-a");
    renderView();
  }
  else if (act === "refresh") {
    loadCore(true);
    loadRoblox(true);
    toast("Refreshing telemetry…");
  }
  else if (act === "retry") {
    var key = el.getAttribute("data-key");
    if (!key || key === "core") { S.core = null; loadCore(true); }
    else { S.lazyErr[key] = null; S.lazy[key] = null; loadLazy(key); }
  }
  else if (act === "collapse") {
    body().classList.toggle("rail");
    try { localStorage.setItem("demo-rail", body().classList.contains("rail") ? "1" : "0"); } catch (e) { /* noop */ }
  }
  else if (act === "drawer-open") {
    body().classList.add("drawer");
    var fi = qs("#sidebar a");
    if (fi) fi.focus();
  }
  else if (act === "drawer-close") body().classList.remove("drawer");
  else if (act === "roblox-connect") { location.href='/oauth/roblox/start'; }
  else if (act === "roblox-disconnect") {
    el.disabled = true;
    jfetch("/oauth/roblox/logout", { method: "POST" }).then(function () {
      toast("Disconnected from Roblox.");
    }, function (e) {
      toast("Disconnect failed: " + (e.message || "unknown error"));
    }).then(function () {
      S.roblox = null;
      return loadRoblox(true);
    }).then(function () { el.disabled = false; });
  }
  else if (act === "roblox-refresh") {
    S.roblox = null;
    renderView();
    loadRoblox(true);
  }
});

document.addEventListener("input", function (ev) {
  var el = ev.target;
  if (!el) return;
  if (el.id === "tool-search") {
    S.tf.q = el.value;
    // scoped update: keep the input (focus, caret, mobile keyboard) alive
    var rowsBox = qs("#tool-rows");
    if (rowsBox) rowsBox.innerHTML = toolsRowsHtml();
    else { renderView(); return; }
    var count = qs("#tool-count");
    if (count) {
      var n = filteredTools().length;
      count.textContent = n + " shown · " + (S.stats ? S.stats.toolCount + " live on /mcp" : CAT.length + " in catalog");
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
  } else if (ev.key === "Escape" && !S.modalOpen && !S.paletteOpen && body().classList.contains("drawer")) {
    body().classList.remove("drawer");
  }
});

window.addEventListener("hashchange", function () {
  var next = routeFromHash();
  if (next !== S.route) { S.route = next; S.openTool = null; }
  renderView();
  enterRoute();
});

/* ------------------------------------------------------------------ boot */

function enterRoute() {
  if (S.route === "roblox" && !S.roblox && !S.robloxErr) loadRoblox();
  if (S.route === "video") loadLazy("video");
  if (S.route === "research") loadLazy("expanded");
}

function boot() {
  try {
    if (localStorage.getItem("demo-rail") === "1" && window.matchMedia && window.matchMedia("(min-width: 901px)").matches) body().classList.add("rail");
  } catch (e) { /* noop */ }
  S.route = routeFromHash();
  renderShell();
  renderView();
  loadCore(false);
  loadRoblox(false);
  enterRoute();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();`;
