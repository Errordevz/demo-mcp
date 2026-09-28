/**
 * DEMO inspector UI — design system CSS 2.0
 *
 * Premium minimal developer-tool aesthetic, evolution 2.0:
 * deep charcoal layered surfaces, refined dark + complementary light theme,
 * restrained blue accent, clear typography, subtle 1px borders, intentional
 * 4px spacing scale, strong information hierarchy, calm density.
 *
 * Everything is inlined into one self-contained HTML document the Worker
 * serves (CSP forbids external resources). Tokens live in :root; every
 * component consumes them. Dark is primary; light follows OS preference.
 *
 * No gradients, no glows, no glassmorphism — only layered surfaces, borders,
 * and restrained motion.
 */
export const UI_CSS = String.raw`
:root {
  color-scheme: dark light;
  /* --- surfaces: layered charcoal, never pure black --- */
  --bg: #0b0d10;
  --bg-deep: #080a0d;
  --surface: #12151c;
  --surface-2: #181c26;
  --surface-3: #1e242f;
  --surface-4: #252e3d;
  --border: #1e2632;
  --border-2: #2a3442;
  --border-3: #354152;
  /* text */
  --text: #eef1f6;
  --dim: #a3adc0;
  --faint: #6e7a8c;
  --faint-2: #545e6f;
  /* accent + status — always paired with icon + text, never color alone */
  --accent: #5b8def;
  --accent-strong: #7aa3f5;
  --accent-ink: #0a0e1a;
  --accent-ring: rgba(91,141,239,.52);
  --accent-soft: rgba(91,141,239,.12);
  --ok: #2fdb8a;
  --ok-soft: rgba(47,219,138,.12);
  --warn: #f5b94a;
  --warn-soft: rgba(245,185,74,.13);
  --err: #f25c5e;
  --err-soft: rgba(242,92,94,.12);
  --off: #5a6577;
  --ring: var(--accent-ring);
  /* type */
  --mono: ui-monospace, "Geist Mono", "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Geist", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --fs-10: 10px; --fs-11: 11px; --fs-12: 12px; --fs-13: 13px; --fs-14: 14px; --fs-15: 15px; --fs-16: 16px; --fs-18: 18px; --fs-20: 20px; --fs-24: 24px; --fs-28: 28px; --fs-32: 32px;
  --lh-tight: 1.2; --lh-snug: 1.35; --lh-normal: 1.6; --lh-relaxed: 1.7;
  --fw-regular: 450; --fw-medium: 550; --fw-semibold: 650; --fw-bold: 750;
  /* spacing scale — 4px base */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px; --sp-12: 48px;
  /* radius */
  --r-xs: 6px; --r-sm: 8px; --r-md: 10px; --r-lg: 14px; --r-xl: 20px; --r-full: 9999px;
  /* depth */
  --shadow-xs: 0 1px 2px rgba(0,0,0,.24);
  --shadow-sm: 0 2px 10px -4px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.3);
  --shadow-md: 0 8px 24px -8px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.4);
  --shadow-lg: 0 20px 60px -16px rgba(0,0,0,.85), 0 8px 24px rgba(0,0,0,.5);
  /* motion */
  --ease-out: cubic-bezier(.16,1,.3,1);
  --ease-in-out: cubic-bezier(.65,0,.35,1);
  --t-fast: 130ms var(--ease-out);
  --t-med: 220ms var(--ease-out);
  --t-slow: 320ms var(--ease-out);
  --maxw: 1200px;
  --header-h: 64px;
  --content-px: 24px;
}
/* Explicit light theme (theme toggle) and OS-preference light theme when the
   user has not chosen one (data-theme=light|dark set by the boot script). */
:root[data-theme="light"] {
  --bg: #fcfcfd;
  --bg-deep: #f2f3f5;
  --surface: #ffffff;
  --surface-2: #f6f7f9;
  --surface-3: #eef0f3;
  --surface-4: #e4e7ec;
  --border: #e6e8eb;
  --border-2: #d8dce2;
  --border-3: #c2c8d1;
  --text: #12151c;
  --dim: #5a6577;
  --faint: #8a95a7;
  --faint-2: #aab4c2;
  --accent: #2f6feb;
  --accent-strong: #2f6feb;
  --accent-ink: #ffffff;
  --accent-ring: rgba(47,111,235,.42);
  --accent-soft: rgba(47,111,235,.1);
  --ok: #16794e;
  --ok-soft: rgba(22,121,78,.1);
  --warn: #8a5a00;
  --warn-soft: rgba(138,90,0,.1);
  --err: #c01c28;
  --err-soft: rgba(192,28,40,.09);
  --off: #8a95a7;
  --shadow-xs: 0 1px 2px rgba(16,24,40,.06);
  --shadow-sm: 0 1px 3px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.06);
  --shadow-md: 0 8px 24px -8px rgba(16,24,40,.12), 0 4px 8px rgba(16,24,40,.06);
  --shadow-lg: 0 20px 60px -16px rgba(16,24,40,.16), 0 8px 24px rgba(16,24,40,.08);
  color-scheme: light;
}
:root[data-theme="dark"] { color-scheme: dark }
/* OS-preference light theme when no explicit choice was made. Keep in sync with
   :root[data-theme="light"] above. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --bg: #fcfcfd;
    --bg-deep: #f2f3f5;
    --surface: #ffffff;
    --surface-2: #f6f7f9;
    --surface-3: #eef0f3;
    --surface-4: #e4e7ec;
    --border: #e6e8eb;
    --border-2: #d8dce2;
    --border-3: #c2c8d1;
    --text: #12151c;
    --dim: #5a6577;
    --faint: #8a95a7;
    --faint-2: #aab4c2;
    --accent: #2f6feb;
    --accent-strong: #2f6feb;
    --accent-ink: #ffffff;
    --accent-ring: rgba(47,111,235,.42);
    --accent-soft: rgba(47,111,235,.1);
    --ok: #16794e;
    --ok-soft: rgba(22,121,78,.1);
    --warn: #8a5a00;
    --warn-soft: rgba(138,90,0,.1);
    --err: #c01c28;
    --err-soft: rgba(192,28,40,.09);
    --off: #8a95a7;
    --shadow-xs: 0 1px 2px rgba(16,24,40,.06);
    --shadow-sm: 0 1px 3px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.06);
    --shadow-md: 0 8px 24px -8px rgba(16,24,40,.12), 0 4px 8px rgba(16,24,40,.06);
    --shadow-lg: 0 20px 60px -16px rgba(16,24,40,.16), 0 8px 24px rgba(16,24,40,.08);
  }
}

/* reset & base */
* { box-sizing: border-box; min-width: 0 }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scrollbar-gutter: stable }
body {
  margin: 0; min-height: 100vh; min-height: 100dvh;
  background: var(--bg); color: var(--text);
  font: var(--fs-14)/var(--lh-normal) var(--sans);
  font-weight: var(--fw-regular);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  overflow-x: hidden;
}
::selection { background: var(--accent-soft); color: var(--text) }
a { color: var(--accent-strong); text-decoration: none; text-underline-offset: 2px }
a:hover { text-decoration: underline; text-decoration-thickness: 1px }
a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px;
}
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0 }
svg { flex: none; display: block }
img { max-width: 100% }
.skip {
  position: fixed; left: 12px; top: -48px; z-index: 100;
  background: var(--surface-2); border: 1px solid var(--border-2);
  border-radius: var(--r-md); padding: 10px 16px; color: var(--text);
  font-weight: var(--fw-medium); font-size: var(--fs-13);
  box-shadow: var(--shadow-md);
  transition: top var(--t-fast);
}
.skip:focus { top: max(12px, env(safe-area-inset-top, 0px)); }
.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap }

/* shell */
.layout { display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh }
.header {
  position: sticky; top: 0; z-index: 30;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  padding-top: env(safe-area-inset-top, 0px);
}
@supports (backdrop-filter: blur(16px)) {
  .header {
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(16px) saturate(1.2);
    -webkit-backdrop-filter: blur(16px) saturate(1.2);
  }
}
.header-in {
  max-width: var(--maxw); margin: 0 auto;
  padding: 0 var(--content-px);
  min-height: var(--header-h);
  display: flex; align-items: center; gap: var(--sp-2);
}
.brand {
  display: flex; align-items: center; gap: 10px;
  color: var(--text); margin-right: 8px; flex: none;
  border-radius: var(--r-md); padding: 2px 6px 2px 2px; margin-left: -2px;
}
.brand:hover { text-decoration: none; background: var(--surface-2) }
.brand-mark {
  width: 32px; height: 32px; border-radius: var(--r-sm);
  display: grid; place-items: center;
  background: var(--text); color: var(--bg);
  font-weight: 800; font-size: 15px; letter-spacing: -.04em;
  box-shadow: var(--shadow-xs);
}
.brand-name { font-weight: var(--fw-bold); font-size: 15px; letter-spacing: -.02em; line-height: 1.1 }
.brand-ver { font-family: var(--mono); font-size: 11px; color: var(--faint); font-weight: 450; letter-spacing: -.01em }
.nav { display: flex; align-items: center; gap: 3px; margin-left: 6px }
.nav a {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: var(--r-md);
  color: var(--dim); font-weight: var(--fw-medium); font-size: var(--fs-13);
  white-space: nowrap; border: 1px solid transparent;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.nav a svg { width: 14px; height: 14px; opacity: .8 }
.nav a:hover { background: var(--surface-2); color: var(--text); text-decoration: none; border-color: var(--border) }
.nav a[aria-current="page"] { background: var(--surface-3); color: var(--text); border-color: var(--border-2); font-weight: var(--fw-semibold) }
.header .grow { flex: 1 }
.header-actions { display: flex; align-items: center; gap: 8px; flex: none }

/* menu button */
.menu-btn {
  display: none; background: var(--surface-2); border: 1px solid var(--border-2);
  border-radius: var(--r-md); width: 40px; height: 40px; place-items: center;
  cursor: pointer; color: var(--dim); transition: all var(--t-fast);
}
.menu-btn:hover { color: var(--text); background: var(--surface-3); border-color: var(--border-3) }
.menu-btn svg { width: 18px; height: 18px }

/* mobile menu panel */
.menu {
  display: none; border-bottom: 1px solid var(--border); background: var(--surface);
  max-height: calc(100dvh - var(--header-h) - env(safe-area-inset-top, 0px));
  overflow-y: auto; overscroll-behavior: contain;
}
body.menu-open { overflow: hidden }
body.menu-open .menu { display: block; animation: menuIn var(--t-med) }
@keyframes menuIn { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }
.menu-in {
  max-width: var(--maxw); margin: 0 auto;
  padding: 12px 16px max(16px, env(safe-area-inset-bottom, 0px));
  display: flex; flex-direction: column; gap: 2px;
}
.menu a.mi, .menu button.mi {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 12px; border-radius: var(--r-md);
  color: var(--dim); font-weight: var(--fw-medium); font-size: var(--fs-14);
  background: none; border: 1px solid transparent; width: 100%; text-align: left; cursor: pointer;
  min-height: 44px; transition: all var(--t-fast);
}
.menu a.mi svg, .menu button.mi svg { width: 18px; height: 18px; opacity: .85 }
.menu a.mi:hover, .menu button.mi:hover { background: var(--surface-2); color: var(--text); text-decoration: none; border-color: var(--border) }
.menu a.mi[aria-current="page"] { background: var(--surface-3); color: var(--text); border-color: var(--border-2); font-weight: var(--fw-semibold) }
.menu .mi-sec {
  font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase;
  color: var(--faint); font-weight: 700; padding: 16px 12px 6px;
}
.menu .mi-cta { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border) }
.menu .mi-cta .btn { width: 100%; justify-content: center; min-height: 48px; font-size: var(--fs-14) }

/* content & footer */
.content {
  width: 100%; max-width: var(--maxw); margin: 0 auto;
  padding: 32px var(--content-px) 80px; min-width: 0; flex: 1;
}
.foot {
  border-top: 1px solid var(--border); background: var(--bg-deep);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.foot-in {
  max-width: var(--maxw); margin: 0 auto; padding: 18px var(--content-px);
  color: var(--faint); font-size: var(--fs-12); line-height: 1.5;
  display: flex; gap: 8px 20px; flex-wrap: wrap; align-items: center;
}
.foot-in .mono { font-size: 11px; color: var(--dim) }
.foot-links { display: flex; gap: 16px; margin-left: auto; flex-wrap: wrap }
.foot-links a { color: var(--dim); font-size: var(--fs-12); font-weight: var(--fw-medium) }
.foot-links a:hover { color: var(--text) }

/* buttons */
.btn {
  min-height: 36px; padding: 0 15px;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  cursor: pointer; user-select: none; white-space: nowrap;
  background: var(--surface-2); border: 1px solid var(--border-2); border-radius: var(--r-md);
  color: var(--text); font-weight: var(--fw-semibold); font-size: var(--fs-13);
  letter-spacing: -.01em; line-height: 1;
  transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast), transform var(--t-fast), box-shadow var(--t-fast);
}
.btn:hover { background: var(--surface-3); border-color: var(--border-3); text-decoration: none; color: var(--text) }
.btn:active { transform: translateY(1px) }
.btn:disabled { opacity: .5; cursor: default; transform: none; pointer-events: none }
.btn svg { width: 14px; height: 14px }
.btn--primary {
  background: var(--text); color: var(--bg); border-color: var(--text);
  box-shadow: var(--shadow-xs);
}
.btn--primary:hover { background: var(--text); border-color: var(--text); color: var(--bg); opacity: .88; box-shadow: var(--shadow-sm) }
.btn--accent {
  background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
  box-shadow: var(--shadow-xs);
}
.btn--accent:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); opacity: .92; box-shadow: var(--shadow-sm) }
.btn--danger {
  color: var(--err); border-color: color-mix(in srgb, var(--err) 38%, transparent);
  background: color-mix(in srgb, var(--err) 6%, transparent);
}
.btn--danger:hover { background: color-mix(in srgb, var(--err) 12%, transparent); border-color: color-mix(in srgb, var(--err) 50%, transparent); color: var(--err) }
.btn--lg { min-height: 44px; padding: 0 22px; font-size: var(--fs-14); border-radius: var(--r-md); letter-spacing: -.01em }
.btn--sm { min-height: 32px; padding: 0 12px; font-size: var(--fs-12); border-radius: var(--r-sm); gap: 6px }
.btn--icon { width: 36px; height: 36px; padding: 0; border-radius: var(--r-md) }
.btn--touch { min-height: 44px }
.btn--smhide { }
.link-btn {
  background: none; border: 0; padding: 2px 4px; margin: -2px -4px;
  color: var(--accent-strong); cursor: pointer; font-size: inherit; font-weight: var(--fw-medium);
  border-radius: var(--r-xs); text-underline-offset: 2px;
}
.link-btn:hover { text-decoration: underline }
.link-arrow {
  display: inline-flex; align-items: center; gap: 6px;
  font-weight: var(--fw-semibold); font-size: var(--fs-13); white-space: nowrap;
  color: var(--dim); transition: color var(--t-fast), gap var(--t-fast);
}
.link-arrow:hover { color: var(--text); gap: 8px; text-decoration: none }
.link-arrow svg { width: 14px; height: 14px; opacity: .8 }

/* panels */
.panel {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); box-shadow: var(--shadow-xs);
  overflow: hidden; transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
.panel:hover { border-color: var(--border-2) }
.panel + .panel, .grid + .panel, .panel + .grid, .stack > .panel + .panel { margin-top: 16px }
.panel-hd {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
}
.panel-hd > svg, .panel-hd .hd-ic { width: 16px; height: 16px; color: var(--faint); display: inline-flex; flex: none }
.panel-hd .hd-ic svg { width: 16px; height: 16px }
.panel-hd h3 { margin: 0; font-size: var(--fs-13); font-weight: var(--fw-bold); letter-spacing: -.01em; line-height: var(--lh-snug) }
.panel-hd .hd-note { margin-left: auto; color: var(--faint); font-size: var(--fs-12); display: flex; gap: 10px; align-items: center; min-width: 0; font-weight: var(--fw-regular) }
.panel-bd { padding: 18px }
.panel-bd--flush { padding: 0 }
.grid { display: grid; gap: 16px }
.grid--2 { grid-template-columns: 1fr 1fr }
.grid--3 { grid-template-columns: repeat(3, 1fr) }
.grid + .grid, .panel + .grid { margin-top: 16px }
.eyebrow {
  font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
  color: var(--faint); font-weight: 700; line-height: 1.2;
}
.muted { color: var(--dim) }
.faint { color: var(--faint) }
.small { font-size: var(--fs-12) }
.hint { font-size: var(--fs-12); color: var(--faint); line-height: 1.6 }
.stack { display: flex; flex-direction: column; gap: 16px }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center }
.pill-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px }
.sec-head { display: flex; align-items: baseline; gap: 12px; margin: 36px 0 16px; flex-wrap: wrap }
.sec-head h2 { margin: 0; font-size: var(--fs-16); font-weight: var(--fw-bold); letter-spacing: -.015em; line-height: var(--lh-tight) }
.sec-head p { margin: 0; color: var(--faint); font-size: var(--fs-13); flex: 1; min-width: 200px; line-height: 1.5 }
.sec-head .link-arrow { margin-left: auto }

/* hero */
.hero { padding: 48px 0 16px; max-width: 720px }
.hero .eyebrow { display: flex; align-items: center; gap: 10px; margin-bottom: 4px }
.hero h1 {
  margin: 12px 0 14px; font-size: var(--fs-32); line-height: var(--lh-tight);
  letter-spacing: -.03em; font-weight: 800; max-width: 18ch;
}
.hero p.lede {
  margin: 0 0 24px; color: var(--dim); font-size: var(--fs-16);
  line-height: 1.65; max-width: 60ch; letter-spacing: -.01em;
}
.hero-cta { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 22px }
.hero-status {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: var(--fs-13); color: var(--dim); flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-full); padding: 6px 14px 6px 10px;
  box-shadow: var(--shadow-xs);
}
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; box-shadow: 0 0 0 2px var(--ok-soft) }
.live-dot--warn { background: var(--warn); box-shadow: 0 0 0 2px var(--warn-soft) }
.live-dot--err { background: var(--err); box-shadow: 0 0 0 2px var(--err-soft) }
.live-dot--idle { background: var(--off); box-shadow: none }
.live-dot--pulse { animation: pulse 2.2s infinite var(--ease-in-out) }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1) } 50% { opacity: .6; transform: scale(.92) } }

/* capability categories */
.cat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px }
.cat {
  display: flex; flex-direction: column; gap: 12px; padding: 20px;
  text-align: left; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); color: var(--text); cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast), transform var(--t-fast), box-shadow var(--t-fast);
  min-width: 0; position: relative; overflow: hidden;
}
a.cat:hover { text-decoration: none; border-color: var(--border-2); background: var(--surface-2); transform: translateY(-1px); box-shadow: var(--shadow-sm) }
a.cat:active { transform: translateY(0px); box-shadow: var(--shadow-xs) }
.cat-top { display: flex; align-items: flex-start; gap: 12px }
.cat-ic {
  width: 36px; height: 36px; border-radius: var(--r-md); display: grid; place-items: center; flex: none;
  background: var(--surface-3); border: 1px solid var(--border-2); color: var(--dim);
  box-shadow: var(--shadow-xs);
}
.cat-ic svg { width: 18px; height: 18px }
.cat-top h3 { margin: 0; font-size: var(--fs-15); font-weight: 700; letter-spacing: -.015em; line-height: var(--lh-snug); flex: 1; min-width: 0 }
.cat-top .st { margin-left: auto; flex: none }
.cat p { margin: 0; font-size: var(--fs-13); color: var(--dim); line-height: 1.6; letter-spacing: -.005em }
.cat-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px }
.cat-tag {
  font-size: 11px; color: var(--faint); background: var(--bg-deep);
  border: 1px solid var(--border); border-radius: var(--r-full);
  padding: 3px 9px; white-space: nowrap; font-weight: 500; letter-spacing: -.01em;
}
.cat-foot {
  display: flex; align-items: center; gap: 10px; margin-top: auto; padding-top: 12px;
  border-top: 1px solid var(--border); font-size: var(--fs-12); color: var(--faint);
}

/* status pills */
.st {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 650; line-height: 1.2; letter-spacing: -.01em;
  padding: 4px 10px 4px 8px; border-radius: var(--r-full);
  border: 1px solid var(--border-2); background: var(--surface-2); color: var(--dim);
  white-space: nowrap; box-shadow: var(--shadow-xs);
}
.st svg { width: 12px; height: 12px; flex: none }
.st--ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 28%, var(--border-2)); background: var(--ok-soft) }
.st--warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 30%, var(--border-2)); background: var(--warn-soft) }
.st--err { color: var(--err); border-color: color-mix(in srgb, var(--err) 30%, var(--border-2)); background: var(--err-soft) }
.st--info { color: var(--accent-strong); border-color: color-mix(in srgb, var(--accent) 28%, var(--border-2)); background: var(--accent-soft) }
.st--off { color: var(--off); background: var(--surface-2) }
.st--idle { color: var(--faint); background: var(--surface-2) }

/* tables & kv */
.tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch }
.kv {
  display: grid; grid-template-columns: minmax(140px, 180px) 1fr;
  gap: 8px 16px; align-items: center; padding: 12px 18px;
  border-bottom: 1px solid var(--border); transition: background var(--t-fast);
}
.kv:last-child { border-bottom: 0 }
.kv:hover { background: color-mix(in srgb, var(--surface-2) 70%, transparent) }
.kv .k { color: var(--dim); font-size: var(--fs-13); min-width: 0; font-weight: var(--fw-medium); letter-spacing: -.01em }
.kv .v { min-width: 0; text-align: right; display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-wrap: wrap; font-size: var(--fs-13) }
.kv .d { color: var(--faint); font-size: var(--fs-12); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; flex-basis: 100%; line-height: 1.4 }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-13) }
.tbl th {
  text-align: left; font-weight: 700; color: var(--faint); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .12em; padding: 10px 18px; border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-2) 50%, transparent);
}
.tbl td { padding: 11px 18px; border-bottom: 1px solid var(--border); vertical-align: top }
.tbl tr:last-child td { border-bottom: 0 }
.tbl tr:hover td { background: color-mix(in srgb, var(--surface-2) 60%, transparent) }
.tbl td.t-r, .tbl th.t-r { text-align: right }
ul.list { margin: 0; padding: 0; list-style: none }
ul.list li {
  padding: 10px 18px; border-bottom: 1px solid var(--border);
  display: flex; gap: 10px; align-items: baseline; min-width: 0; font-size: var(--fs-13); line-height: 1.6;
}
ul.list li:last-child { border-bottom: 0 }
ul.list li .li-k { color: var(--dim); flex: 1; min-width: 0 }
.bullets { margin: 0; padding-left: 18px; color: var(--dim) }
.bullets li { margin: 6px 0; line-height: 1.6; font-size: var(--fs-13) }

/* mono / code */
.mono, code { font-family: var(--mono); font-size: 12.5px; letter-spacing: -.01em; font-variant-ligatures: none }
code.chip-v {
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--r-sm); padding: 2px 7px; color: var(--dim);
  user-select: all; -webkit-user-select: all; word-break: break-all;
  font-size: 12px; line-height: 1.4; font-weight: 450;
}
pre.codeblock {
  margin: 0; padding: 14px 16px; background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--r-md); font-family: var(--mono); font-size: 12px; line-height: 1.7;
  color: var(--dim); overflow-x: auto; -webkit-overflow-scrolling: touch;
}
.copy-inline { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end }
details.tech { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); overflow: hidden }
details.tech summary {
  cursor: pointer; padding: 12px 16px; font-size: var(--fs-13); font-weight: var(--fw-semibold);
  color: var(--dim); list-style: none; display: flex; align-items: center; gap: 10px;
  transition: background var(--t-fast), color var(--t-fast);
}
details.tech summary::-webkit-details-marker { display: none }
details.tech summary:hover { color: var(--text); background: var(--surface-2) }
details.tech summary svg { width: 14px; height: 14px; transition: transform var(--t-fast) }
details.tech[open] summary { border-bottom: 1px solid var(--border); background: var(--surface-2); color: var(--text) }
details.tech[open] summary svg { transform: rotate(90deg) }
details.tech .tech-bd { padding: 0 16px 16px; background: var(--bg-deep) }
details.tech pre.codeblock { max-height: 360px; overflow: auto; border: 0; background: transparent; padding: 12px 0 }

/* tools explorer */
.toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px }
.search { position: relative; flex: 1; min-width: 240px; max-width: 480px }
.search svg {
  position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
  width: 16px; height: 16px; color: var(--faint); pointer-events: none;
}
.search input {
  width: 100%; min-height: 40px; background: var(--bg-deep); border: 1px solid var(--border-2);
  border-radius: var(--r-md); color: var(--text); padding: 0 12px 0 36px;
  outline: none; font-size: var(--fs-14); font-weight: var(--fw-regular);
  transition: border-color var(--t-fast), box-shadow var(--t-fast), background var(--t-fast);
}
.search input::placeholder { color: var(--faint) }
.search input:hover { border-color: var(--border-3); background: var(--surface) }
.search input:focus { border-color: var(--accent); background: var(--surface); outline: none; box-shadow: 0 0 0 3px var(--accent-soft) }
.chips { display: flex; gap: 8px; flex-wrap: wrap }
.chip {
  font-size: var(--fs-12); font-weight: var(--fw-medium); letter-spacing: -.01em;
  padding: 0 12px; min-height: 32px; border-radius: var(--r-full); border: 1px solid var(--border-2);
  background: var(--surface); color: var(--dim); cursor: pointer;
  transition: all var(--t-fast); white-space: nowrap; display: inline-flex; align-items: center; gap: 6px;
}
.chip:hover { color: var(--text); border-color: var(--border-3); background: var(--surface-2); transform: translateY(-1px); box-shadow: var(--shadow-xs) }
.chip:active { transform: translateY(0px) }
.chip[aria-pressed="true"] {
  background: var(--surface-3); border-color: var(--border-3); color: var(--text);
  font-weight: var(--fw-semibold); box-shadow: var(--shadow-xs);
}
.chip .cnt {
  color: var(--faint); background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--r-full); padding: 1px 6px; font-size: 10.5px; font-weight: 650; min-width: 18px; text-align: center;
}
.chip[aria-pressed="true"] .cnt { background: var(--surface-4); color: var(--dim); border-color: var(--border-2) }
.tcount { color: var(--faint); font-size: var(--fs-12); margin-left: auto; font-weight: var(--fw-medium); letter-spacing: -.01em }

/* tool rows — premium density */
.trow {
  display: grid; grid-template-columns: minmax(200px, .95fr) minmax(0, 1.3fr) auto 20px;
  gap: 14px; align-items: center; padding: 14px 18px;
  border-bottom: 1px solid var(--border); cursor: pointer;
  background: none; border-left: 0; border-right: 0; border-top: 0;
  width: 100%; text-align: left; color: var(--text);
  transition: background var(--t-fast); min-height: 56px;
}
.trow:first-child { border-top: 0 }
button.trow:hover { background: var(--surface-2) }
.trow[aria-expanded="true"] { background: var(--surface-2); border-bottom-color: transparent }
.trow .tname {
  font-family: var(--mono); font-size: 13px; color: var(--text); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: flex; align-items: center; gap: 10px; font-weight: 550; letter-spacing: -.01em;
}
.trow .tdesc { color: var(--faint); font-size: var(--fs-13); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; line-height: 1.4 }
.trow .tgrp {
  font-size: 11px; color: var(--dim); background: var(--bg-deep);
  border: 1px solid var(--border); border-radius: var(--r-xs);
  padding: 3px 8px; white-space: nowrap; font-weight: 550; letter-spacing: -.01em;
}
.trow .tw { display: grid; place-items: center; color: var(--faint-2); transition: color var(--t-fast) }
.trow:hover .tw { color: var(--faint) }
.trow .tw svg { width: 16px; height: 16px; transition: transform var(--t-med) }
.trow[aria-expanded="true"] .tw { color: var(--dim) }
.trow[aria-expanded="true"] .tw svg { transform: rotate(90deg) }
.tstat { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px transparent; transition: box-shadow var(--t-fast) }
.tstat--ok { background: var(--ok); box-shadow: 0 0 0 2px var(--ok-soft) }
.tstat--warn { background: var(--warn); box-shadow: 0 0 0 2px var(--warn-soft) }
.tstat--err { background: var(--err); box-shadow: 0 0 0 2px var(--err-soft) }
.tstat--off { background: var(--off) }
.tstat--info { background: var(--accent) }
.tstat--idle { background: var(--off); opacity: .5 }
.tdetail {
  padding: 18px 20px 20px; border-bottom: 1px solid var(--border);
  background: var(--bg-deep); animation: detailIn var(--t-med);
}
@keyframes detailIn { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }
.tdetail .tdesc-full { color: var(--dim); font-size: var(--fs-13); line-height: 1.7; margin: 0 0 14px; max-width: 80ch; letter-spacing: -.005em }
.tdetail h4 {
  margin: 16px 0 8px; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase;
  color: var(--faint); font-weight: 700; line-height: 1.2;
}
.tdetail h4:first-of-type { margin-top: 0 }
.in-chip {
  font-family: var(--mono); font-size: 11px; color: var(--dim); background: var(--surface-2);
  border: 1px solid var(--border-2); border-radius: var(--r-xs); padding: 3px 8px; font-weight: 500;
}
.tfoot { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 16px }

/* browser / pipeline flows */
.flow { display: flex; flex-direction: column }
.flow-step { display: flex; gap: 14px; padding: 12px 18px; border-bottom: 1px solid var(--border); align-items: flex-start; transition: background var(--t-fast) }
.flow-step:last-child { border-bottom: 0 }
.flow-step:hover { background: color-mix(in srgb, var(--surface-2) 60%, transparent) }
.flow-num {
  flex: none; width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--border-2); background: var(--bg-deep); color: var(--dim);
  font-size: 11px; display: grid; place-items: center; font-family: var(--mono); font-weight: 600; margin-top: 1px;
}
.flow-txt { min-width: 0; flex: 1 }
.flow-txt code { color: var(--accent-strong); font-weight: 600 }
.flow-txt .fx-d { color: var(--faint); font-size: var(--fs-12); line-height: 1.6; margin-top: 2px }
.bar { height: 4px; border-radius: var(--r-full); background: var(--surface-3); overflow: hidden; margin: 8px 0 2px }
.bar > i { display: block; height: 100%; background: var(--accent); border-radius: var(--r-full) }

/* access strip + page head */
.access-strip {
  display: flex; gap: 16px; align-items: flex-start;
  border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface);
  padding: 18px 20px; margin-top: 16px; box-shadow: var(--shadow-xs);
}
.access-strip .note { flex: 1; min-width: 240px; margin: 0 }
.page-head { padding: 16px 0 8px; max-width: 760px }
.page-head h1 {
  margin: 10px 0 10px; font-size: 28px; line-height: var(--lh-tight);
  letter-spacing: -.03em; font-weight: 800;
}
.page-head p { margin: 0; color: var(--dim); font-size: var(--fs-15); line-height: 1.6; letter-spacing: -.01em }
.center-404 { text-align: center; padding: 80px 20px; max-width: 520px; margin: 0 auto }
.center-404 h1 { font-size: 28px; letter-spacing: -.025em; margin: 16px 0 10px; font-weight: 800; line-height: var(--lh-tight) }
.center-404 p { color: var(--dim); margin: 0 0 24px; font-size: var(--fs-15); line-height: 1.6 }

/* modal */
.overlay {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(4,6,10,.68); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  display: grid; place-items: center; padding: 24px;
  animation: overlayIn var(--t-med);
}
@keyframes overlayIn { from { opacity: 0 } to { opacity: 1 } }
@media (prefers-color-scheme: light) { :root:not([data-theme]) .overlay { background: rgba(20,24,32,.32) } }
:root[data-theme="light"] .overlay { background: rgba(20,24,32,.32) }
.overlay[hidden] { display: none }
.modal {
  width: min(560px, 100%); background: var(--surface); border: 1px solid var(--border-2);
  border-radius: var(--r-xl); box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column; max-height: calc(100vh - 48px);
  animation: pop var(--t-med); overflow: hidden;
}
.modal-hd { display: flex; align-items: flex-start; gap: 14px; padding: 22px 22px 0; flex: none }
.modal-ic {
  width: 40px; height: 40px; border-radius: var(--r-md); display: grid; place-items: center; flex: none;
  background: var(--surface-3); border: 1px solid var(--border-2); color: var(--dim); box-shadow: var(--shadow-xs);
}
.modal-ic svg { width: 20px; height: 20px }
.modal-hd h3 { margin: 0; font-size: var(--fs-16); font-weight: 750; letter-spacing: -.015em; line-height: var(--lh-snug) }
.modal-hd .sub { margin: 4px 0 0; font-size: var(--fs-13); color: var(--dim); line-height: 1.5; letter-spacing: -.01em }
.modal-hd .x { margin-left: auto; flex: none }
.modal-bd { padding: 20px 22px 22px; overflow-y: auto; overscroll-behavior: contain; flex: 1; min-height: 0 }
.modal-ft {
  padding: 14px 22px; border-top: 1px solid var(--border);
  display: flex; gap: 12px; align-items: center; color: var(--faint);
  font-size: var(--fs-12); background: var(--surface-2); flex: none; flex-wrap: wrap;
}
.modal-ft svg { width: 14px; height: 14px }
.modal-steps { margin: 16px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 12px }
.modal-steps li { display: flex; gap: 12px; font-size: var(--fs-13); color: var(--dim); line-height: 1.6; letter-spacing: -.005em }
.modal-steps .n {
  flex: none; width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--border-2); background: var(--bg-deep); color: var(--dim);
  font-size: 11px; display: grid; place-items: center; font-family: var(--mono); font-weight: 600; margin-top: 1px;
}
.endpoint {
  display: flex; align-items: center; gap: 12px;
  background: var(--bg-deep); border: 1px solid var(--border-2);
  border-radius: var(--r-md); padding: 14px 14px 14px 16px;
  transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
.endpoint:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft) }
.endpoint code {
  flex: 1; min-width: 0; font-size: var(--fs-13); color: var(--text);
  background: none; border: 0; padding: 0; user-select: all; -webkit-user-select: all;
  word-break: break-all; line-height: 1.5; overflow-x: auto; white-space: nowrap;
  font-weight: 500;
}
.endpoint .btn { height: 38px; flex: none; font-weight: 650 }
.modal-note { margin-top: 16px; font-size: var(--fs-12); color: var(--faint); line-height: 1.65; letter-spacing: -.005em }
.modal-note b { color: var(--dim); font-weight: var(--fw-semibold) }

/* connect dialog — premium */
.connect-modal { width: min(580px, 100%); max-height: min(760px, calc(100dvh - 32px)) }
.connect-modal .modal-hd > div { min-width: 0; flex: 1 }
.connect-pane { animation: connect-in var(--t-med) }
@keyframes connect-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.prov-list { display: flex; flex-direction: column; gap: 4px }
.prov {
  display: grid; grid-template-columns: 40px minmax(0, 1fr) 18px; gap: 14px; align-items: center;
  width: 100%; text-align: left; background: transparent; border: 1px solid transparent;
  border-radius: var(--r-md); padding: 10px 12px; cursor: pointer; color: inherit;
  min-height: 64px; transition: all var(--t-fast);
}
.prov:hover, .prov:focus-visible { background: var(--surface-2); border-color: var(--border); text-decoration: none; outline: none; box-shadow: var(--shadow-xs) }
.prov:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft) }
.prov-mark {
  width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
  background: var(--surface-3); border: 1px solid var(--border-2); color: var(--text);
  box-shadow: var(--shadow-xs); transition: all var(--t-fast);
}
.prov:hover .prov-mark { background: var(--surface-4); border-color: var(--border-3) }
.prov-mark svg { width: 20px; height: 20px }
.prov-txt { min-width: 0 }
.prov-name {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: var(--fs-14); font-weight: 700; letter-spacing: -.01em; line-height: 1.3;
}
.prov-sum { display: block; margin-top: 3px; font-size: var(--fs-12); color: var(--faint); line-height: 1.4; letter-spacing: -.01em }
.prov-chev { color: var(--faint-2); transition: color var(--t-fast), transform var(--t-fast) }
.prov:hover .prov-chev { color: var(--faint) }
.prov-chev svg { width: 16px; height: 16px }
.pill {
  font-size: 10px; letter-spacing: .05em; text-transform: uppercase; font-weight: 700;
  color: var(--faint); border: 1px solid var(--border-2); border-radius: var(--r-full);
  padding: 2px 8px; white-space: nowrap; background: var(--bg-deep);
}
.pill--verified { color: var(--accent-strong); border-color: color-mix(in srgb, var(--accent) 32%, var(--border-2)); background: var(--accent-soft) }
.endpoint-label { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); font-weight: 700 }
.connect-meta { margin: 0 0 14px; font-size: var(--fs-12); color: var(--faint); line-height: 1.5; letter-spacing: -.01em }
.connect-callout { margin: 14px 0 0; font-size: var(--fs-13); color: var(--dim); line-height: 1.6; letter-spacing: -.005em }
.connect-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 16px }
.connect-actions .btn { width: 100%; min-height: 44px; font-size: var(--fs-14) }
.connect-status {
  margin: 12px 0 0; font-size: var(--fs-12); color: var(--dim); line-height: 1.6;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-md);
  padding: 10px 12px; letter-spacing: -.01em;
}
.connect-status:empty { display: none }
.connect-config {
  margin-top: 14px; background: var(--bg-deep); border: 1px solid var(--border-2);
  border-radius: var(--r-md); overflow: hidden; box-shadow: var(--shadow-xs);
}
.connect-config-hd {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 12px; border-bottom: 1px solid var(--border);
  font-size: var(--fs-12); color: var(--dim); font-weight: var(--fw-medium);
  background: var(--surface-2);
}
.connect-config pre {
  margin: 0; padding: 12px 14px; overflow-x: auto; font-family: var(--mono);
  font-size: 12px; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-break: break-word;
}
.connect-notes { margin: 14px 0 0; padding: 0 0 0 18px; color: var(--faint); font-size: var(--fs-12); line-height: 1.6 }
.connect-notes li + li { margin-top: 6px }
.connect-links { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 16px; font-size: var(--fs-12) }
.connect-links a { display: inline-flex; align-items: center; gap: 5px; font-weight: var(--fw-medium); color: var(--dim) }
.connect-links a:hover { color: var(--text) }
.connect-links svg { width: 12px; height: 12px }
.connect-ft { flex-wrap: wrap; gap: 10px 16px }
.connect-ft-note { display: flex; align-items: flex-start; gap: 8px; flex: 1 1 220px; min-width: 0; line-height: 1.4 }
.connect-ft-note svg { flex: none; margin-top: 1px; width: 14px; height: 14px }
.connect-ft-url {
  font-family: var(--mono); font-size: 11px; color: var(--dim); word-break: break-all;
  flex: 1 1 180px; min-width: 0; background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--r-xs); padding: 4px 8px;
}

/* command palette — premium */
.palette {
  width: min(640px, 100%); background: var(--surface); border: 1px solid var(--border-2);
  border-radius: var(--r-lg); box-shadow: var(--shadow-lg); overflow: hidden;
  display: flex; flex-direction: column; max-height: min(70vh, 560px);
  animation: pop var(--t-med);
}
.palette .p-search {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid var(--border); flex: none;
}
.palette .p-search svg { width: 18px; height: 18px; color: var(--faint); flex: none }
.palette .p-search input {
  flex: 1; background: none; border: 0; outline: none; color: var(--text);
  font-size: 15px; min-width: 0; font-weight: var(--fw-regular); letter-spacing: -.01em;
}
.palette .p-search input::placeholder { color: var(--faint) }
.palette .p-results { overflow-y: auto; padding: 8px; flex: 1; min-height: 0 }
.p-item {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  background: none; border: 1px solid transparent; border-radius: var(--r-md);
  padding: 10px 12px; cursor: pointer; color: var(--dim); min-height: 44px;
  transition: all var(--t-fast);
}
.p-item svg { width: 18px; height: 18px; color: var(--faint); flex: none }
.p-item .p-lbl { color: var(--text); font-size: var(--fs-13); font-weight: var(--fw-medium); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: -.01em }
.p-item .p-kind { margin-left: auto; font-size: 10.5px; color: var(--faint); letter-spacing: .06em; text-transform: uppercase; flex: none; font-weight: 600 }
.p-item[aria-selected="true"], .p-item:hover { background: var(--surface-3); color: var(--text); border-color: var(--border); text-decoration: none }
.p-item[aria-selected="true"] { box-shadow: var(--shadow-xs) }
.p-empty { padding: 28px 16px; text-align: center; color: var(--faint); font-size: var(--fs-13) }
kbd {
  font-family: var(--mono); font-size: 11px; color: var(--dim); background: var(--surface-2);
  border: 1px solid var(--border-2); border-bottom-width: 2px; border-radius: 6px;
  padding: 2px 6px; line-height: 1.4; font-weight: 550; box-shadow: var(--shadow-xs);
}

/* toasts, skeletons, states */
.toasts {
  position: fixed; bottom: 20px; right: 20px; z-index: 95;
  display: flex; flex-direction: column; gap: 10px; pointer-events: none;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.toast {
  display: flex; align-items: center; gap: 10px;
  background: var(--surface-3); border: 1px solid var(--border-2); border-radius: var(--r-md);
  padding: 10px 14px; font-size: var(--fs-13); color: var(--text); font-weight: var(--fw-medium);
  box-shadow: var(--shadow-md); animation: pop var(--t-fast); pointer-events: auto; min-height: 40px;
  letter-spacing: -.01em;
}
.toast svg { width: 16px; height: 16px; color: var(--ok); flex: none }
.skel {
  border-radius: var(--r-xs);
  background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%);
  background-size: 200% 100%; animation: shimmer 1.4s infinite linear; height: 12px; margin: 8px 0;
}
.skel--lg { height: 72px; border-radius: var(--r-md) }
@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
.err-card { border-color: color-mix(in srgb, var(--err) 28%, var(--border)); background: color-mix(in srgb, var(--err-soft) 50%, var(--surface)) }
.err-card .panel-hd { border-bottom-color: color-mix(in srgb, var(--err) 16%, var(--border)); background: var(--err-soft) }
.note { font-size: var(--fs-13); color: var(--dim); line-height: 1.7; letter-spacing: -.005em }
.note b, .note strong { color: var(--text); font-weight: 650 }
.note-warn {
  border: 1px solid color-mix(in srgb, var(--warn) 22%, var(--border)); background: var(--warn-soft);
  border-radius: var(--r-md); padding: 12px 14px; font-size: var(--fs-12); color: var(--dim); line-height: 1.65;
  letter-spacing: -.005em;
}
.badge-secure {
  display: inline-flex; gap: 8px; align-items: center; font-size: 11.5px; font-weight: 650;
  color: var(--dim); border: 1px solid var(--border-2); border-radius: var(--r-full);
  padding: 5px 12px; white-space: nowrap; background: var(--surface-2); letter-spacing: -.01em;
}
.badge-secure svg { width: 14px; height: 14px; color: var(--ok) }

/* animations */
@keyframes pop {
  from { transform: translateY(8px) scale(.98); opacity: 0 }
  to { transform: none; opacity: 1 }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important }
  html { scroll-behavior: auto }
}

/* responsive */
@media (max-width: 1100px) {
  .grid--2, .grid--3 { grid-template-columns: 1fr }
  .cat-grid { grid-template-columns: repeat(2, 1fr) }
}
@media (max-width: 900px) {
  :root { --content-px: 20px }
  .content { padding: 24px var(--content-px) 64px }
  .header-in { padding: 0 var(--content-px) }
  .foot-in { padding: 16px var(--content-px) }
  .nav { display: none }
  .menu-btn { display: grid }
  .header-actions .btn span.lbl { display: none }
  .header-actions .btn--smhide { width: 40px; padding: 0 }
  .hero { padding: 32px 0 8px }
  .hero h1 { font-size: var(--fs-28) }
}
@media (max-width: 768px) {
  .hero { padding: 28px 0 8px }
  .hero h1 { font-size: 26px; line-height: 1.15 }
  .hero p.lede { font-size: var(--fs-15); line-height: 1.6 }
  .cat-grid { grid-template-columns: 1fr; gap: 12px }
  .cat { padding: 18px }
  /* premium 2-line tool rows on tablet/mobile — keeps context */
  .trow {
    grid-template-columns: 1fr auto 20px;
    grid-template-rows: auto auto;
    gap: 6px 12px; padding: 14px 16px; min-height: 64px;
    align-items: start;
  }
  .trow .tname { grid-column: 1; grid-row: 1; font-size: 13px; white-space: normal; line-height: 1.35 }
  .trow .tgrp { grid-column: 2; grid-row: 1; align-self: center }
  .trow .tw { grid-column: 3; grid-row: 1 / span 2; align-self: center }
  .trow .tdesc { grid-column: 1 / span 2; grid-row: 2; display: block; white-space: normal; line-height: 1.45; font-size: 12px }
  .tdetail { padding: 14px 16px 16px }
  .kv { grid-template-columns: 1fr; gap: 8px; padding: 12px 16px }
  .kv .v, .kv .d { text-align: left; justify-content: flex-start }
  .copy-inline { justify-content: flex-start }
  .tcount { margin-left: 0; flex: 1; order: 10 }
  .toolbar { gap: 10px }
  .toolbar .search { max-width: none; min-width: 0; flex-basis: 100% }
  .access-strip { flex-direction: column; padding: 16px }
  .foot-links { margin-left: 0 }
  .search input, .palette .p-search input { font-size: 16px } /* prevent iOS zoom */
  .sec-head { margin: 28px 0 14px }
  .page-head h1 { font-size: 24px }
}
@media (max-width: 640px) {
  :root { --content-px: 16px; --header-h: 58px }
  .content { padding: 20px var(--content-px) 72px }
  .overlay { place-items: end center; padding: 0; backdrop-filter: blur(12px) }
  .modal, .palette {
    width: 100%; max-height: 92dvh; max-height: 92vh;
    border-radius: var(--r-lg) var(--r-lg) 0 0; border-bottom: 0;
    animation: slideup var(--t-med); box-shadow: var(--shadow-lg);
  }
  .palette { max-height: 84dvh }
  .modal-hd { padding: 20px 16px 0 }
  .modal-bd { padding: 16px 16px max(20px, env(safe-area-inset-bottom, 0px)) }
  .modal-ft { padding: 12px 16px max(16px, env(safe-area-inset-bottom, 0px)); }
  .endpoint { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px }
  .endpoint code { font-size: 13px; padding: 4px 2px; white-space: normal; word-break: break-all; line-height: 1.5 }
  .endpoint .btn { justify-content: center; min-height: 48px; width: 100% }
  .btn--touch, .modal .btn, .connect-actions .btn { min-height: 48px }
  .connect-modal { padding-bottom: 0; max-height: 94dvh }
  .connect-modal .btn--icon { width: 44px; height: 44px }
  .prov { min-height: 64px; padding: 12px; grid-template-columns: 44px 1fr 16px; gap: 12px }
  .prov-mark { width: 44px; height: 44px; border-radius: 12px }
  .hero-cta .btn { flex: 1; justify-content: center; min-height: 48px }
  .toasts { left: 16px; right: 16px; bottom: max(16px, env(safe-area-inset-bottom, 0px)); }
  .toast { justify-content: flex-start }
  .chips { gap: 6px }
  .chip { min-height: 36px; padding: 0 14px }
  .menu .mi { min-height: 48px; padding: 12px 14px }
  .panel-hd { padding: 12px 16px }
  .panel-bd { padding: 16px }
  .tbl th, .tbl td { padding: 10px 14px }
}
@media (max-width: 480px) {
  .hero h1 { font-size: 24px }
  .hero p.lede { font-size: 14px }
  .cat { padding: 16px }
  .cat-top h3 { font-size: 14px }
}
@keyframes slideup { from { transform: translateY(20px); opacity: 0 } to { transform: none; opacity: 1 } }

/* extra polish */
::selection { background: var(--accent-soft) }
::-webkit-scrollbar { width: 8px; height: 8px }
::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: var(--r-full) }
::-webkit-scrollbar-track { background: transparent }
* { scrollbar-width: thin; scrollbar-color: var(--border-2) transparent }

/* ensure long content never breaks layout */
.tname, .tdesc, .prov-name, .prov-sum, .k, .v, .d, .li-k, .cat p, .cat-top h3 {
  overflow-wrap: break-word; word-break: break-word;
}
.tname, .cat-top h3, .prov-name { word-break: normal; overflow-wrap: anywhere }

/* empty & unavailable states */
.empty-state {
  padding: 32px 20px; text-align: center; color: var(--faint);
  display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.empty-state svg { width: 32px; height: 32px; color: var(--faint-2) }
.empty-state h4 { margin: 0; font-size: var(--fs-14); font-weight: var(--fw-semibold); color: var(--dim) }
.empty-state p { margin: 0; font-size: var(--fs-13); line-height: 1.6; max-width: 36ch }

/* focus improvements */
.menu a.mi:focus-visible, .menu button.mi:focus-visible,
.cat:focus-visible, .prov:focus-visible, .p-item:focus-visible,
.trow:focus-visible {
  outline: 2px solid var(--ring); outline-offset: 2px;
}

/* premium subtle dividers */
hr.soft { border: 0; border-top: 1px solid var(--border); margin: 16px 0 }

/* improved code copy */
.codeblock { position: relative }
.codeblock:hover { border-color: var(--border-2) }
/* ── 2.1 additions: theme toggle, auth pages, account dashboard, connect hub ── */

/* theme toggle */
.theme-btn { position: relative }
.theme-btn .th-ico { display: none }
.theme-btn[data-theme-state="light"] .th-sun,
.theme-btn[data-theme-state="dark"] .th-moon,
.theme-btn[data-theme-state="auto"] .th-auto { display: block }

/* auth pages */
.auth-wrap { max-width: 460px; margin: 24px auto 0 }
.auth-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xl); box-shadow: var(--shadow-sm); overflow: hidden }
.auth-tabs { display: grid; grid-template-columns: repeat(2, 1fr); border-bottom: 1px solid var(--border) }
.auth-tabs button { padding: 14px; font-weight: var(--fw-semibold); font-size: var(--fs-14); color: var(--faint); border-bottom: 2px solid transparent; transition: color var(--t-fast), border-color var(--t-fast) }
.auth-tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent) }
.auth-tabs button:hover { color: var(--text) }
.auth-body { padding: 24px 24px 26px }
.auth-body h1 { margin: 0 0 6px; font-size: var(--fs-20); letter-spacing: -.02em; font-weight: var(--fw-bold) }
.auth-body .auth-sub { margin: 0 0 18px; color: var(--dim); font-size: var(--fs-13); line-height: 1.55 }
.form-field { display: grid; gap: 7px; margin-bottom: 14px }
.form-field label { font-size: var(--fs-13); font-weight: var(--fw-medium); color: var(--dim) }
.form-field input {
  width: 100%; min-height: 44px; padding: 10px 13px;
  background: var(--bg-deep); border: 1px solid var(--border-2); border-radius: var(--r-md);
  color: var(--text); font: var(--fw-regular) var(--fs-14)/1.4 var(--sans);
  transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
.form-field input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft) }
.form-field input[aria-invalid="true"] { border-color: var(--err) }
.form-hint { font-size: var(--fs-12); color: var(--faint); line-height: 1.5 }
.form-error {
  margin: 0 0 14px; padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--err) 38%, transparent);
  border-radius: var(--r-md); background: var(--err-soft); color: var(--err);
  font-size: var(--fs-13); line-height: 1.5;
}
.form-success {
  margin: 0 0 14px; padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--ok) 38%, transparent);
  border-radius: var(--r-md); background: var(--ok-soft); color: var(--ok);
  font-size: var(--fs-13); line-height: 1.5;
}
.form-actions { display: flex; gap: 10px; align-items: center; margin-top: 18px }
.form-actions .btn--primary { flex: 1; min-height: 44px; justify-content: center }
.auth-alt { margin-top: 16px; text-align: center; font-size: var(--fs-13); color: var(--faint) }
.auth-alt button { color: var(--accent-strong); font-weight: var(--fw-medium) }
.auth-alt button:hover { text-decoration: underline }
.password-rules { margin: 8px 0 0; padding-left: 18px; color: var(--faint); font-size: var(--fs-12); line-height: 1.7 }
.spin { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px }
@keyframes spin { to { transform: rotate(360deg) } }

/* account dashboard */
.acct-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap }
.acct-avatar {
  width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; flex: none;
  background: var(--accent-soft); color: var(--accent-strong); font-weight: var(--fw-bold); font-size: var(--fs-20);
}
.acct-id h2 { margin: 0; font-size: var(--fs-18); letter-spacing: -.02em }
.acct-id p { margin: 2px 0 0; color: var(--faint); font-size: var(--fs-12); font-family: var(--mono) }
.sess-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border) }
.sess-row:first-child { border-top: 0; padding-top: 0 }
.sess-row .sess-info { min-width: 0; flex: 1 }
.sess-row .sess-label { font-size: var(--fs-13); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.sess-row .sess-meta { font-size: var(--fs-12); color: var(--faint); margin-top: 2px }
.danger-zone { border-color: color-mix(in srgb, var(--err) 34%, var(--border)) }
.danger-zone .panel-hd h3 { color: var(--err) }
.verify-banner {
  display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; margin-bottom: 16px;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: var(--r-md);
  background: var(--warn-soft); color: var(--warn); font-size: var(--fs-13); line-height: 1.5;
}
.verify-banner svg { flex: none; margin-top: 1px; width: 15px; height: 15px }
.verify-banner a, .verify-banner button { color: inherit; font-weight: var(--fw-semibold); text-decoration: underline }

/* connect hub: platform card grid */
.connect-modal { width: min(720px, 100%) }
.plat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px }
.plat-card {
  display: flex; flex-direction: column; gap: 10px; align-items: flex-start; text-align: left;
  padding: 16px; border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface); cursor: pointer; min-height: 148px;
  transition: border-color var(--t-fast), box-shadow var(--t-fast), transform var(--t-fast), background var(--t-fast);
}
.plat-card:hover, .plat-card:focus-visible {
  border-color: var(--border-3); background: var(--surface-2); box-shadow: var(--shadow-sm);
  transform: translateY(-1px); outline: none; text-decoration: none;
}
.plat-card:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft) }
.plat-logo {
  width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center; flex: none;
  border: 1px solid var(--border-2); background: var(--bg-deep); color: var(--text);
}
.plat-logo svg { width: 24px; height: 24px }
.plat-name { font-weight: var(--fw-semibold); font-size: var(--fs-14); display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
.plat-desc { font-size: var(--fs-12); color: var(--faint); line-height: 1.5; flex: 1 }
.plat-cta { font-size: var(--fs-12); font-weight: var(--fw-semibold); color: var(--accent-strong); display: inline-flex; align-items: center; gap: 5px }
.plat-cta svg { width: 13px; height: 13px }
.plat-detail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px }
.plat-detail-head .plat-logo { width: 44px; height: 44px; border-radius: 12px }
.conn-state {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px;
  border-radius: var(--r-full); font-size: 11px; font-weight: 650; letter-spacing: .01em;
  border: 1px solid var(--border-2); background: var(--surface-2); color: var(--faint);
}
.conn-state svg { width: 12px; height: 12px }
.conn-state--setup { color: var(--warn); background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 34%, transparent) }
.conn-state--manual { color: var(--dim) }

/* keep .prov list (fallback/legacy clients) spacing consistent with the grid */
.prov-list { gap: 8px; margin-top: 12px }

@media (max-width: 560px) {
  .auth-wrap { margin-top: 8px }
  .plat-grid { grid-template-columns: 1fr 1fr }
  .plat-card { min-height: 132px; padding: 13px }
}
@media (max-width: 400px) {
  .plat-grid { grid-template-columns: 1fr }
}
`;
