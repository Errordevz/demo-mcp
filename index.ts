import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import puppeteer from "@cloudflare/puppeteer";
import { z } from "zod";

type Env = {
  DEMO_API_KEY?: string;
  BROWSER: any;
};

function authorized(request: Request, env: Env) {
  if (!env.DEMO_API_KEY) return true;
  const value = request.headers.get("Authorization") ?? "";
  return value === `Bearer ${env.DEMO_API_KEY}`;
}

function textResult(value: unknown) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function withBrowser<T>(env: Env, fn: (page: any) => Promise<T>) {
  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function goto(page: any, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
}

async function resolveLocator(page: any, target: string) {
  const normalized = target.trim();
  if (/^role:/i.test(normalized)) return page.getByRole(normalized.slice(normalized.indexOf(":") + 1));
  if (/^text:/i.test(normalized)) return page.getByText(normalized.slice(normalized.indexOf(":") + 1), { exact: true });
  return page.locator(normalized);
}

async function inspectPage(page: any) {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const items = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button'],[role='link']"));
    return {
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 30).map(x => clean(x.textContent)),
      interactive: items.slice(0, 150).map((el: any, index) => ({
        id: index + 1,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        name: clean(el.getAttribute("aria-label") || el.getAttribute("name")),
        text: clean(el.textContent).slice(0, 160),
        placeholder: el.getAttribute("placeholder"),
        href: el.getAttribute("href"),
        selectorHint: el.id ? `#${el.id}` : null
      }))
    };
  });
}

function server(env: Env) {
  const mcp = new McpServer({ name: "DEMO", version: "0.2.0" }, { capabilities: { tools: {} } });

  // Existing tools — preserved.
  mcp.registerTool("demo_ping", { title: "DEMO Ping", description: "Check whether DEMO is online.", inputSchema: {} }, async () => textResult({ ok: true, name: "DEMO", version: "0.2.0", time: new Date().toISOString() }));

  mcp.registerTool("json_format", { title: "Format JSON", description: "Validate and pretty-print JSON.", inputSchema: { json: z.string() } }, async ({ json }) => {
    try { return textResult(JSON.stringify(JSON.parse(json), null, 2)); } catch (error) { return errorResult(`Invalid JSON: ${String(error)}`); }
  });

  mcp.registerTool("hash_text", { title: "Hash Text", description: "Create a SHA-256 or SHA-512 hash.", inputSchema: { text: z.string(), algorithm: z.enum(["SHA-256", "SHA-512"]).default("SHA-256") } }, async ({ text, algorithm }) => {
    const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
    return textResult([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""));
  });

  mcp.registerTool("generate_uuid", { title: "Generate UUID", description: "Generate a random UUID.", inputSchema: {} }, async () => textResult(crypto.randomUUID()));

  mcp.registerTool("http_fetch", { title: "HTTP Fetch", description: "Fetch an HTTP(S) URL and return a bounded text response.", inputSchema: { url: z.string().url(), method: z.enum(["GET", "HEAD"]).default("GET") } }, async ({ url, method }) => {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return errorResult("Only HTTP(S) URLs are allowed.");
      const response = await fetch(parsed, { method, redirect: "follow" });
      const body = method === "HEAD" ? "" : (await response.text()).slice(0, 1_000_000);
      return textResult({ status: response.status, contentType: response.headers.get("content-type"), body });
    } catch (error) { return errorResult(`Fetch failed: ${String(error)}`); }
  });

  mcp.registerTool("roblox_user", { title: "Roblox User Lookup", description: "Look up a Roblox user by username through Roblox's public API.", inputSchema: { username: z.string().min(1) } }, async ({ username }) => {
    const response = await fetch("https://users.roblox.com/v1/usernames/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) });
    return textResult(await response.json());
  });

  mcp.registerTool("roblox_game", { title: "Roblox Experience Lookup", description: "Look up Roblox experience information by universe ID.", inputSchema: { universeId: z.number().int().positive() } }, async ({ universeId }) => {
    const response = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    return textResult(await response.json());
  });

  // New browser tools. They are additive; the old tools above remain unchanged in capability.
  mcp.registerTool("browser_open", { title: "Browser Open", description: "Open a URL in Cloudflare Browser Run Chromium and return page metadata.", inputSchema: { url: z.string().url() } }, async ({ url }) => {
    try { return textResult(await withBrowser(env, page => goto(page, url))); } catch (error) { return errorResult(`Browser open failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_inspect", { title: "Browser Inspect", description: "Render a page and return a compact structured list of headings and interactive elements.", inputSchema: { url: z.string().url() } }, async ({ url }) => {
    try { return textResult(await withBrowser(env, async page => { await goto(page, url); return inspectPage(page); })); } catch (error) { return errorResult(`Browser inspect failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_screenshot", { title: "Browser Screenshot", description: "Render a URL and return a screenshot as an MCP image.", inputSchema: { url: z.string().url(), type: z.enum(["png", "jpeg", "webp"]).default("png"), fullPage: z.boolean().default(false) } }, async ({ url, type, fullPage }) => {
    try {
      const bytes = await withBrowser(env, async page => { await goto(page, url); return new Uint8Array(await page.screenshot({ type, fullPage })); });
      const mimeType = type === "jpeg" ? "image/jpeg" : `image/${type}`;
      return { content: [{ type: "image", data: bytesToBase64(bytes), mimeType }, { type: "text", text: JSON.stringify({ url, type, fullPage, bytes: bytes.byteLength }) }] };
    } catch (error) { return errorResult(`Browser screenshot failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_click", { title: "Browser Click", description: "Render a page and click an element using CSS, text:, or role: targeting.", inputSchema: { url: z.string().url(), target: z.string().min(1) } }, async ({ url, target }) => {
    try {
      return textResult(await withBrowser(env, async page => { await goto(page, url); await (await resolveLocator(page, target)).click({ timeout: 20_000 }); await new Promise(resolve => setTimeout(resolve, 300)); return { url: page.url(), title: await page.title(), after: await inspectPage(page) }; }));
    } catch (error) { return errorResult(`Browser click failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_fill", { title: "Browser Fill", description: "Render a page and fill an input or textarea.", inputSchema: { url: z.string().url(), target: z.string().min(1), value: z.string() } }, async ({ url, target, value }) => {
    try { return textResult(await withBrowser(env, async page => { await goto(page, url); await (await resolveLocator(page, target)).fill(value); return { url: page.url(), title: await page.title(), filled: target }; })); } catch (error) { return errorResult(`Browser fill failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_type", { title: "Browser Type", description: "Render a page, focus an element, and type text with keyboard events.", inputSchema: { url: z.string().url(), target: z.string().min(1), text: z.string() } }, async ({ url, target, text }) => {
    try { return textResult(await withBrowser(env, async page => { await goto(page, url); await (await resolveLocator(page, target)).click(); await page.keyboard.type(text); return { url: page.url(), title: await page.title(), typedInto: target }; })); } catch (error) { return errorResult(`Browser type failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_press", { title: "Browser Press", description: "Render a page and press a keyboard key, optionally after focusing an element.", inputSchema: { url: z.string().url(), key: z.string(), target: z.string().optional() } }, async ({ url, key, target }) => {
    try { return textResult(await withBrowser(env, async page => { await goto(page, url); if (target) await (await resolveLocator(page, target)).click(); await page.keyboard.press(key); return { url: page.url(), title: await page.title() }; })); } catch (error) { return errorResult(`Browser press failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_scroll", { title: "Browser Scroll", description: "Render a page and scroll vertically by a pixel amount.", inputSchema: { url: z.string().url(), pixels: z.number().int().default(800) } }, async ({ url, pixels }) => {
    try { return textResult(await withBrowser(env, async page => { await goto(page, url); await page.evaluate((amount: number) => window.scrollBy(0, amount), pixels); return page.evaluate(() => ({ scrollY: window.scrollY, height: document.documentElement.scrollHeight })); })); } catch (error) { return errorResult(`Browser scroll failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_wait", { title: "Browser Wait", description: "Render a page and wait for a selector or a fixed amount of time.", inputSchema: { url: z.string().url(), milliseconds: z.number().int().min(0).max(120_000).default(1000), selector: z.string().optional() } }, async ({ url, milliseconds, selector }) => {
    try { return textResult(await withBrowser(env, async page => { await goto(page, url); if (selector) await page.waitForSelector(selector, { timeout: 30_000 }); if (milliseconds) await new Promise(resolve => setTimeout(resolve, milliseconds)); return { url: page.url(), title: await page.title() }; })); } catch (error) { return errorResult(`Browser wait failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_evaluate", { title: "Browser Evaluate", description: "Render a page and evaluate JavaScript inside the webpage context.", inputSchema: { url: z.string().url(), expression: z.string().min(1) } }, async ({ url, expression }) => {
    try { return textResult(await withBrowser(env, async page => { await goto(page, url); return page.evaluate((code: string) => (0, eval)(code), expression); })); } catch (error) { return errorResult(`Browser evaluate failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_console", { title: "Browser Console", description: "Render a page and capture browser console messages and page errors during navigation.", inputSchema: { url: z.string().url() } }, async ({ url }) => {
    try {
      return textResult(await withBrowser(env, async page => {
        const messages: unknown[] = [];
        const errors: string[] = [];
        page.on("console", (msg: any) => messages.push({ type: msg.type(), text: msg.text() }));
        page.on("pageerror", (error: any) => errors.push(String(error)));
        await goto(page, url);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { url: page.url(), title: await page.title(), messages: messages.slice(0, 200), errors };
      }));
    } catch (error) { return errorResult(`Browser console failed: ${String(error)}`); }
  });

  mcp.registerTool("browser_run", {
    title: "Browser Run",
    description: "Run multiple browser actions in one Chromium page so navigation, clicks, typing and screenshots share state.",
    inputSchema: {
      url: z.string().url(),
      actions: z.array(z.object({
        action: z.enum(["click", "fill", "type", "press", "scroll", "wait", "screenshot", "inspect"]),
        target: z.string().optional(), value: z.string().optional(), key: z.string().optional(), pixels: z.number().int().optional(), milliseconds: z.number().int().min(0).max(120_000).optional(), fullPage: z.boolean().optional()
      })).min(1).max(30)
    }
  }, async ({ url, actions }) => {
    try {
      const result = await withBrowser(env, async page => {
        await goto(page, url);
        const output: any[] = [];
        for (const step of actions) {
          if (step.action === "click") { if (!step.target) throw new Error("click requires target"); await (await resolveLocator(page, step.target)).click({ timeout: 20_000 }); }
          else if (step.action === "fill") { if (!step.target) throw new Error("fill requires target"); await (await resolveLocator(page, step.target)).fill(step.value ?? ""); }
          else if (step.action === "type") { if (!step.target) throw new Error("type requires target"); await (await resolveLocator(page, step.target)).click(); await page.keyboard.type(step.value ?? ""); }
          else if (step.action === "press") { if (step.target) await (await resolveLocator(page, step.target)).click(); await page.keyboard.press(step.key ?? "Enter"); }
          else if (step.action === "scroll") await page.evaluate((amount: number) => window.scrollBy(0, amount), step.pixels ?? 800);
          else if (step.action === "wait") { if (step.target) await page.waitForSelector(step.target, { timeout: 30_000 }); if (step.milliseconds) await new Promise(resolve => setTimeout(resolve, step.milliseconds)); }
          else if (step.action === "inspect") output.push({ action: "inspect", result: await inspectPage(page) });
          else if (step.action === "screenshot") { const bytes = new Uint8Array(await page.screenshot({ type: "png", fullPage: step.fullPage ?? false })); output.push({ action: "screenshot", pngBase64: bytesToBase64(bytes) }); }
          output.push({ action: step.action, url: page.url(), title: await page.title() });
        }
        return output;
      });
      return textResult(result);
    } catch (error) { return errorResult(`Browser run failed: ${String(error)}`); }
  });

  return mcp;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.json({ name: "DEMO", version: "0.2.0", status: "online", mcp: "/mcp", browser: Boolean(env.BROWSER) });
    if (url.pathname === "/health") return Response.json({ ok: true, browser: Boolean(env.BROWSER) });
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return createMcpHandler(() => server(env))(request, env, ctx);
  }
};
