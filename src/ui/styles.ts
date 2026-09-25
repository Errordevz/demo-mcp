/**
 * DEMO inspector UI — design system CSS.
 *
 * Dark-first developer-tool aesthetic: near-black canvas, slightly lighter
 * surfaces, subtle 1px borders, restrained single accent, high-contrast text,
 * monospace for technical values, compact density. Everything is inlined into
 * the one self-contained HTML document the Worker serves (the CSP forbids any
 * external resource, and that lockdown is deliberate).
 */
export const UI_CSS = String.raw`
:root {
  color-scheme: dark;
  --bg: #0a0b0e;
  --bg-deep: #07080a;
  --surface: #0e1014;
  --surface-2: #12151a;
  --surface-3: #171b21;
  --border: #1d222a;
  --border-2: #262d37;
  --border-3: #333c49;
  --text: #e7ebf1;
  --dim: #98a2b0;
  --faint: #6a7382;
  --accent: #5ba8f7;
  --accent-strong: #7cbcff;
  --ok: #3ddc97;
  --warn: #f5c04a;
  --err: #f2777a;
  --off: #5d6673;
  --ring: rgba(91, 168, 247, .65);
  --r-sm: 6px; --r-md: 8px; --r-lg: 12px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --shadow-md: 0 10px 30px -14px rgba(0, 0, 0, .8);
  --t-fast: 120ms cubic-bezier(.2, .6, .3, 1);
}
* { box-sizing: border-box }
html { -webkit-text-size-adjust: 100% }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
  font: 13.5px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
::selection { background: rgba(91, 168, 247, .28) }
a { color: var(--accent-strong); text-decoration: none }
a:hover { text-decoration: underline }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px }
button { font: inherit; color: inherit }
svg { flex: none }
.skip {
  position: fixed; left: 12px; top: -48px; z-index: 90; background: var(--surface-2);
  border: 1px solid var(--border-2); border-radius: var(--r-md); padding: 8px 14px; color: var(--text);
  transition: top var(--t-fast);
}
.skip:focus { top: 12px }
.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap }

/* ------------------------------------------------------------------ shell */
.layout { display: flex; min-height: 100vh }
.sidebar {
  width: 234px; flex: none; display: flex; flex-direction: column; gap: 2px;
  border-right: 1px solid var(--border); background: var(--bg-deep);
  position: sticky; top: 0; height: 100vh; padding: 14px 10px 10px; z-index 30;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 2px 6px 12px }
.brand-mark {
  width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center;
  background: #eef1f5; color: #0a0c10; font-weight: 800; font-size: 15px; letter-spacing: -.02em;
}
.brand-name { font-weight: 750; font-size: 14.5px; letter-spacing: -.01em }
.brand-sub { font-size: 10.5px; color: var(--faint); letter-spacing: .12em; text-transform: uppercase }
.nav { display: flex; flex-direction: column; gap: 1px; min-height: 0; flex: 1; overflow-y: auto }
.nav-sec { font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); padding: 12px 10px 5px }
.nav a {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: var(--r-md);
  color: var(--dim); font-weight: 550; font-size: 13px; position: relative;
  transition: background var(--t-fast), color var(--t-fast);
}
.nav a:hover { background: var(--surface-2); color: var(--text); text-decoration: none }
.nav a[aria-current="page"] { background: var(--surface-3); color: var(--text); box-shadow: inset 2px 0 0 var(--accent) }
.nav a svg { width: 15px; height: 15px; opacity: .8 }
.nav .nav-flag { margin-left: auto; display: inline-flex }
.side-foot { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 6px; display: flex; flex-direction: column; gap: 6px }
.side-note { font-size: 11px; color: var(--faint); line-height: 1.5; padding: 0 4px }
.side-note b { color: var(--dim); font-weight: 600 }
.collapse-btn {
  align-self: flex-end; background: none; border: 1px solid var(--border); border-radius: var(--r-sm);
  color: var(--faint); width: 26px; height: 26px; display: grid; place-items: center; cursor: pointer;
}
.collapse-btn:hover { color: var(--text); background: var(--surface-2) }
body.rail .sidebar { width: 58px; padding-left: 8px; padding-right: 8px }
body.rail .nav a { justify-content: center; padding: 9px 0 }
body.rail .nav a .lbl, body.rail .brand-text, body.rail .nav-sec, body.rail .side-note, body.rail .nav .nav-flag { display: none }
body.rail .brand { justify-content: center; padding: 2px 0 12px }
body.rail .collapse-btn { align-self: center }

.main-col { flex: 1; min-width: 0; display: flex; flex-direction: column }
.topbar {
  position: sticky; top: 0; z-index: 25; display: flex; align-items: center; gap: 10px;
  min-height: 54px; padding: 8px 20px; border-bottom: 1px solid var(--border); background: rgba(10, 11, 14, .92);
}
.menu-btn { display: none; background: none; border: 1px solid var(--border); border-radius: var(--r-sm); width: 34px; height: 34px; place-items: center; cursor: pointer; color: var(--dim) }
.menu-btn:hover { color: var(--text) }
.topbar h2 { margin: 0; font-size: 14.5px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.topbar .tb-sub { color: var(--faint); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.topbar .grow { flex: 1 }
.topbar-actions { display: flex; align-items: center; gap: 8px; flex: none }
.content { width: 100%; max-width: 1180px; margin: 0 auto; padding: 22px 24px 64px; min-width: 0 }
.foot {
  border-top: 1px solid var(--border); padding: 12px 24px; color: var(--faint); font-size: 11.5px;
  display: flex; gap: 14px; flex-wrap: wrap; align-items: center; background: var(--bg-deep);
}
.foot .mono { font-size: 11px }

/* ---------------------------------------------------------------- buttons */
.btn {
  height: 32px; padding: 0 13px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--border-2); border-radius: var(--r-md);
  color: var(--text); font-weight: 600; font-size: 12.5px; white-space: nowrap; user-select: none;
  transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
}
.btn:hover { background: var(--surface-3); border-color: var(--border-3) }
.btn:active { transform: translateY(1px) }
.btn:disabled { opacity: .55; cursor: default; transform: none }
.btn svg { width: 14px; height: 14px }
.btn--primary { background: #e9edf3; color: #0b0d10; border-color: #e9edf3 }
.btn--primary:hover { background: #fff; border-color: #fff }
.btn--danger { color: #f6a9ab; border-color: rgba(242, 119, 122, .4) }
.btn--danger:hover { background: rgba(242, 119, 122, .08); border-color: rgba(242, 119, 122, .55) }
.btn--sm { height: 27px; padding: 0 9px; font-size: 11.5px; border-radius: var(--r-sm) }
.btn--icon { width: 32px; padding: 0; justify-content: center }
.btn--touch { min-height: 42px }
.link-btn { background: none; border: 0; padding: 0; color: var(--accent-strong); cursor: pointer; font-size: inherit }
.link-btn:hover { text-decoration: underline }

/* ----------------------------------------------------------------- panels */
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow-md) }
.panel + .panel, .grid + .panel, .panel + .grid { margin-top: 14px }
.panel-hd { display: flex; align-items: center; gap: 9px; padding: 11px 14px; border-bottom: 1px solid var(--border) }
.panel-hd svg.hd-ic { width: 15px; height: 15px; color: var(--faint) }
.panel-hd h3 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: -.005em }
.panel-hd .hd-note { margin-left: auto; color: var(--faint); font-size: 11.5px; display: flex; gap: 8px; align-items: center }
.panel-bd { padding: 12px 14px }
.panel-bd--flush { padding: 0 }
.grid { display: grid; gap: 14px }
.grid--2 { grid-template-columns: 1fr 1fr }
.grid--3 { grid-template-columns: repeat(3, 1fr) }
.grid--status { grid-template-columns: 1fr 1fr }
.grid + .grid, .panel + .grid { margin-top: 14px }
.eyebrow { font-size: 10.5px; letter-spacing: .17em; text-transform: uppercase; color: var(--faint); font-weight: 650 }
.muted { color: var(--dim) }
.faint { color: var(--faint) }
.small { font-size: 12px }
.hint { font-size: 11.5px; color: var(--faint); line-height: 1.5 }
.stack { display: flex; flex-direction: column; gap: 14px }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
.pill-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px }

/* hero ------------------------------------------------------------------ */
.hero {
  border: 1px solid var(--border); border-radius: var(--r-lg); background:
    radial-gradient(120% 160% at 0% 0%, #131926 0%, rgba(19, 25, 38, 0) 55%), var(--surface);
  padding: 22px 24px; display: flex; gap: 22px; align-items: flex-start; flex-wrap: wrap;
}
.hero-main { flex: 1; min-width: 280px }
.hero h1 { margin: 8px 0 8px; font-size: 25px; line-height: 1.18; letter-spacing: -.03em; font-weight: 750 }
.hero p { margin: 0 0 14px; color: var(--dim); max-width: 60ch; line-height: 1.6 }
.hero-side { display: flex; flex-direction: column; gap: 9px; align-items: stretch; min-width: 236px }
.hero-side .btn { justify-content: center; height: 38px; font-size: 13.5px }
.hero-fine { text-align: center; font-size: 11px; color: var(--faint) }

/* status ---------------------------------------------------------------- */
.st {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 650; line-height: 1.3;
  padding: 2.5px 8px 2.5px 6.5px; border-radius: 999px; border: 1px solid var(--border-2);
  background: var(--surface-2); color: var(--dim); white-space: nowrap;
}
.st svg { width: 12px; height: 12px }
.st--ok { color: var(--ok); border-color: rgba(61, 220, 151, .35); background: rgba(61, 220, 151, .07) }
.st--warn { color: var(--warn); border-color: rgba(245, 192, 74, .35); background: rgba(245, 192, 74, .07) }
.st--err { color: var(--err); border-color: rgba(242, 119, 122, .35); background: rgba(242, 119, 122, .07) }
.st--info { color: var(--accent-strong); border-color: rgba(91, 168, 247, .35); background: rgba(91, 168, 247, .07) }
.st--off { color: var(--off) }
.st--idle { color: var(--dim) }
.st--dot::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block }
.st--dot { padding-left: 16px }
.tbl-wrap { overflow-x: auto }

.kv { display: grid; grid-template-columns: minmax(110px, 168px) 1fr auto; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid #14181e }
.kv:last-child { border-bottom: 0 }
.kv .k { color: var(--dim); font-size: 12.5px; min-width: 0 }
.kv .v { min-width: 0; text-align: right; display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap }
.kv .d { color: var(--faint); font-size: 11.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px }
.tbl th { text-align: left; font-weight: 600; color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: .12em; padding: 8px 14px; border-bottom: 1px solid var(--border) }
.tbl td { padding: 8px 14px; border-bottom: 1px solid #14181e; vertical-align: top }
.tbl tr:last-child td { border-bottom: 0 }
.tbl td.t-r, .tbl th.t-r { text-align: right }
ul.list { margin: 0; padding: 0; list-style: none }
ul.list li { padding: 7px 14px; border-bottom: 1px solid #14181e; display: flex; gap: 10px; align-items: baseline; min-width: 0 }
ul.list li:last-child { border-bottom: 0 }
ul.list li .li-k { color: var(--dim); flex: 1; min-width: 0 }
ul.bullets { margin: 0; padding-left: 18px; color: var(--dim) }
ul.bullets li { margin: 4px 0; line-height: 1.55 }

/* mono / code ------------------------------------------------------------- */
.mono, code { font-family: var(--mono); font-size: 12px; letter-spacing: -.01em }
code.chip-v { background: #0a0c10; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 1.5px 6px; color: #c9d4e2; user-select: all; -webkit-user-select: all; word-break: break-all }
pre.codeblock {
  margin: 0; padding: 12px 14px; background: var(--bg-deep); border: 1px solid var(--border); border-radius: var(--r-md);
  font-family: var(--mono); font-size: 11.5px; line-height: 1.6; color: var(--dim); overflow-x: auto;
}
.copy-inline { display: inline-flex; gap: 6px; align-items: center }

/* tools explorer ---------------------------------------------------------- */
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px }
.search { position: relative; flex: 1; min-width: 200px; max-width: 420px }
.search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--faint); pointer-events: none }
.search input {
  width: 100%; height: 34px; background: var(--bg-deep); border: 1px solid var(--border-2); border-radius: var(--r-md);
  color: var(--text); padding: 0 10px 0 30px; outline: none; font-size: 13px;
}
.search input:focus-visible { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px rgba(91, 168, 247, .18) }
.chips { display: flex; gap: 6px; flex-wrap: wrap }
.chip {
  font-size: 11.5px; font-weight: 550; padding: 4.5px 10px; border-radius: 999px; border: 1px solid var(--border-2);
  background: transparent; color: var(--dim); cursor: pointer; transition: all var(--t-fast); white-space: nowrap;
}
.chip:hover { color: var(--text); border-color: var(--border-3) }
.chip[aria-pressed="true"] { background: var(--surface-3); border-color: var(--border-3); color: var(--text) }
.chip .cnt { color: var(--faint); margin-left: 5px; font-size: 10.5px }
.tcount { color: var(--faint); font-size: 11.5px; margin-left: auto }
.trow { display: grid; grid-template-columns: 22px minmax(150px, .9fr) minmax(0, 1.4fr) auto 18px; gap: 12px; align-items: center; padding: 8.5px 14px; border-bottom: 1px solid #14181e; cursor: pointer; background: none; border-left: 0; border-right: 0; border-top: 0; width: 100%; text-align: left }
.trow:hover { background: var(--surface-2) }
.trow[aria-expanded="true"] { background: var(--surface-2) }
.trow .tname { font-family: var(--mono); font-size: 12.5px; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.trow .tdesc { color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0 }
.trow .tgrp { font-size: 10.5px; color: var(--dim); border: 1px solid var(--border-2); border-radius: var(--r-sm); padding: 1px 7px; white-space: nowrap }
.trow .tw { display: grid; place-items: center; color: var(--faint) }
.trow .tw svg { width: 14px; height: 14px; transition: transform var(--t-fast) }
.trow[aria-expanded="true"] .tw svg { transform: rotate(90deg) }
.tdetail { padding: 12px 16px 14px; border-bottom: 1px solid var(--border); background: #0b0d11 }
.tdetail .tdesc-full { color: var(--dim); font-size: 12.5px; line-height: 1.6; margin: 0 0 10px }
.tdetail h4 { margin: 10px 0 6px; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--faint) }
.in-chip { font-family: var(--mono); font-size: 11px; color: #b9c6d6; background: #0f1318; border: 1px solid var(--border-2); border-radius: var(--r-sm); padding: 2px 7px }
.tfoot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px }

/* browser / pipeline flows */
.flow { display: flex; flex-direction: column }
.flow-step { display: flex; gap: 12px; padding: 9px 14px; border-bottom: 1px solid #14181e; align-items: flex-start }
.flow-step:last-child { border-bottom: 0 }
.flow-num { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border-3); color: var(--dim); font-size: 10.5px; display: grid; place-items: center; font-family: var(--mono); margin-top: 1px }
.flow-txt { min-width: 0; flex: 1 }
.flow-txt code { color: var(--accent-strong) }
.flow-txt .fx-d { color: var(--faint); font-size: 12px; line-height: 1.5 }
.bar { height: 5px; border-radius: 3px; background: var(--surface-3); overflow: hidden; margin: 6px 0 2px }
.bar > i { display: block; height: 100%; background: var(--accent); border-radius: 3px }

/* modal ------------------------------------------------------------------ */
.overlay {
  position: fixed; inset: 0; z-index: 70; background: rgba(5, 6, 8, .72);
  display: grid; place-items: center; padding: 20px;
}
.overlay[hidden] { display: none }
.modal {
  width: min(540px, 100%); background: #101318; border: 1px solid var(--border-2); border-radius: var(--r-lg);
  box-shadow: 0 24px 70px -18px rgba(0, 0, 0, .9); display: flex; flex-direction: column; max-height: calc(100vh - 40px);
  animation: pop var(--t-fast);
}
.modal-hd { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border) }
.modal-hd h3 { margin: 0; font-size: 14.5px; font-weight: 720 }
.modal-hd .x { margin-left: auto }
.modal-bd { padding: 16px; overflow-y: auto }
.modal-ft { padding: 11px 16px; border-top: 1px solid var(--border); display: flex; gap: 10px; align-items: center; color: var(--faint); font-size: 11.5px }
.modal-instruction { font-size: 13px; color: var(--dim); margin: 0 0 10px }
.endpoint {
  display: flex; align-items: center; gap: 10px; background: var(--bg-deep); border: 1px solid var(--border-2);
  border-radius: var(--r-md); padding: 12px 13px;
}
.endpoint:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(91, 168, 247, .15) }
.endpoint code {
  flex: 1; min-width: 0; font-size: 13.5px; color: var(--text); background: none; border: 0; padding: 0;
  user-select: all; -webkit-user-select: all; word-break: break-all; line-height: 1.45;
}
.endpoint .btn { height: 34px; flex: none }
.modal-note { margin-top: 12px; font-size: 12px; color: var(--faint); line-height: 1.55 }
.modal-note b { color: var(--dim); font-weight: 600 }

/* command palette --------------------------------------------------------- */
.palette {
  width: min(600px, 100%); background: #101318; border: 1px solid var(--border-2); border-radius: var(--r-lg);
  box-shadow: 0 24px 70px -18px rgba(0, 0, 0, .9); overflow: hidden; display: flex; flex-direction: column;
  max-height: min(70vh, 540px); animation: pop var(--t-fast);
}
.palette .p-search { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border) }
.palette .p-search svg { width: 15px; height: 15px; color: var(--faint) }
.palette .p-search input { flex: 1; background: none; border: 0; outline: none; color: var(--text); font-size: 14.5px; min-width: 0 }
.palette .p-results { overflow-y: auto; padding: 6px }
.p-item { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; background: none; border: 0; border-radius: var(--r-md); padding: 8px 10px; cursor: pointer; color: var(--dim) }
.p-item svg { width: 15px; height: 15px; color: var(--faint) }
.p-item .p-lbl { color: var(--text); font-size: 13px; font-weight: 550; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.p-item .p-kind { margin-left: auto; font-size: 10.5px; color: var(--faint); letter-spacing: .06em; text-transform: uppercase; flex: none }
.p-item[aria-selected="true"], .p-item:hover { background: var(--surface-3); color: var(--text) }
.p-empty { padding: 22px 14px; text-align: center; color: var(--faint); font-size: 12.5px }
kbd { font-family: var(--mono); font-size: 10.5px; color: var(--dim); background: var(--surface-2); border: 1px solid var(--border-2); border-bottom-width: 2px; border-radius: 5px; padding: 1.5px 5px; line-height: 1.4 }

/* toasts, skel, states ---------------------------------------------------- */
.toasts { position: fixed; bottom: 16px; right: 16px; z-index: 95; display: flex; flex-direction: column; gap: 8px; pointer-events: none }
.toast {
  display: flex; align-items: center; gap: 8px; background: #14181f; border: 1px solid var(--border-2); border-radius: var(--r-md);
  padding: 8px 12px; font-size: 12.5px; color: var(--text); box-shadow: var(--shadow-md); animation: pop var(--t-fast);
}
.toast svg { width: 14px; height: 14px; color: var(--ok) }
.skel { border-radius: 6px; background: linear-gradient(90deg, #10141a 25%, #171c24 50%, #10141a 75%); background-size: 200% 100%; animation: shimmer 1.3s infinite linear; height: 12px; margin: 7px 0 }
.skel--lg { height: 64px }
.err-card { border-color: rgba(242, 119, 122, .3) }
.err-card .panel-hd { border-bottom-color: rgba(242, 119, 122, .18) }
.note { font-size: 12px; color: var(--dim); line-height: 1.6 }
.note-warn { border: 1px solid rgba(245, 192, 74, .25); background: rgba(245, 192, 74, .05); border-radius: var(--r-md); padding: 10px 12px; font-size: 12px; color: #e5d3a1; line-height: 1.55 }
.badge-secure { display: inline-flex; gap: 6px; align-items: center; font-size: 11px; color: var(--dim); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px }
.badge-secure svg { width: 12px; height: 12px; color: var(--ok) }

@keyframes pop { from { transform: translateY(6px) scale(.985); opacity: .6 } to { transform: none; opacity: 1 } }
@keyframes shimmer { to { background-position: -200% 0 } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important } }

/* ------------------------------------------------------------ responsive */
@media (max-width: 1060px) {
  .grid--status, .grid--2, .grid--3 { grid-template-columns: 1fr }
}
@media (max-width: 900px) {
  .sidebar {
    position: fixed; left: 0; top: 0; bottom: 0; height: 100dvh; transform: translateX(-105%);
    transition: transform 160ms var(--t-fast); box-shadow: none; width: min(300px, 86vw); z-index: 40;
  }
  body.drawer .sidebar { transform: none; box-shadow: 0 0 80px rgba(0, 0, 0, .7) }
  body.drawer .scrim { display: block }
  .scrim { display: none; position: fixed; inset: 0; background: rgba(5, 6, 8, .6); z-index: 35 }
  .menu-btn { display: grid }
  .collapse-btn { display: none }
  body.rail .sidebar { width: min(300px, 86vw) }
  body.rail .nav a .lbl, body.rail .brand-text, body.rail .nav-sec, body.rail .side-note { display: revert }
  body.rail .nav a { justify-content: flex-start; padding: 10px 10px }
  .content { padding: 16px 14px 56px }
  .topbar { padding: 8px 14px }
  .topbar .tb-sub { display: none }
  .trow { grid-template-columns: 22px 1fr auto 18px; gap: 8px }
  .trow .tdesc { grid-column: 2 / 4 }
  .kv { grid-template-columns: 1fr auto; padding: 10px 14px }
  .kv .d { grid-column: 1 / 3; text-align: left; white-space: normal }
  .kv .v { grid-row: 1 }
  .hero { padding: 18px }
  .hero h1 { font-size: 21px }
}
@media (max-width: 560px) {
  .overlay { place-items: end center; padding: 0 }
  .modal, .palette { width: 100%; max-height: 88dvh; border-radius: var(--r-lg) var(--r-lg) 0 0; border-bottom: 0; animation: slideup 180ms var(--t-fast) }
  .palette { max-height: 78dvh }
  .endpoint { flex-direction: column; align-items: stretch; gap: 8px }
  .endpoint code { font-size: 13px; padding: 4px 2px }
  .endpoint .btn { justify-content: center; height: 42px }
  .btn--touch, .modal .btn { min-height: 42px }
  .modal-bd { padding: 14px 13px }
  .toolbar .search { max-width: none; min-width: 0 }
  .tcount { margin-left: 0; flex: 1 }
  .trow .tgrp { display: none }
  .hero-side { min-width: 0; width: 100% }
  .foot { padding: 12px 14px; font-size: 11px }
  .topbar-actions .btn span.lbl { display: none }
  .topbar-actions .btn { width: 38px; padding: 0; justify-content: center }
}
@keyframes slideup { from { transform: translateY(14px); opacity: .7 } to { transform: none; opacity: 1 } }
`;
