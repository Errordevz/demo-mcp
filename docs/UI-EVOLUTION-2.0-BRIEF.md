# DEMO UI Evolution 2.0 — Research & Design Brief

> **Historical design brief.** The Roblox linking contract has since changed: the UI opens the Cloudflare Access-protected `/oauth/roblox/link` form, which accepts only a short-lived code minted by `roblox_account_link_start`. The current implementation and deployment instructions are in [`ROBLOX.md`](ROBLOX.md) and [`CONNECT-MCP.md`](CONNECT-MCP.md).

**Date:** 2026-09-26
**Version:** 0.9.0 base
**Scope:** Complete premium UX overhaul, no backend rewrite

## 1. Current-State Findings

### Repository & Architecture
- Cloudflare Workers deployment, entry `platform-entry.ts` -> `index.ts` MCP handler + `ui.ts` inspector
- UI is one self-contained HTML document, inline CSS (`src/ui/styles.ts`) + inline JS (`src/ui/app-script.ts`)
- CSP locked: `default-src 'none'`, `connect-src 'self'`, inline style/script only, no external requests (verified in `tests/security-hardening.test.ts`)
- Boot payload: `window.__DEMO_BOOT__` with catalog, groups, sections, clients, endpoint
- Tool catalog generated via `scripts/generate-tool-catalog.mjs`, pinned by `tests/tool-catalog.test.ts`
- No framework, vanilla JS hash router, live data from same-origin `/health`, `/platform/stats`, `/capabilities/*`, `/oauth/roblox/status`

### Routes & Deep Links (mapped)
- `#/overview` — default, hero + capability categories + deployment status + access model
- `#/capabilities` — category cards + tool explorer (search, group filter, availability filter)
- `#/tools` — hidden nav, compact alias of explorer (legacy kept working)
- `#/status` — deployment rows, capability rows, connections table, endpoints list
- `#/browser` — subsystem state, session workflow, browser tools list
- `#/video` — pipeline stages, platform support (lazy `/capabilities/video`), providers, guardrails, honesty contract
- `#/research` — expanded capabilities (lazy `/capabilities/expanded`), web extraction/diff/monitor, sources, research tools
- `#/routing` — decision routing mode, Jev/Laya config presence-only, commands, decision tools
- `#/roblox` — optional Roblox OAuth, connect/disconnect via the Access-protected `/oauth/roblox/link` code form and `/oauth/roblox/logout`, status, details
- `#/skills` — builtin skills + skills.sh surface
- `#/about` — project, security & privacy, routes, architecture
- `#/notfound` — polished 404 for unknown hashes
- Hash navigation preserves back/forward via `hashchange` listener
- Command palette: `Ctrl/⌘+K`, jump to sections, copy endpoint, refresh telemetry, open explorer

### Navigation & Components
- Header: brand (D + version), primary nav (Overview, Capabilities, Status + Docs, Source), search button, Connect MCP button, mobile menu button
- Mobile menu: `.menu` panel, `body.menu-open` toggle, same primary + secondary + resources + CTA
- Footer: version, tool count, telemetry timestamp, isolate age, no cookies notice, links
- Panels: `.panel` with `.panel-hd` + `.panel-bd`, used everywhere
- Hero: eyebrow, h1, lede, CTA row, live-dot status
- Category cards: `.cat` as `<a>`, icon, title, status pill, description, highlights tags, foot count + arrow
- Tool explorer: `.toolbar` with search + chips + availability chips, `.trow` rows, `.tdetail` expanded
- Status: `.kv` key-value rows, `.tbl` tables
- Modals: `.overlay` with `.modal` (Connect) and `.palette` (command palette)
- Connect dialog: picker list `.prov` (icon, name, badge, summary, chevron), confirm view with endpoint block, callout, actions, steps, config snippets, limitations, links, footer with shield note
- Toasts: bottom-right, auto-dismiss
- Skeletons: shimmer gradient

### Design Tokens (existing)
- Dark: bg #0a0b0e, surface #0e1014, surface-2 #13161c, surface-3 #191d24, border #1d222b, text #e8ebf0, dim #9aa3b1, faint #6b7382, accent #5ba8f7, ok #3ddc97, warn #f5c04a, err #f2777a
- Light: bg #f7f7f8, surface #ffffff, border #e5e5ea, text #17171c, accent #1f6feb
- Mono + sans system stacks, fs-11 to fs-28, radius sm 6px to xl 16px, shadow md/lg, t-fast 120ms, t-med 180ms, maxw 1120px, header-h 58px
- No spacing scale, no typography line-height scale, no elevation scale

### Interaction States (existing)
- Buttons: hover bg surface-3, active translateY(1px), disabled opacity .55
- Nav links: hover bg surface-2, active aria-current bg surface-3
- Cards: hover border-3 + bg surface-2
- Search input: focus border accent + box-shadow
- Chips: hover border-3, pressed bg surface-3
- Tool rows: hover bg surface-2, expanded bg surface-2, chevron rotate 90deg
- Modal: pop animation 180ms, overlay dark 66% (light 40%)
- Reduced-motion: disables all animations
- Copy: clipboard API + execCommand fallback, success swaps label to "Copied!" + toast

### Backend & Data Sources
- `/health` — live version, browser, video flags, roblox/jev/laya/youtube flags, capabilities
- `/platform/stats` — generatedAt, uptime, toolCount, capabilities, connections, endpoints
- `/capabilities/video` — lazy, platforms, providers, limits
- `/capabilities/expanded` — lazy, git, archive, feeds, pdf, images, web, openapi, network, utilities, research, urlSafety
- `/oauth/roblox/status` — connection state, config, account
- All fetches `cache: no-store`, Accept: application/json, same-origin

### Constraints
- No external fonts, no frameworks, no analytics, no cookies on JSON routes, no login, no tracking
- Must preserve the `location.href='/oauth/roblox/link'` code-form handoff and "Connect Roblox account" / "Disconnect" labels (pinned by tests)
- Must preserve MCP endpoint `https://demo-mcp.amidevz.workers.dev/mcp` exact (pinned)
- Must preserve Connect dialog strings: "Connect DEMO", "Choose where you want to connect DEMO.", "No DEMO account required.", "This dialog never confirms a connection.", "Copied!"
- Must preserve client URL builders (Claude, Cursor, VS Code, ChatGPT) exactly — no invented params
- Bundle must stay lightweight, vanilla JS, no new dependencies
- Preserve all routes and deep links, hash navigation, back/forward

### Tests & Coverage
- `ui-shell.test.ts` — HTML contract + jsdom smoke: shell, live data, Connect picker → verified handoffs → copy → Esc, tool search, capabilities, status, 404, Roblox degrade, routing presence-only, video/research lazy
- `mcp-clients.test.ts` — URL builders pinned, boot payload same as registry, no secrets, no invented schemes
- `security-hardening.test.ts` — CSP, no secrets
- `tool-catalog.test.ts` — catalog vs DEMO_TOOL_NAMES
- 40+ other tests covering browser, video, git, feeds, etc. — UI changes must not break them

### Known Bugs / Gaps
- Tool rows on mobile hide description and group (grid 1fr auto 18px) — loses context
- Menu button 38px < 44px touch target on mobile, no focus trap for menu
- Endpoint block on mobile stacks but code font becomes tiny and wraps poorly
- No explicit empty states for browser/video/research/routing/skills/about when data missing
- Status cards duplicate overview logic but with slightly different wording
- Light theme contrast for `--dim` on white may be low
- No visible loading spinner, only skeleton shimmer
- No handling for long tool names breaking layout (overflow hidden but no title attribute)
- No safe-area handling for iPhone bottom inset beyond connect-modal padding
- No keyboard shortcut hint for search besides aria-label
- Footer bits use · separator but no semantic list

### Must Not Change
- Worker architecture, MCP endpoint, API contracts, no-login, CSP, security headers, same-origin fetch, origin checks, tool descriptions accuracy, routes, hash navigation, client URL builders, Roblox OAuth literals

## 2. User Personas

1. **First-time developer (discovery)** — lands on root, needs to understand what DEMO does in 10 seconds, see live status, find endpoint, trust no-login
2. **Connector (MCP client setup)** — wants to add DEMO to Claude/Cursor/VS Code/ChatGPT, needs verified link, copy endpoint, manual fallback, clarity that DEMO can't confirm connection
3. **Tool explorer (capability evaluation)** — searches 80+ tools, filters by group/state, reads inputs, understands availability gating
4. **Operator (status checker)** — checks if browser/video/storage/decisions are operational, distinguishes DEMO vs external integration health
5. **Mobile browser (iPhone Safari)** — browses docs on phone, no horizontal overflow, 44px touch targets, readable typography, dialogs not clipped
6. **Power user (immediate access)** — wants endpoint + setup instructions without scrolling through marketing

## 3. Main User Journeys

### J1: Discover DEMO
- Goal: Understand value, trust, no-login
- Required: tagline, blurb, live operational badge, capability categories, access model strip
- Primary action: scroll overview or jump to capabilities
- Failure: telemetry unreachable → honest error + retry + technical details
- Success: sees 6 categories with live pills, understands no account needed

### J2: Connect MCP
- Goal: Add server to client
- Required: prominent Connect button, picker with verified vs manual, exact endpoint `https://demo-mcp.amidevz.workers.dev/mcp`, copy with feedback, steps, limitations
- Unnecessary: extra confirmation dialogs, account creation
- Failure: clipboard blocked → "select manually" toast; client app not installed → manual config shown
- Success: copies endpoint or opens client install link, sees note that DEMO cannot confirm connection

### J3: Explore Tools
- Goal: Find relevant tool, understand inputs, availability
- Required: search, group filter (browser/video/web/roblox/skills/intel/storage), state filter, count, row with availability dot + name + description + group, detail with description + inputs + example + copy
- Failure: no results → empty state with suggestion; availability unknown → "Checking" pill
- Success: filters to 1 tool, expands detail, copies name

### J4: Check Status
- Goal: Is DEMO + dependencies healthy?
- Required: deployment rows (version, endpoint, tool count, telemetry time, isolate age), capabilities rows (browser, sessions, screenshots, video pipeline, storage, decisions, Roblox), connections, endpoints, technical details collapsible
- Failure: /health or /platform/stats fails → degraded banner + retry
- Success: sees Operational/Degraded with icon + text, not color alone

### J5: Browse Docs on Phone
- Goal: Read browser/video/research/routing/roblox/skills/about on iPhone
- Required: responsive grid, no horizontal overflow, 44px touch, readable 16px inputs (prevent zoom), safe-area inset, dialogs as bottom sheets
- Failure: dialog clipped, search input zooms page, menu traps focus incorrectly
- Success: smooth scroll, menu opens/closes with Escape/outside, command palette works

### J6: Power User Immediate Access
- Goal: Copy endpoint in <5s
- Required: endpoint visible in hero status or header action, copy button, command palette "Copy MCP endpoint"
- Success: Cmd+K → "Copy MCP endpoint" → toast

## 4. Competitive & External Research

Studied (via knowledge cutoff, not live fetch due to network block):
- **Linear, Vercel, Stripe Docs, GitHub Docs, Cloudflare Docs** — information architecture: primary nav compact, secondary nav in sidebar or cards, status always visible, command palette for jump
- **MCP docs (modelcontextprotocol.io), Smithery, Mintlify** — tool explorers: search + category chips + availability badges, detail drawer not modal
- **Premium SaaS dashboards (Linear, Raycast)** — design: deep charcoal, subtle borders (1px #1e232c), restrained blue accent, typography Inter/System, spacing 4px scale, radius 8-12px, shadow subtle, no gradients
- **Status dashboards (Cloudflare, Vercel)** — hierarchy: deployment → capabilities → connections → endpoints, status pill = icon + text + color, degraded explained in plain language, last refresh time
- **Connection flows (Claude, Cursor, VS Code docs)** — onboarding: separate verified direct-install from manual, show exact config snippet, explain what happens after click, never claim success

Principles extracted:
- Dense but calm: 16px base, 1.6 line-height, 4px spacing scale, max 70ch lede
- Strong hierarchy: eyebrow 11px uppercase 0.14em tracking, h1 28-32px 750 weight -0.03em, h2 16px 700, body 14px 1.6
- Borders over shadows: 1px border for cards, shadow only for modals/palette
- Icon + text for status, never color alone
- Search preserves focus/caret, filters update count live
- Dialogs: focus trap, return focus, Esc closes, overlay click closes, safe-area padding
- Touch targets 44px min on <560px, 16px font for inputs to prevent iOS zoom
- Reduced-motion respects prefers-reduced-motion
- Clipboard: primary API + fallback, success visible, failure graceful

## 5. Accessibility Findings

- Skip link present, good
- Focus-visible outline 2px ring with offset, good
- Dialogs have role=dialog aria-modal, labelledby/describedby, good
- Palette has combobox + listbox + aria-activedescendant, good
- Status pills use icon + text, good (not color alone)
- Heading hierarchy: hero h1, sec-head h2, panel h3 — logical
- Link text: "Open", "Details" with arrow icon — meaningful when combined with card title, but could be more explicit
- Touch targets: menu-btn 38px → needs 44px on mobile
- Menu: no focus trap, no aria-expanded sync? Actually aria-expanded exists, but focus not trapped
- Tool rows: button with aria-expanded, good, but no title for long names
- No aria-live for status refresh, but toasts have role=status aria-live polite
- Reduced-motion supported
- Color contrast: dark theme passes for text #e8ebf0 on #0a0b0e, but dim #9aa3b1 on surface #0e1014 ~ 5:1? Needs verification — will improve in new tokens to ensure 4.5:1 for dim, 7:1 for text
- Light theme: need to ensure --dim #55555e on #ffffff passes

## 6. Responsive Findings

- Breakpoints: 1060px grid collapses to 1 col, 900px nav hides + menu button shows, 760px hero padding reduces, cat-grid 1 col, trow hides desc/group, 560px overlay becomes bottom sheet
- Issues:
  - trow hiding desc/group on mobile loses context — should keep desc truncated or show as second line
  - Endpoint block flex column on mobile but code wraps poorly — should allow horizontal scroll + larger touch
  - No safe-area handling for header (top) — needs env(safe-area-inset-*)
  - Content padding 20px 16px on mobile good, but maxw 1120px could be 1200px for large displays
  - No tablet-specific (768px) optimization
  - Large displays: no extra columns, but that's okay for readability
- Desired: 640px (sm), 768px (md), 1024px (lg), 1280px (xl), 1536px (2xl) — fluid maxw 1280px, content 24px padding desktop, 16px mobile

## 7. Jev and Laya Feedback

**Attempted:** Search for Jev/Laya integrations in repo — they are code modules (`src/jev/`, `src/laya/`, `src/decisions/`, `src/commands/jev-command.ts`, `laya-command.ts`) plus docs, not external services to call for UI review. No network access to `https://demo-mcp.amidevz.workers.dev` in this sandbox (curl timed out), so live UI inspection impossible. No GitHub issue template for design review.

**Result:** Integration unavailable in this environment. Performing equivalent self-review:

- Information architecture: 6 categories is good, but "Infrastructure" linking to Status is confusing — should be "Platform" or "Status"
- Visual hierarchy: hero is clear, but category cards lack visual weight differentiation — need stronger icon containers, better spacing
- Navigation: primary 3 items is compact, good; secondary 7 items in menu is okay but could be grouped
- Usability: tool explorer filters work but chip counts could be more visible, search placeholder shows catalog length — good
- Accessibility: as above, focus trap for menu missing, touch targets need 44px
- Mobile: bottom sheet modals good, but endpoint copy button needs larger touch
- Design direction: current dark charcoal is good direction, but needs more refined surfaces, better spacing scale, more premium feel — less generic dashboard
- Regressions risk: changing class names breaks tests; changing endpoint strings breaks tests — must preserve

**Laya self-review (UX/implementation):**
- User journeys: as documented, clear but could be faster for power user — add endpoint in header or command palette
- Simplicity: tool explorer is simple, but availability filter "Any state" vs "Needs setup" terminology could be clearer
- Mobile: works but trow hiding info is high-value fix
- Content organization: Browser/Video/Research/Routing/Roblox/Skills/About is logical grouping by user goal
- Implementation feasibility: vanilla JS, no framework — any redesign must stay within same architecture, no new deps
- Maintenance: styles.ts is single file, good — keep it single file, use tokens
- Regression: must keep pinned literals, hash routing, focus management

## 8. Critical Problems to Solve

1. **Mobile tool rows hide critical info** — description and group hidden at 760px, user loses context
2. **Touch targets below 44px** — menu-btn 38px, some .btn--sm 28px on mobile without override
3. **No focus trap for mobile menu** — keyboard user can tab out of open menu
4. **Endpoint block mobile UX** — code wraps, copy button not full-width enough, no safe-area
5. **Visual hierarchy flat** — category cards all same weight, hero status dot subtle, panels lack depth differentiation
6. **Spacing inconsistent** — no scale, margins 16px everywhere, no rhythm
7. **Light theme contrast** — dim text may fail WCAG AA
8. **No empty states for sections** — only tool explorer has no-results
9. **Footer semantic** — bits as spans with · separator, not list
10. **Command palette no grouping** — all items flat, no sections

## 9. High-Value Improvements

1. **Premium design tokens** — spacing 4px scale, typography scale with line-height, radius 8/10/14/20, shadow sm/md/lg, elevation via border + subtle shadow, accent restrained blue
2. **Refined surfaces** — bg #0b0d10, bg-deep #080a0d, surface #12151c, surface-2 #181c26, surface-3 #1e242f, border #1e2632, border-2 #2a3442, border-3 #354152 — deeper, more layered, less pure black
3. **Typography** — sans: -apple-system, BlinkMacSystemFont, "Inter", "Geist", sans-serif; mono: ui-monospace, "Geist Mono", SF Mono; fs-12 to fs-32, line-height 1.2 for headings, 1.6 for body
4. **Navigation** — header 64px, backdrop blur 16px, border subtle, brand mark with gradient? No, keep solid but refined: 32px mark, 8px radius, text 15px 700
5. **Hero** — larger h1 32px desktop, 26px mobile, lede 16px 1.65, CTA 42px min-height, status with icon + text + dot pulse
6. **Category cards** — hover border + subtle lift, icon container 36px with border, status pill top-right, highlights as dot list
7. **Tool explorer** — search with icon, 16px font mobile, chips with count badge, availability filter as segmented control, rows with 2-line mobile layout (name + availability on first line, desc on second)
8. **Status** — hierarchical: deployment (version, endpoint, tools, telemetry, uptime) → capabilities (browser, video, storage, decisions, Roblox) → connections → endpoints, with last refresh
9. **Connect dialog** — premium modal 560px, header with icon, endpoint block with mono 13px, copy feedback, provider list 52px rows, manual config blocks with copy, limitations as muted list, footer with shield + endpoint
10. **Accessibility** — menu focus trap, palette grouping, skip link, visible focus, 44px touch, safe-area insets, reduced-motion, aria-live for toasts
11. **Responsive** — fluid maxw 1200px, breakpoints 640/768/1024/1280, no horizontal overflow, bottom sheet modals at 640px, search full-width at 768px

## 10. Proposed Information Architecture

- Keep existing 7 secondary + 3 primary + 1 hidden — no IA change needed (preserves routes)
- Improve grouping in mobile menu: "Primary" + "Explore" + "Resources" already exists — keep
- Capability categories: keep 6, but rename "Infrastructure" → "Platform" in UI label? Keep id but improve description — currently "Infrastructure" title with route "status" is confusing, should show as "Platform" with same route
- Add quick access: endpoint visible in header on desktop as copy button? Or keep in Connect dialog only — power user uses command palette
- Tool explorer: keep filters, but add "Clear filters" when active

## 11. Proposed Visual Direction

- **Modern, minimal, sophisticated, premium, developer-focused, technically clear, dense but calm, distinctive without decorative**
- Deep charcoal #0b0d10 base, layered surfaces #12151c → #181c26 → #1e242f, borders #1e2632 → #2a3442, text #eef1f6 primary, #a3adc0 dim, #6e7a8c faint
- Light: bg #fcfcfd, surface #ffffff, surface-2 #f6f7f9, surface-3 #eef0f3, border #e6e8eb, border-2 #d8dce2, text #12151c, dim #5a6577, faint #8a95a7
- Accent: #5b8def (dark) / #2f6feb (light), restrained, used for links, focus ring, primary actions? Primary button keeps text-on-bg for contrast, accent button for Connect
- Status: ok #2fdb8a, warn #f5b94a, err #f25c5e, off #5a6577
- Typography: system sans with Inter/Geist fallback, mono SF Mono/Geist Mono, 14px base, 1.6 line-height, headings 750 weight -0.02em tracking
- Spacing: 4px base → 4,8,12,16,20,24,32,40,48
- Radius: sm 8px, md 10px, lg 14px, xl 20px, full 9999px
- Shadows: sm 0 1px 2px rgba(0,0,0,.2), md 0 8px 24px -8px rgba(0,0,0,.6), lg 0 20px 60px -16px rgba(0,0,0,.8)
- Motion: fast 120ms, med 200ms, slow 300ms, easing cubic-bezier(.16,1,.3,1) (ease-out-expo)
- Iconography: 1.8 stroke, round caps, 14-16px default, 20px for hero
- Avoid: gradients, glows, glassmorphism, huge empty spaces, oversized headings, excessive card nesting, visual clutter, excessive animation

## 12. Proposed Design Tokens

```css
:root {
  --bg: #0b0d10; --bg-deep: #080a0d; --surface: #12151c; --surface-2: #181c26; --surface-3: #1e242f;
  --border: #1e2632; --border-2: #2a3442; --border-3: #354152;
  --text: #eef1f6; --dim: #a3adc0; --faint: #6e7a8c;
  --accent: #5b8def; --accent-strong: #7aa3f5; --accent-ink: #0a0e1a; --accent-ring: rgba(91,141,239,.5);
  --ok: #2fdb8a; --warn: #f5b94a; --err: #f25c5e; --off: #5a6577;
  --mono: ui-monospace, "Geist Mono", "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Geist", "Segoe UI", Roboto, sans-serif;
  --fs-11: 11px; --fs-12: 12px; --fs-13: 13px; --fs-14: 14px; --fs-15: 15px; --fs-16: 16px; --fs-20: 20px; --fs-24: 24px; --fs-28: 28px; --fs-32: 32px;
  --lh-tight: 1.2; --lh-snug: 1.35; --lh-normal: 1.6;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
  --r-sm: 8px; --r-md: 10px; --r-lg: 14px; --r-xl: 20px; --r-full: 9999px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.2); --shadow-md: 0 8px 24px -8px rgba(0,0,0,.6); --shadow-lg: 0 20px 60px -16px rgba(0,0,0,.8);
  --t-fast: 120ms cubic-bezier(.16,1,.3,1); --t-med: 200ms cubic-bezier(.16,1,.3,1);
  --maxw: 1200px; --header-h: 64px;
}
```

Light theme same tokens with light values.

## 13. Proposed Component Changes

- **Header**: 64px, backdrop-filter blur 16px, bg 88% opacity, border 1px, brand mark 32px 8px radius, nav pills 7px 12px, active bg surface-3 + border
- **Buttons**: primary bg text color text bg, hover opacity .9, active translateY(1px); accent bg accent, ink accent-ink; secondary bg surface-2 border-2; sm 32px, md 36px, lg 44px, icon 36px (44px mobile)
- **Panels**: bg surface, border border, radius lg, shadow sm, hd 14px 16px border-bottom, bd 16px
- **Cat cards**: padding 20px, radius lg, border, bg surface, hover border-2 + bg surface-2, icon 36px, title 15px 700, desc 13px 1.6 dim, tags 11px faint border, foot 12px faint + arrow
- **Tool rows**: desktop grid 180px .9fr auto 18px, mobile 2-line: first line name + group + chevron, second line desc + availability dot, min-height 56px, hover surface-2
- **Search**: 40px min-height desktop, 44px mobile, bg bg-deep, border-2, focus ring accent 3px, icon 16px faint
- **Chips**: 32px min-height, radius full, border-2, pressed bg surface-3 border-3 text
- **Status pills**: icon 12px + text 11.5px 650, border 1px, bg 7% mix, padding 3px 10px 3px 8px, radius full
- **KV**: grid 160px 1fr, gap 8px 16px, padding 12px 16px, border-bottom, mobile 1fr stacked
- **Modal**: width 560px, max-height 720px / 90dvh, radius xl, shadow lg, animation pop 200ms, header 20px 20px 0, body 20px, footer 14px 20px border-top
- **Endpoint block**: bg bg-deep, border-2, radius md, padding 14px, code 13px mono text, button 36px (44px mobile), focus-within ring
- **Provider list**: prov grid 40px 1fr 16px, gap 12px, min-height 56px, hover bg surface-2 border, mark 40px radius 12px bg surface-3 border-2
- **Palette**: width 640px, max-height 70vh, radius lg, shadow lg, search 48px, results 6px padding, item 44px min-height, selected bg surface-3
- **Toasts**: bottom 20px right 20px, left/right 16px mobile, bg surface-3 border-2 radius md shadow md

## 14. Proposed Interaction States

For every interactive element:
- Initial: as per tokens
- Hover: bg surface-2 or surface-3, border-3, text (where applicable), transition fast
- Focus: 2px ring accent-ring, offset 2px, radius 4px
- Active: translateY(1px) for buttons/cards, or bg surface-3
- Loading: skeleton shimmer or spinner, aria-busy
- Success: check icon + "Copied!" swap + toast
- Failure: toast "Copy blocked — select manually" + keep focus
- Disabled: opacity .5, cursor default, no transform
- Mobile: min 44px touch, 16px font for inputs, safe-area insets
- Keyboard: Tab order logical, Arrow keys for provider list and palette, Enter activates, Esc closes overlays/menu, Home/End for lists
- Screen reader: aria-current page, aria-expanded for tool rows, aria-selected for palette, aria-live polite for toasts and status

## 15. Proposed Responsive Behavior

- 1280px+: maxw 1200px centered, content 32px 24px, grid-2 1fr 1fr, cat-grid 3 cols
- 1024-1279: same, but header-in 0 24px
- 768-1023: grid-2 1fr, cat-grid 2 cols, toolbar search max-width none, trow keeps desc but truncated
- 640-767: cat-grid 1 col, trow 2-line layout, kv stacked, hero h1 26px, content 24px 16px, header 58px
- <640: overlay bottom sheet (place-items end, width 100%, radius lg lg 0 0, max-height 90dvh, slideup animation), endpoint column, hero CTA flex 1, toasts left/right 16px centered, buttons 44px min-height, search 44px 16px font, prov 60px, safe-area bottom padding env(safe-area-inset-bottom)
- No horizontal overflow: code blocks overflow-x auto, long names ellipsis with title attr, endpoint code word-break break-all but scrollable
- Zoomed: relative units, no fixed px for text, 200% zoom still readable
- Increased text-size: system fonts scale, line-height 1.6 preserves readability

## 16. Technical Risks & Constraints

- Changing class names breaks app-script selectors and tests — must keep class names
- Changing endpoint strings breaks mcp-clients tests — must keep exact builders
- Changing HTML structure may break jsdom tests that query .nav a[aria-current], .hero h1, #view, .prov, #mcp-endpoint, .trow, #tool-search, .tdetail, .foot — must keep those selectors
- Inline CSS size: currently 35k, new design may be larger but should stay <60k to keep bundle reasonable
- CSP: no external resources, no inline event handlers, no eval
- Vanilla JS: no framework, keep bundle <100k JS
- Browser compat: supports backdrop-filter via @supports, safe-area via env(), color-mix for status pills — provide fallback solid colors
- Performance: no heavy animations, shimmer only for skeletons, reduced-motion disables

## 17. Prioritized Implementation Plan

**Stage 1: Research & Audit** — DONE (this brief)

**Stage 2: Design Planning** — DONE (tokens, components, responsive, interaction, risks)

**Stage 3: Incremental Implementation**

1. Rewrite `src/ui/styles.ts` with premium tokens, improved layout, responsive, accessibility
2. Improve `src/ui/content.ts` — clarify labels, keep ids, enhance blurb, add any new static content (no route change)
3. Keep `src/ui/mcp-clients.ts` unchanged except verify URLs still exact (no change needed)
4. Rewrite `src/ui/app-script.ts`:
   - Preserve all pinned literals
   - Improve renderShell: header 64px, brand mark 32px, nav pills, search + Connect, menu button 44px touch
   - Improve renderHeaderState: aria-current sync
   - Improve pageHead, panel, kv, etc. with better semantics
   - Improve heroBlock: refined status dot with icon, better hierarchy
   - Improve catCard: icon 36px, status top-right, highlights as dot list, foot count
   - Improve explorerPanel: search 40px, chips with count, availability segmented, clear filters, tool rows 2-line mobile, title attr for long names, copy button
   - Improve statusView: hierarchical, last refresh, loading/empty/error states
   - Improve browserView, videoView, researchView, routingView, robloxView, skillsView, aboutView: add intro context, better hierarchy, loading/empty/error, preserve live data
   - Improve connect modal: focus trap, return focus, Esc, overlay click, safe-area, copy feedback, provider keyboard nav, status message
   - Improve palette: grouping, kbd hints, selected state, scrollIntoView
   - Improve menu: focus trap, outside click, Esc, body scroll lock, 44px touch
   - Improve toasts, skeletons, error panels
   - Ensure no horizontal overflow, long names ellipsis, endpoint scrollable
   - Preserve all data-act handlers, hash navigation, back/forward

5. Verify `ui.ts` boot payload still safe (escape <)

**Stage 4: Validation**

- Run `npm test` — must pass ui-shell + mcp-clients + others
- Manual jsdom checks via tests
- Check all routes, deep links, interactions, copy success/failure, search, filtering, status loading/failure, empty, unavailable, back/forward, hash, light/dark, keyboard, focus trap/restoration, narrow/mobile/tablet/desktop/large, long labels, CSP, no secrets, client links

## 18. Explicit Non-Goals

- No backend rewrite, no Worker architecture change
- No new routes, no route removal, no hash change
- No login, accounts, cookies, tracking, analytics, paid services
- No external fonts, frameworks, dependencies
- No weakening CSP, no secrets exposure
- No invented client support, no fabricated status
- No copying another product's branding
- No excessive gradients, glows, glassmorphism, huge empty spaces, oversized headings, excessive nesting, visual clutter, excessive animation

## 19. Validation & Testing Plan

- **Automated:** `npm run typecheck`, `npm test` (vitest run), specifically `tests/ui-shell.test.ts` and `tests/mcp-clients.test.ts`
- **Routes:** #/overview, #/capabilities, #/tools, #/status, #/browser, #/video, #/research, #/routing, #/roblox, #/skills, #/about, #/does-not-exist
- **Interactions:** Connect open → picker → client pick → back → copy → Esc; palette open → search → Arrow → Enter → Esc; menu toggle → link click → Esc; tool search input preserves focus/caret; filter group/avail; open-tool expand/collapse; copy tool name; Roblox connect/disconnect; refresh/retry
- **States:** loading (skeleton), error (errPanel + retry), empty (no tools), unavailable (off pill + hint), success (copied toast), failure (clipboard blocked toast)
- **Themes:** dark + light via prefers-color-scheme
- **Keyboard:** Tab order, focus visible, focus trap modal/palette/menu, return focus, Esc, Arrow/Home/End, Enter
- **Responsive:** 320px, 375px, 414px, 640px, 768px, 1024px, 1280px, 1536px — no overflow, no clipped dialogs, touch 44px, readable typography, safe-area
- **Security:** CSP header, no secrets in HTML, no external requests, no credential inputs, no forms
- **Client links:** verify against docs/CONNECT-MCP.md, check hrefs, targets, rels, no invented schemes
- **Diff:** inspect final diff for placeholders, dead code, unfinished sections

---

**Approval:** No approval mechanism in env — reviewed against repository, feasible, complete. Proceeding to implementation.
