/**
 * DEMO inspector UI — design system CSS.
 *
 * Premium minimal developer-tool aesthetic: quiet layered surfaces, subtle 1px
 * borders, one restrained accent, deliberate whitespace, system typography.
 * Everything is inlined into the one self-contained HTML document the Worker
 * serves (the CSP forbids any external resource, and that lockdown is
 * deliberate).
 *
 * Design tokens live in :root; every component below consumes them so the
 * whole UI stays consistent. Dark is primary; a light theme follows the OS
 * preference through the same tokens.
 */
export const UI_CSS = String.raw`
:root {
  color-scheme: dark light;
  /* surfaces: layered, never pure black */
  --bg: #0a0b0e;
  --bg-deep: #07080a;
  --surface: #0e1014;
  --surface-2: #13161c;
  --surface-3: #191d24;
  --border: #1d222b;
  --border-2: #28303c;
  --border-3: #39424f;
  /* text */
  --text: #e8ebf0;
  --dim: #9aa3b1;
  --faint: #6b7382;
  /* one accent + status hues (always paired with icon + text) */
  --accent: #5ba8f7;
  --accent-strong: #8ac2ff;
  --accent-ink: #0a0c10;
  --ok: #3ddc97;
  --warn: #f5c04a;
  --err: #f2777a;
  --off: #5d6673;
  --ring: rgba(91, 168, 247, .65);
  /* type */
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --fs-11: 11px; --fs-12: 12px; --fs-13: 13px; --fs-14: 14px; --fs-16: 16px; --fs-20: 20px; --fs-28: 28px;
  /* radius + depth + motion */
  --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-xl: 16px;
  --shadow-md: 0 10px 30px -14px rgba(0, 0, 0, .8);
  --shadow-lg: 0 24px 70px -18px rgba(0, 0, 0, .9);
  --t-fast: 120ms cubic-bezier(.2, .6, .3, 1);
  --t-med: 180ms cubic-bezier(.2, .6, .3, 1);
  --maxw: 1120px;
  --header-h: 58px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f7f7f8;
    --bg-deep: #efeff1;
    --surface: #ffffff;
    --surface-2: #f4f4f6;
    --surface-3: #e9e9ed;
    --border: #e5e5ea;
    --border-2: #d8d8de;
    --border-3: #b9b9c2;
    --text: #17171c;
    --dim: #55555e;
    --faint: #8a8a93;
    --accent: #1f6feb;
    --accent-strong: #1f6feb;
    --accent-ink: #ffffff;
    --ok: #1a7f4d;
    --warn: #9a6700;
    --err: #cf222e;
    --off: #8a8a93;
    --ring: rgba(31, 111, 235, .55);
    --shadow-md: 0 10px 30px -18px rgba(20, 20, 30, .25);
    --shadow-lg: 0 24px 70px -24px rgba(20, 20, 30, .35);
  }
}
* { box-sizing: border-box }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
  font: var(--fs-14)/1.6 var(--sans);
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
.layout { display: flex; flex-direction: column; min-height: 100vh }
.header {
  position: sticky; top: 0; z-index: 30;
  border-bottom: 1px solid var(--border); background: var(--bg);
}
@supports (backdrop-filter: blur(8px)) {
  .header { background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px) }
}
.header-in {
  max-width: var(--maxw); margin: 0 auto; padding: 0 20px;
  min-height: var(--header-h); display: flex; align-items: center; gap: 8px;
}
.brand { display: flex; align-items: center; gap: 10px; color: var(--text); margin-right: 12px }
.brand:hover { text-decoration: none }
.brand-mark {
  width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center;
  background: var(--text); color: var(--bg); font-weight: 800; font-size: 14px; letter-spacing: -.02em;
}
.brand-name { font-weight: 750; font-size: 15px; letter-spacing: -.01em; line-height: 1.1 }
.brand-ver { font-family: var(--mono); font-size: 10.5px; color: var(--faint); font-weight: 400 }
.nav { display: flex; align-items: center; gap: 2px; margin-left: 4px }
.nav a {
  display: inline-flex; align-items: center; gap: 7px; padding: 7px 11px; border-radius: var(--r-md);
  color: var(--dim); font-weight: 550; font-size: var(--fs-13); white-space: nowrap;
  transition: background var(--t-fast), color var(--t-fast);
}
.nav a svg { width: 14px; height: 14px; opacity: .75 }
.nav a:hover { background: var(--surface-2); color: var(--text); text-decoration: none }
.nav a[aria-current="page"] { background: var(--surface-3); color: var(--text) }
.header .grow { flex: 1 }
.header-actions { display: flex; align-items: center; gap: 8px; flex: none }
.menu-btn { display: none; background: none; border: 1px solid var(--border-2); border-radius: var(--r-md); width: 38px; height: 38px; place-items: center; cursor: pointer; color: var(--dim) }
.menu-btn:hover { color: var(--text); background: var(--surface-2) }
.menu-btn svg { width: 16px; height: 16px }
/* mobile menu panel */
.menu {
  display: none; border-bottom: 1px solid var(--border); background: var(--surface);
  max-height: calc(100dvh - var(--header-h)); overflow-y: auto;
}
body.menu-open .menu { display: block }
.menu-in { max-width: var(--maxw); margin: 0 auto; padding: 10px 16px 16px; display: flex; flex-direction: column; gap: 2px }
.menu a.mi, .menu button.mi {
  display: flex; align-items: center; gap: 11px; padding: 11px 10px; border-radius: var(--r-md);
  color: var(--dim); font-weight: 550; font-size: var(--fs-14); background: none; border: 0; width: 100%; text-align: left; cursor: pointer;
}
.menu a.mi svg, .menu button.mi svg { width: 16px; height: 16px; opacity: .8 }
.menu a.mi:hover, .menu button.mi:hover { background: var(--surface-2); color: var(--text); text-decoration: none }
.menu a.mi[aria-current="page"] { background: var(--surface-3); color: var(--text) }
.menu .mi-sec { font-size: 10.5px; letter-spacing: .15em; text-transform: uppercase; color: var(--faint); font-weight: 650; padding: 12px 10px 4px }
.menu .mi-cta { margin-top: 10px }
.menu .mi-cta .btn { width: 100%; justify-content: center; min-height: 44px; font-size: var(--fs-14) }
.content { width: 100%; max-width: var(--maxw); margin: 0 auto; padding: 28px 20px 72px; min-width: 0; flex: 1 }
.foot {
  border-top: 1px solid var(--border); background: var(--bg-deep);
}
.foot-in {
  max-width: var(--maxw); margin: 0 auto; padding: 16px 20px; color: var(--faint); font-size: var(--fs-12);
  display: flex; gap: 8px 16px; flex-wrap: wrap; align-items: center;
}
.foot-in .mono { font-size: 11px }
.foot-links { display: flex; gap: 14px; margin-left: auto; flex-wrap: wrap }
.foot-links a { color: var(--dim); font-size: var(--fs-12) }

/* ---------------------------------------------------------------- buttons */
.btn {
  min-height: 34px; padding: 0 14px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--border-2); border-radius: var(--r-md);
  color: var(--text); font-weight: 600; font-size: var(--fs-13); white-space: nowrap; user-select: none;
  transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
}
.btn:hover { background: var(--surface-3); border-color: var(--border-3); text-decoration: none; color: var(--text) }
.btn:active { transform: translateY(1px) }
.btn:disabled { opacity: .55; cursor: default; transform: none }
.btn svg { width: 14px; height: 14px }
.btn--primary { background: var(--text); color: var(--bg); border-color: var(--text) }
.btn--primary:hover { background: var(--text); border-color: var(--text); opacity: .88; color: var(--bg) }
.btn--accent { background: var(--accent); border-color: var(--accent); color: var(--accent-ink) }
.btn--accent:hover { border-color: var(--accent); background: var(--accent); opacity: .9; color: var(--accent-ink) }
.btn--danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent) }
.btn--danger:hover { background: color-mix(in srgb, var(--err) 8%, transparent); color: var(--err) }
.btn--lg { min-height: 42px; padding: 0 20px; font-size: var(--fs-14); border-radius: var(--r-md) }
.btn--sm { min-height: 28px; padding: 0 10px; font-size: var(--fs-12); border-radius: var(--r-sm) }
.btn--icon { width: 34px; padding: 0 }
.btn--touch { min-height: 42px }
.link-btn { background: none; border: 0; padding: 0; color: var(--accent-strong); cursor: pointer; font-size: inherit }
.link-btn:hover { text-decoration: underline }
.link-arrow { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; font-size: var(--fs-13); white-space: nowrap }
.link-arrow svg { width: 13px; height: 13px }

/* ----------------------------------------------------------------- panels */
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow-md) }
.panel + .panel, .grid + .panel, .panel + .grid, .stack > .panel + .panel { margin-top: 16px }
.panel-hd { display: flex; align-items: center; gap: 9px; padding: 12px 16px; border-bottom: 1px solid var(--border) }
.panel-hd > svg, .panel-hd .hd-ic { width: 15px; height: 15px; color: var(--faint); display: inline-flex }
.panel-hd .hd-ic svg { width: 15px; height: 15px }
.panel-hd h3 { margin: 0; font-size: var(--fs-13); font-weight: 700; letter-spacing: -.005em }
.panel-hd .hd-note { margin-left: auto; color: var(--faint); font-size: var(--fs-12); display: flex; gap: 8px; align-items: center; min-width: 0 }
.panel-bd { padding: 14px 16px }
.panel-bd--flush { padding: 0 }
.grid { display: grid; gap: 16px }
.grid--2 { grid-template-columns: 1fr 1fr }
.grid--3 { grid-template-columns: repeat(3, 1fr) }
.grid + .grid, .panel + .grid { margin-top: 16px }
.eyebrow { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); font-weight: 650 }
.muted { color: var(--dim) }
.faint { color: var(--faint) }
.small { font-size: var(--fs-12) }
.hint { font-size: var(--fs-12); color: var(--faint); line-height: 1.55 }
.stack { display: flex; flex-direction: column; gap: 16px }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
.pill-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px }
.sec-head { display: flex; align-items: baseline; gap: 12px; margin: 32px 0 12px; flex-wrap: wrap }
.sec-head h2 { margin: 0; font-size: var(--fs-16); font-weight: 700; letter-spacing: -.01em }
.sec-head p { margin: 0; color: var(--faint); font-size: var(--fs-13); flex: 1; min-width: 200px }
.sec-head .link-arrow { margin-left: auto }

/* hero ------------------------------------------------------------------ */
.hero { padding: 40px 0 8px; max-width: 760px }
.hero .eyebrow { display: flex; align-items: center; gap: 8px }
.hero h1 { margin: 10px 0 10px; font-size: var(--fs-28); line-height: 1.2; letter-spacing: -.03em; font-weight: 750 }
.hero p.lede { margin: 0 0 20px; color: var(--dim); font-size: var(--fs-16); line-height: 1.6; max-width: 62ch }
.hero-cta { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px }
.hero-status { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); color: var(--dim); flex-wrap: wrap }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none }
.live-dot--warn { background: var(--warn) }
.live-dot--err { background: var(--err) }
.live-dot--idle { background: var(--off) }
.live-dot--pulse { animation: pulse 2s infinite ease-in-out }
@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .45 } }

/* capability categories --------------------------------------------------- */
.cat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px }
.cat {
  display: flex; flex-direction: column; gap: 8px; padding: 16px; text-align: left;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  color: var(--text); cursor: pointer; transition: border-color var(--t-fast), background var(--t-fast), transform var(--t-fast);
  min-width: 0;
}
a.cat:hover { text-decoration: none; border-color: var(--border-3); background: var(--surface-2) }
a.cat:active { transform: translateY(1px) }
.cat-top { display: flex; align-items: center; gap: 9px }
.cat-ic {
  width: 30px; height: 30px; border-radius: var(--r-md); display: grid; place-items: center; flex: none;
  background: var(--surface-3); border: 1px solid var(--border-2); color: var(--dim);
}
.cat-ic svg { width: 15px; height: 15px }
.cat-top h3 { margin: 0; font-size: var(--fs-14); font-weight: 700; letter-spacing: -.01em; flex: 1; min-width: 0 }
.cat p { margin: 0; font-size: var(--fs-13); color: var(--dim); line-height: 1.55 }
.cat-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px }
.cat-tag { font-size: 11px; color: var(--faint); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 1.5px 7px; white-space: nowrap }
.cat-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 6px; font-size: var(--fs-12); color: var(--faint) }
.cat-foot .link-arrow { font-size: var(--fs-12) }

/* status ---------------------------------------------------------------- */
.st {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 650; line-height: 1.3;
  padding: 2.5px 9px 2.5px 7px; border-radius: 999px; border: 1px solid var(--border-2);
  background: var(--surface-2); color: var(--dim); white-space: nowrap;
}
.st svg { width: 12px; height: 12px }
.st--ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: color-mix(in srgb, var(--ok) 7%, transparent) }
.st--warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent) }
.st--err { color: var(--err); border-color: color-mix(in srgb, var(--err) 35%, transparent); background: color-mix(in srgb, var(--err) 7%, transparent) }
.st--info { color: var(--accent-strong); border-color: color-mix(in srgb, var(--accent) 35%, transparent); background: color-mix(in srgb, var(--accent) 7%, transparent) }
.st--off { color: var(--off) }
.st--idle { color: var(--dim) }
.tbl-wrap { overflow-x: auto }

.kv { display: grid; grid-template-columns: minmax(120px, 180px) 1fr; gap: 4px 12px; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--border) }
.kv:last-child { border-bottom: 0 }
.kv .k { color: var(--dim); font-size: var(--fs-13); min-width: 0 }
.kv .v { min-width: 0; text-align: right; display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap }
.kv .d { color: var(--faint); font-size: var(--fs-12); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; flex-basis: 100% }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-13) }
.tbl th { text-align: left; font-weight: 600; color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: .12em; padding: 9px 16px; border-bottom: 1px solid var(--border) }
.tbl td { padding: 9px 16px; border-bottom: 1px solid var(--border); vertical-align: top }
.tbl tr:last-child td { border-bottom: 0 }
.tbl td.t-r, .tbl th.t-r { text-align: right }
ul.list { margin: 0; padding: 0; list-style: none }
ul.list li { padding: 8px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: baseline; min-width: 0 }
ul.list li:last-child { border-bottom: 0 }
ul.list li .li-k { color: var(--dim); flex: 1; min-width: 0 }
.bullets { margin: 0; padding-left: 18px; color: var(--dim) }
.bullets li { margin: 4px 0; line-height: 1.55 }

/* mono / code ------------------------------------------------------------- */
.mono, code { font-family: var(--mono); font-size: 12px; letter-spacing: -.01em }
code.chip-v { background: var(--bg-deep); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 1.5px 6px; color: var(--dim); user-select: all; -webkit-user-select: all; word-break: break-all }
pre.codeblock {
  margin: 0; padding: 12px 14px; background: var(--bg-deep); border: 1px solid var(--border); border-radius: var(--r-md);
  font-family: var(--mono); font-size: 11.5px; line-height: 1.65; color: var(--dim); overflow-x: auto;
}
.copy-inline { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end }
details.tech { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface) }
details.tech summary { cursor: pointer; padding: 10px 14px; font-size: var(--fs-13); font-weight: 600; color: var(--dim); list-style: none; display: flex; align-items: center; gap: 8px }
details.tech summary::-webkit-details-marker { display: none }
details.tech summary:hover { color: var(--text) }
details.tech summary svg { width: 13px; height: 13px }
details.tech[open] summary svg { transform: rotate(90deg) }
details.tech .tech-bd { padding: 0 14px 14px }
details.tech pre.codeblock { max-height: 320px; overflow: auto }

/* tools explorer ---------------------------------------------------------- */
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px }
.search { position: relative; flex: 1; min-width: 200px; max-width: 440px }
.search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--faint); pointer-events: none }
.search input {
  width: 100%; min-height: 36px; background: var(--bg-deep); border: 1px solid var(--border-2); border-radius: var(--r-md);
  color: var(--text); padding: 0 10px 0 32px; outline: none; font-size: var(--fs-13);
}
.search input:focus-visible { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent) }
.chips { display: flex; gap: 6px; flex-wrap: wrap }
.chip {
  font-size: var(--fs-12); font-weight: 550; padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border-2);
  background: transparent; color: var(--dim); cursor: pointer; transition: all var(--t-fast); white-space: nowrap;
}
.chip:hover { color: var(--text); border-color: var(--border-3) }
.chip[aria-pressed="true"] { background: var(--surface-3); border-color: var(--border-3); color: var(--text) }
.chip .cnt { color: var(--faint); margin-left: 5px; font-size: 11px }
.tcount { color: var(--faint); font-size: var(--fs-12); margin-left: auto }
.trow { display: grid; grid-template-columns: minmax(150px, .9fr) minmax(0, 1.4fr) auto 18px; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); cursor: pointer; background: none; border-left: 0; border-right: 0; border-top: 0; width: 100%; text-align: left; color: var(--text) }
.trow:first-child { border-top: 0 }
button.trow:hover { background: var(--surface-2) }
.trow[aria-expanded="true"] { background: var(--surface-2) }
.trow .tname { font-family: var(--mono); font-size: 12.5px; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 8px }
.trow .tdesc { color: var(--faint); font-size: var(--fs-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0 }
.trow .tgrp { font-size: 11px; color: var(--dim); border: 1px solid var(--border-2); border-radius: var(--r-sm); padding: 1px 7px; white-space: nowrap }
.trow .tw { display: grid; place-items: center; color: var(--faint) }
.trow .tw svg { width: 14px; height: 14px; transition: transform var(--t-fast) }
.trow[aria-expanded="true"] .tw svg { transform: rotate(90deg) }
.tstat { width: 8px; height: 8px; border-radius: 50%; flex: none }
.tstat--ok { background: var(--ok) }
.tstat--warn { background: var(--warn) }
.tstat--err { background: var(--err) }
.tstat--off { background: var(--off) }
.tstat--info { background: var(--accent) }
.tstat--idle { background: var(--off); opacity: .5 }
.tdetail { padding: 14px 18px 16px; border-bottom: 1px solid var(--border); background: var(--bg-deep) }
.tdetail .tdesc-full { color: var(--dim); font-size: var(--fs-13); line-height: 1.65; margin: 0 0 10px; max-width: 90ch }
.tdetail h4 { margin: 12px 0 6px; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--faint) }
.in-chip { font-family: var(--mono); font-size: 11px; color: var(--dim); background: var(--surface-2); border: 1px solid var(--border-2); border-radius: var(--r-sm); padding: 2px 7px }
.tfoot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px }

/* browser / pipeline flows */
.flow { display: flex; flex-direction: column }
.flow-step { display: flex; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); align-items: flex-start }
.flow-step:last-child { border-bottom: 0 }
.flow-num { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border-3); color: var(--dim); font-size: 10.5px; display: grid; place-items: center; font-family: var(--mono); margin-top: 1px }
.flow-txt { min-width: 0; flex: 1 }
.flow-txt code { color: var(--accent-strong) }
.flow-txt .fx-d { color: var(--faint); font-size: var(--fs-12); line-height: 1.55 }
.bar { height: 5px; border-radius: 3px; background: var(--surface-3); overflow: hidden; margin: 6px 0 2px }
.bar > i { display: block; height: 100%; background: var(--accent); border-radius: 3px }

/* no-login strip + page head ------------------------------------------------ */
.access-strip {
  display: flex; gap: 14px; align-items: flex-start;
  border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface);
  padding: 16px 18px; margin-top: 16px;
}
.access-strip .note { flex: 1; min-width: 240px; margin: 0 }
.page-head { padding: 12px 0 4px; max-width: 760px }
.page-head h1 { margin: 8px 0 8px; font-size: 24px; line-height: 1.25; letter-spacing: -.025em; font-weight: 750 }
.page-head p { margin: 0; color: var(--dim); font-size: var(--fs-14); line-height: 1.6 }
.center-404 { text-align: center; padding: 72px 16px; max-width: 520px; margin: 0 auto }
.center-404 h1 { font-size: 24px; letter-spacing: -.02em; margin: 12px 0 8px }
.center-404 p { color: var(--dim); margin: 0 0 20px }

/* modal ------------------------------------------------------------------ */
.overlay {
  position: fixed; inset: 0; z-index: 70; background: rgba(4, 5, 7, .66);
  display: grid; place-items: center; padding: 20px;
}
@media (prefers-color-scheme: light) { .overlay { background: rgba(30, 30, 40, .4) } }
.overlay[hidden] { display: none }
.modal {
  width: min(520px, 100%); background: var(--surface); border: 1px solid var(--border-2); border-radius: var(--r-xl);
  box-shadow: var(--shadow-lg); display: flex; flex-direction: column; max-height: calc(100vh - 40px);
  animation: pop var(--t-med);
}
.modal-hd { display: flex; align-items: flex-start; gap: 12px; padding: 18px 18px 0 }
.modal-ic { width: 34px; height: 34px; border-radius: var(--r-md); display: grid; place-items: center; flex: none; background: var(--surface-3); border: 1px solid var(--border-2); color: var(--dim) }
.modal-ic svg { width: 16px; height: 16px }
.modal-hd h3 { margin: 0; font-size: var(--fs-16); font-weight: 720; letter-spacing: -.01em }
.modal-hd .sub { margin: 2px 0 0; font-size: var(--fs-13); color: var(--dim) }
.modal-hd .x { margin-left: auto; flex: none }
.modal-bd { padding: 16px 18px 18px; overflow-y: auto }
.modal-ft { padding: 12px 18px; border-top: 1px solid var(--border); display: flex; gap: 10px; align-items: center; color: var(--faint); font-size: var(--fs-12) }
.modal-ft svg { width: 13px; height: 13px }
.modal-steps { margin: 14px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px }
.modal-steps li { display: flex; gap: 10px; font-size: var(--fs-13); color: var(--dim); line-height: 1.55 }
.modal-steps .n { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border-3); color: var(--dim); font-size: 10.5px; display: grid; place-items: center; font-family: var(--mono); margin-top: 1px }
.endpoint {
  display: flex; align-items: center; gap: 10px; background: var(--bg-deep); border: 1px solid var(--border-2);
  border-radius: var(--r-md); padding: 12px 12px 12px 14px;
}
.endpoint:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent) }
.endpoint code {
  flex: 1; min-width: 0; font-size: var(--fs-13); color: var(--text); background: none; border: 0; padding: 0;
  user-select: all; -webkit-user-select: all; word-break: break-all; line-height: 1.45;
  overflow-x: auto; white-space: nowrap;
}
.endpoint .btn { height: 36px; flex: none }
.modal-note { margin-top: 14px; font-size: var(--fs-12); color: var(--faint); line-height: 1.6 }
.modal-note b { color: var(--dim); font-weight: 600 }

/* command palette --------------------------------------------------------- */
.palette {
  width: min(600px, 100%); background: var(--surface); border: 1px solid var(--border-2); border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg); overflow: hidden; display: flex; flex-direction: column;
  max-height: min(70vh, 540px); animation: pop var(--t-med);
}
.palette .p-search { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border) }
.palette .p-search svg { width: 15px; height: 15px; color: var(--faint) }
.palette .p-search input { flex: 1; background: none; border: 0; outline: none; color: var(--text); font-size: 15px; min-width: 0 }
.palette .p-results { overflow-y: auto; padding: 6px }
.p-item { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; background: none; border: 0; border-radius: var(--r-md); padding: 9px 10px; cursor: pointer; color: var(--dim) }
.p-item svg { width: 15px; height: 15px; color: var(--faint) }
.p-item .p-lbl { color: var(--text); font-size: var(--fs-13); font-weight: 550; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.p-item .p-kind { margin-left: auto; font-size: 10.5px; color: var(--faint); letter-spacing: .06em; text-transform: uppercase; flex: none }
.p-item[aria-selected="true"], .p-item:hover { background: var(--surface-3); color: var(--text) }
.p-empty { padding: 22px 14px; text-align: center; color: var(--faint); font-size: var(--fs-13) }
kbd { font-family: var(--mono); font-size: 10.5px; color: var(--dim); background: var(--surface-2); border: 1px solid var(--border-2); border-bottom-width: 2px; border-radius: 5px; padding: 1.5px 5px; line-height: 1.4 }

/* toasts, skel, states ---------------------------------------------------- */
.toasts { position: fixed; bottom: 16px; right: 16px; z-index: 95; display: flex; flex-direction: column; gap: 8px; pointer-events: none }
.toast {
  display: flex; align-items: center; gap: 8px; background: var(--surface-3); border: 1px solid var(--border-2); border-radius: var(--r-md);
  padding: 9px 13px; font-size: var(--fs-13); color: var(--text); box-shadow: var(--shadow-md); animation: pop var(--t-fast);
}
.toast svg { width: 14px; height: 14px; color: var(--ok) }
.skel { border-radius: 6px; background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: shimmer 1.3s infinite linear; height: 12px; margin: 7px 0 }
.skel--lg { height: 64px }
.err-card { border-color: color-mix(in srgb, var(--err) 30%, transparent) }
.err-card .panel-hd { border-bottom-color: color-mix(in srgb, var(--err) 18%, transparent) }
.note { font-size: var(--fs-13); color: var(--dim); line-height: 1.65 }
.note b, .note strong { color: var(--text); font-weight: 650 }
.note-warn { border: 1px solid color-mix(in srgb, var(--warn) 25%, transparent); background: color-mix(in srgb, var(--warn) 5%, transparent); border-radius: var(--r-md); padding: 10px 12px; font-size: var(--fs-12); color: var(--dim); line-height: 1.6 }
.badge-secure { display: inline-flex; gap: 6px; align-items: center; font-size: 11px; font-weight: 600; color: var(--dim); border: 1px solid var(--border-2); border-radius: 999px; padding: 4px 11px; white-space: nowrap }
.badge-secure svg { width: 12px; height: 12px; color: var(--ok) }

@keyframes pop { from { transform: translateY(6px) scale(.985); opacity: .6 } to { transform: none; opacity: 1 } }
@keyframes shimmer { to { background-position: -200% 0 } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important }
  html { scroll-behavior: auto }
}

/* ------------------------------------------------------------ responsive */
@media (max-width: 1060px) {
  .grid--2, .grid--3 { grid-template-columns: 1fr }
  .cat-grid { grid-template-columns: repeat(2, 1fr) }
}
@media (max-width: 900px) {
  .content { padding: 20px 16px 56px }
  .header-in { padding: 0 16px }
  .foot-in { padding: 14px 16px }
  .nav { display: none }
  .menu-btn { display: grid }
  .header-actions .btn span.lbl { display: none }
  .header-actions .btn--smhide { width: 38px; padding: 0 }
}
@media (max-width: 760px) {
  .hero { padding: 24px 0 4px }
  .hero h1 { font-size: 24px }
  .hero p.lede { font-size: 15px }
  .cat-grid { grid-template-columns: 1fr }
  .cat { padding: 14px }
  .trow { grid-template-columns: 1fr auto 18px; gap: 8px; padding: 11px 14px }
  .trow .tname { font-size: 12px }
  .trow .tdesc { display: none }
  .trow .tgrp { display: none }
  .tdetail { padding: 12px 14px 14px }
  .kv { grid-template-columns: 1fr; gap: 6px; padding: 10px 14px }
  .kv .v, .kv .d { text-align: left; justify-content: flex-start }
  .copy-inline { justify-content: flex-start }
  .tcount { margin-left: 0; flex: 1 }
  .toolbar .search { max-width: none; min-width: 0; flex-basis: 100% }
  .access-strip { flex-direction: column }
  .foot-links { margin-left: 0 }
  /* 16px inputs prevent iOS Safari auto-zoom on focus */
  .search input, .palette .p-search input { font-size: 16px }
}
@media (max-width: 560px) {
  .overlay { place-items: end center; padding: 0 }
  .modal, .palette { width: 100%; max-height: 90dvh; border-radius: var(--r-lg) var(--r-lg) 0 0; border-bottom: 0; animation: slideup var(--t-med) }
  .palette { max-height: 80dvh }
  .endpoint { flex-direction: column; align-items: stretch; gap: 8px }
  .endpoint code { font-size: 12.5px; padding: 4px 2px; white-space: normal }
  .endpoint .btn { justify-content: center; min-height: 44px }
  .btn--touch, .modal .btn { min-height: 44px }
  .modal-bd { padding: 14px 14px 16px }
  .modal-hd { padding: 16px 14px 0 }
  .modal-ft { padding: 11px 14px }
  .hero-cta .btn { flex: 1; justify-content: center }
  .toasts { left: 16px; right: 16px; bottom: 16px }
  .toast { justify-content: center }
}
@keyframes slideup { from { transform: translateY(14px); opacity: .7 } to { transform: none; opacity: 1 } }
`;
