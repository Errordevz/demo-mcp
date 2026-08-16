import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import puppeteer from "@cloudflare/puppeteer";
import { z } from "zod";

type Env = { DEMO_API_KEY?: string; BROWSER: any };
const VERSION = "0.3.0";
const SKILLS_API = "https://skills.sh/api/v1";

function authorized(request: Request, env: Env) {
  if (!env.DEMO_API_KEY) return true;
  return (request.headers.get("Authorization") ?? "") === `Bearer ${env.DEMO_API_KEY}`;
}
function textResult(value: unknown) { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }; }
function errorResult(message: string) { return { isError: true, content: [{ type: "text", text: message }] }; }
function bytesToBase64(bytes: Uint8Array) { let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))); return btoa(binary); }

async function withBrowser<T>(env: Env, fn: (page: any) => Promise<T>) {
  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();
  try { return await fn(page); } finally { await browser.close(); }
}
async function goto(page: any, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
}
async function resolveLocator(page: any, target: string) {
  const t = target.trim();
  if (/^role:/i.test(t)) return page.getByRole(t.slice(t.indexOf(":") + 1));
  if (/^text:/i.test(t)) return page.getByText(t.slice(t.indexOf(":") + 1), { exact: true });
  return page.locator(t);
}
async function inspectPage(page: any) {
  return page.evaluate(() => {
    const clean = (v: any) => (v ?? "").replace(/\s+/g, " ").trim();
    const items = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button'],[role='link']"));
    return { url: location.href, title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 30).map((x: any) => clean(x.textContent)),
      interactive: items.slice(0, 150).map((el: any, index) => ({ id: index + 1, tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), type: el.getAttribute("type"), name: clean(el.getAttribute("aria-label") || el.getAttribute("name")), text: clean(el.textContent).slice(0, 160), placeholder: el.getAttribute("placeholder"), href: el.getAttribute("href"), selectorHint: el.id ? `#${el.id}` : null })) };
  });
}

async function skillsApi(path: string) {
  const r = await fetch(`${SKILLS_API}${path}`, { headers: { accept: "application/json", "user-agent": `DEMO-MCP/${VERSION}` } });
  if (!r.ok) throw new Error(`skills.sh API ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
}

function server(env: Env) {
  const mcp = new McpServer({ name: "DEMO", version: VERSION }, { capabilities: { tools: {} } });

  // Original tools preserved.
  mcp.registerTool("demo_ping", { title: "DEMO Ping", description: "Check whether DEMO is online and report its current version.", inputSchema: {} }, async () => textResult({ ok: true, name: "DEMO", version: VERSION, time: new Date().toISOString(), skillsSh: true, browser: Boolean(env.BROWSER) }));
  mcp.registerTool("json_format", { title: "Format JSON", description: "Validate and pretty-print JSON.", inputSchema: { json: z.string() } }, async ({ json }) => { try { return textResult(JSON.stringify(JSON.parse(json), null, 2)); } catch (e) { return errorResult(`Invalid JSON: ${String(e)}`); } });
  mcp.registerTool("hash_text", { title: "Hash Text", description: "Create a SHA-256 or SHA-512 hash.", inputSchema: { text: z.string(), algorithm: z.enum(["SHA-256", "SHA-512"]).default("SHA-256") } }, async ({ text, algorithm }) => { const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text)); return textResult([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")); });
  mcp.registerTool("generate_uuid", { title: "Generate UUID", description: "Generate a random UUID.", inputSchema: {} }, async () => textResult(crypto.randomUUID()));
  mcp.registerTool("http_fetch", { title: "HTTP Fetch", description: "Fetch an HTTP(S) URL and return bounded text.", inputSchema: { url: z.string().url(), method: z.enum(["GET", "HEAD"]).default("GET") } }, async ({ url, method }) => { try { const u = new URL(url); if (!["http:", "https:"].includes(u.protocol)) return errorResult("Only HTTP(S) URLs are allowed."); const r = await fetch(u, { method, redirect: "follow" }); return textResult({ status: r.status, contentType: r.headers.get("content-type"), body: method === "HEAD" ? "" : (await r.text()).slice(0, 1_000_000) }); } catch (e) { return errorResult(`Fetch failed: ${String(e)}`); } });
  mcp.registerTool("roblox_user", { title: "Roblox User Lookup", description: "Look up a Roblox user by username.", inputSchema: { username: z.string().min(1) } }, async ({ username }) => textResult(await (await fetch("https://users.roblox.com/v1/usernames/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()));
  mcp.registerTool("roblox_game", { title: "Roblox Experience Lookup", description: "Look up Roblox experience information by universe ID.", inputSchema: { universeId: z.number().int().positive() } }, async ({ universeId }) => textResult(await (await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)).json()));

  // Browser tools.
  mcp.registerTool("browser_open", { title: "Browser Open", description: "Open a URL in Cloudflare Browser Run Chromium and return page metadata.", inputSchema: { url: z.string().url() } }, async ({ url }) => { try { return textResult(await withBrowser(env, p => goto(p, url))); } catch (e) { return errorResult(`Browser open failed: ${String(e)}`); } });
  mcp.registerTool("browser_inspect", { title: "Browser Inspect", description: "Render a page and return headings and interactive elements so the model can choose targets for actions.", inputSchema: { url: z.string().url() } }, async ({ url }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); return inspectPage(p); })); } catch (e) { return errorResult(`Browser inspect failed: ${String(e)}`); } });
  mcp.registerTool("browser_screenshot", { title: "Browser Screenshot", description: "Render a URL and return the screenshot as an MCP image.", inputSchema: { url: z.string().url(), type: z.enum(["png", "jpeg", "webp"]).default("png"), fullPage: z.boolean().default(false) } }, async ({ url, type, fullPage }) => { try { const bytes = await withBrowser(env, async p => { await goto(p, url); return new Uint8Array(await p.screenshot({ type, fullPage })); }); return { content: [{ type: "image", data: bytesToBase64(bytes), mimeType: type === "jpeg" ? "image/jpeg" : `image/${type}` }, { type: "text", text: JSON.stringify({ url, type, fullPage }) }] }; } catch (e) { return errorResult(`Browser screenshot failed: ${String(e)}`); } });
  mcp.registerTool("browser_click", { title: "Browser Click", description: "Open a page and click a CSS, text:, or role: target.", inputSchema: { url: z.string().url(), target: z.string().min(1) } }, async ({ url, target }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); await (await resolveLocator(p, target)).click({ timeout: 20_000 }); await new Promise(r => setTimeout(r, 300)); return { url: p.url(), title: await p.title(), after: await inspectPage(p) }; })); } catch (e) { return errorResult(`Browser click failed: ${String(e)}`); } });
  mcp.registerTool("browser_fill", { title: "Browser Fill", description: "Open a page and fill an input or textarea.", inputSchema: { url: z.string().url(), target: z.string().min(1), value: z.string() } }, async ({ url, target, value }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); await (await resolveLocator(p, target)).fill(value); return { url: p.url(), title: await p.title(), filled: target }; })); } catch (e) { return errorResult(`Browser fill failed: ${String(e)}`); } });
  mcp.registerTool("browser_type", { title: "Browser Type", description: "Open a page, focus an element, and type text.", inputSchema: { url: z.string().url(), target: z.string().min(1), text: z.string() } }, async ({ url, target, text }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); await (await resolveLocator(p, target)).click(); await p.keyboard.type(text); return { url: p.url(), title: await p.title(), typedInto: target }; })); } catch (e) { return errorResult(`Browser type failed: ${String(e)}`); } });
  mcp.registerTool("browser_press", { title: "Browser Press", description: "Open a page and press a key.", inputSchema: { url: z.string().url(), key: z.string(), target: z.string().optional() } }, async ({ url, key, target }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); if (target) await (await resolveLocator(p, target)).click(); await p.keyboard.press(key); return { url: p.url(), title: await p.title() }; })); } catch (e) { return errorResult(`Browser press failed: ${String(e)}`); } });
  mcp.registerTool("browser_scroll", { title: "Browser Scroll", description: "Open a page and scroll vertically.", inputSchema: { url: z.string().url(), pixels: z.number().int().default(800) } }, async ({ url, pixels }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); await p.evaluate((n: number) => window.scrollBy(0, n), pixels); return p.evaluate(() => ({ scrollY: window.scrollY, height: document.documentElement.scrollHeight })); })); } catch (e) { return errorResult(`Browser scroll failed: ${String(e)}`); } });
  mcp.registerTool("browser_wait", { title: "Browser Wait", description: "Open a page and wait for a selector or time.", inputSchema: { url: z.string().url(), milliseconds: z.number().int().min(0).max(120_000).default(1000), selector: z.string().optional() } }, async ({ url, milliseconds, selector }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); if (selector) await p.waitForSelector(selector, { timeout: 30_000 }); if (milliseconds) await new Promise(r => setTimeout(r, milliseconds)); return { url: p.url(), title: await p.title() }; })); } catch (e) { return errorResult(`Browser wait failed: ${String(e)}`); } });
  mcp.registerTool("browser_evaluate", { title: "Browser Evaluate", description: "Run JavaScript inside the webpage context.", inputSchema: { url: z.string().url(), expression: z.string().min(1) } }, async ({ url, expression }) => { try { return textResult(await withBrowser(env, async p => { await goto(p, url); return p.evaluate((code: string) => (0, eval)(code), expression); })); } catch (e) { return errorResult(`Browser evaluate failed: ${String(e)}`); } });
  mcp.registerTool("browser_console", { title: "Browser Console", description: "Capture console messages and page errors during navigation.", inputSchema: { url: z.string().url() } }, async ({ url }) => { try { return textResult(await withBrowser(env, async p => { const messages: any[] = [], errors: string[] = []; p.on("console", (m: any) => messages.push({ type: m.type(), text: m.text() })); p.on("pageerror", (e: any) => errors.push(String(e))); await goto(p, url); await new Promise(r => setTimeout(r, 1000)); return { url: p.url(), title: await p.title(), messages: messages.slice(0, 200), errors }; })); } catch (e) { return errorResult(`Browser console failed: ${String(e)}`); } });

  mcp.registerTool("browser_run", { title: "Browser Run", description: "Execute a multi-step browser workflow in one persistent Chromium page. Use this for requests such as 'open this website, fill these infos, click submit, then show me a screenshot'. The final screenshot is returned as a real MCP image.", inputSchema: { url: z.string().url(), actions: z.array(z.object({ action: z.enum(["click", "fill", "type", "press", "scroll", "wait", "screenshot", "inspect"]), target: z.string().optional(), value: z.string().optional(), key: z.string().optional(), pixels: z.number().int().optional(), milliseconds: z.number().int().min(0).max(120_000).optional(), fullPage: z.boolean().optional() })).min(1).max(40) } }, async ({ url, actions }) => {
    try {
      return await withBrowser(env, async p => {
        await goto(p, url); const log: any[] = []; let finalImage: string | null = null;
        for (const s of actions) {
          if (s.action === "click") { if (!s.target) throw new Error("click requires target"); await (await resolveLocator(p, s.target)).click({ timeout: 20_000 }); }
          else if (s.action === "fill") { if (!s.target) throw new Error("fill requires target"); await (await resolveLocator(p, s.target)).fill(s.value ?? ""); }
          else if (s.action === "type") { if (!s.target) throw new Error("type requires target"); await (await resolveLocator(p, s.target)).click(); await p.keyboard.type(s.value ?? ""); }
          else if (s.action === "press") { if (s.target) await (await resolveLocator(p, s.target)).click(); await p.keyboard.press(s.key ?? "Enter"); }
          else if (s.action === "scroll") await p.evaluate((n: number) => window.scrollBy(0, n), s.pixels ?? 800);
          else if (s.action === "wait") { if (s.target) await p.waitForSelector(s.target, { timeout: 30_000 }); if (s.milliseconds) await new Promise(r => setTimeout(r, s.milliseconds)); }
          else if (s.action === "inspect") log.push({ action: "inspect", result: await inspectPage(p) });
          else if (s.action === "screenshot") finalImage = bytesToBase64(new Uint8Array(await p.screenshot({ type: "png", fullPage: s.fullPage ?? false })));
          log.push({ action: s.action, url: p.url(), title: await p.title() });
        }
        const content: any[] = [{ type: "text", text: JSON.stringify({ version: VERSION, log }, null, 2) }];
        if (finalImage) content.push({ type: "image", data: finalImage, mimeType: "image/png" });
        return { content };
      });
    } catch (e) { return errorResult(`Browser run failed: ${String(e)}`); }
  });

  // skills.sh integration. Skills are retrieved as task instructions so the connected model can use them in-context.
  mcp.registerTool("skills_search", { title: "Search skills.sh", description: "Search the live skills.sh catalog for AI Agent Skills by name, description, or semantic query.", inputSchema: { query: z.string().min(2), limit: z.number().int().min(1).max(50).default(10) } }, async ({ query, limit }) => { try { return textResult(await skillsApi(`/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`)); } catch (e) { return errorResult(`skills.sh search failed: ${String(e)}`); } });
  mcp.registerTool("skills_browse", { title: "Browse skills.sh", description: "Browse trending or all-time skills from the live skills.sh leaderboard.", inputSchema: { view: z.enum(["all-time", "trending", "hot"]).default("trending"), page: z.number().int().min(0).default(0), perPage: z.number().int().min(1).max(50).default(20) } }, async ({ view, page, perPage }) => { try { return textResult(await skillsApi(`/skills?view=${view}&page=${page}&per_page=${perPage}`)); } catch (e) { return errorResult(`skills.sh browse failed: ${String(e)}`); } });
  mcp.registerTool("skills_get", { title: "Fetch skill from skills.sh", description: "Fetch a complete skill snapshot from skills.sh, including SKILL.md and supporting files. The returned instructions are intended for the connected AI model to apply to the user's current task when relevant; they never override system, developer, safety, or user instructions.", inputSchema: { id: z.string().min(3).describe("Stable skills.sh skill id, for example vercel-labs/skills/find-skills") } }, async ({ id }) => { try { return textResult(await skillsApi(`/skills/${id}`)); } catch (e) { return errorResult(`skills.sh skill fetch failed: ${String(e)}`); } });
  mcp.registerTool("skills_audit", { title: "Audit skill on skills.sh", description: "Retrieve available security audit results for a skills.sh skill before using its instructions.", inputSchema: { id: z.string().min(3) } }, async ({ id }) => { try { return textResult(await skillsApi(`/skills/audit/${id}`)); } catch (e) { return errorResult(`skills.sh audit failed: ${String(e)}`); } });
  mcp.registerTool("skills_curated", { title: "Curated skills.sh", description: "Browse skills.sh's official curated/first-party skill collection.", inputSchema: {} }, async () => { try { return textResult(await skillsApi("/skills/curated")); } catch (e) { return errorResult(`skills.sh curated lookup failed: ${String(e)}`); } });
  mcp.registerTool("skill_install_info", { title: "Skill Install Command", description: "Return the standard skills CLI command for a skills.sh skill. DEMO does not execute arbitrary installers on the Worker.", inputSchema: { installUrl: z.string().min(3) } }, async ({ installUrl }) => textResult({ command: `npx skills add ${installUrl}`, source: installUrl, note: "Review the skill and its audit before installing or applying it." }));

  return mcp;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.json({ name: "DEMO", version: VERSION, status: "online", mcp: "/mcp", browser: Boolean(env.BROWSER), skillsSh: true, skillsApi: SKILLS_API });
    if (url.pathname === "/health") return Response.json({ ok: true, name: "DEMO", version: VERSION, browser: Boolean(env.BROWSER), skillsSh: true });
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return createMcpHandler(() => server(env))(request, env, ctx);
  }
};
