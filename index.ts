import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type Env = {
  DEMO_API_KEY?: string;
  BROWSER?: any;
};

function authorized(request: Request, env: Env) {
  if (!env.DEMO_API_KEY) return true;
  const value = request.headers.get("Authorization") ?? "";
  return value === `Bearer ${env.DEMO_API_KEY}`;
}

function textResult(value: unknown) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function requireBrowser(env: Env) {
  if (!env.BROWSER) {
    throw new Error("Browser Run is not configured. Add the BROWSER binding in wrangler.jsonc and enable Browser Run for this Worker.");
  }
  return env.BROWSER;
}

async function responseBytes(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function browserQuickAction(env: Env, action: string, args: Record<string, unknown>) {
  const browser = requireBrowser(env);
  return browser.quickAction(action, args);
}

function server(env: Env) {
  const mcp = new McpServer(
    { name: "DEMO", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  // Existing tools are intentionally preserved.
  mcp.registerTool(
    "demo_ping",
    {
      title: "DEMO Ping",
      description: "Check whether DEMO is online.",
      inputSchema: {}
    },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          name: "DEMO",
          version: "0.2.0",
          time: new Date().toISOString()
        })
      }]
    })
  );

  mcp.registerTool(
    "json_format",
    {
      title: "Format JSON",
      description: "Validate and pretty-print JSON.",
      inputSchema: { json: z.string() }
    },
    async ({ json }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(JSON.parse(json), null, 2) }] };
      } catch (error) {
        return errorResult(`Invalid JSON: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "hash_text",
    {
      title: "Hash Text",
      description: "Create a SHA-256 or SHA-512 hash.",
      inputSchema: {
        text: z.string(),
        algorithm: z.enum(["SHA-256", "SHA-512"]).default("SHA-256")
      }
    },
    async ({ text, algorithm }) => {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest(algorithm, bytes);
      const hash = [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      return textResult(hash);
    }
  );

  mcp.registerTool(
    "generate_uuid",
    {
      title: "Generate UUID",
      description: "Generate a random UUID.",
      inputSchema: {}
    },
    async () => textResult(crypto.randomUUID())
  );

  mcp.registerTool(
    "http_fetch",
    {
      title: "HTTP Fetch",
      description: "Fetch an HTTP(S) URL and return a bounded text response.",
      inputSchema: {
        url: z.string().url(),
        method: z.enum(["GET", "HEAD"]).default("GET")
      }
    },
    async ({ url, method }) => {
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return errorResult("Only HTTP(S) URLs are allowed.");
        }

        const response = await fetch(parsed, { method, redirect: "follow" });
        const body = method === "HEAD" ? "" : (await response.text()).slice(0, 1_000_000);

        return textResult({
          status: response.status,
          contentType: response.headers.get("content-type"),
          body
        });
      } catch (error) {
        return errorResult(`Fetch failed: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "roblox_user",
    {
      title: "Roblox User Lookup",
      description: "Look up a Roblox user by username through Roblox's public API.",
      inputSchema: { username: z.string().min(1) }
    },
    async ({ username }) => {
      const response = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
      });
      return textResult(await response.json());
    }
  );

  mcp.registerTool(
    "roblox_game",
    {
      title: "Roblox Experience Lookup",
      description: "Look up Roblox experience information by universe ID.",
      inputSchema: { universeId: z.number().int().positive() }
    },
    async ({ universeId }) => {
      const response = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
      return textResult(await response.json());
    }
  );

  // New Browser Run tools. These are additive and do not replace existing tools.
  mcp.registerTool(
    "browser_screenshot",
    {
      title: "Browser Screenshot",
      description: "Render a URL in Cloudflare Browser Run and return a screenshot as an MCP image.",
      inputSchema: {
        url: z.string().url(),
        type: z.enum(["png", "jpeg", "webp"]).default("png"),
        fullPage: z.boolean().default(false),
        omitBackground: z.boolean().default(false)
      }
    },
    async ({ url, type, fullPage, omitBackground }) => {
      try {
        const response = await browserQuickAction(env, "screenshot", {
          url,
          screenshotOptions: { type, fullPage, omitBackground }
        });
        const bytes = await responseBytes(response);
        const mimeType = type === "jpeg" ? "image/jpeg" : `image/${type}`;
        return {
          content: [
            { type: "image", data: bytesToBase64(bytes), mimeType },
            { type: "text", text: JSON.stringify({ url, type, fullPage, bytes: bytes.byteLength }) }
          ]
        };
      } catch (error) {
        return errorResult(`Browser screenshot failed: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "browser_markdown",
    {
      title: "Browser Markdown",
      description: "Render a URL and extract readable Markdown from the fully rendered page.",
      inputSchema: { url: z.string().url() }
    },
    async ({ url }) => {
      try {
        const response = await browserQuickAction(env, "markdown", { url });
        return textResult(await response.text());
      } catch (error) {
        return errorResult(`Browser markdown failed: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "browser_content",
    {
      title: "Browser Rendered Content",
      description: "Render a URL and return its JavaScript-rendered HTML.",
      inputSchema: { url: z.string().url() }
    },
    async ({ url }) => {
      try {
        const response = await browserQuickAction(env, "content", { url });
        return textResult((await response.text()).slice(0, 2_000_000));
      } catch (error) {
        return errorResult(`Browser content failed: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "browser_links",
    {
      title: "Browser Links",
      description: "Render a page and return the links discovered on it.",
      inputSchema: { url: z.string().url() }
    },
    async ({ url }) => {
      try {
        const response = await browserQuickAction(env, "links", { url });
        return textResult(await response.text());
      } catch (error) {
        return errorResult(`Browser links failed: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "browser_scrape",
    {
      title: "Browser Scrape",
      description: "Render a page and extract elements matching a CSS selector.",
      inputSchema: {
        url: z.string().url(),
        selector: z.string().min(1)
      }
    },
    async ({ url, selector }) => {
      try {
        const response = await browserQuickAction(env, "scrape", { url, selector });
        return textResult(await response.text());
      } catch (error) {
        return errorResult(`Browser scrape failed: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "browser_pdf",
    {
      title: "Browser PDF",
      description: "Render a URL and return a generated PDF as an MCP resource payload.",
      inputSchema: { url: z.string().url() }
    },
    async ({ url }) => {
      try {
        const response = await browserQuickAction(env, "pdf", { url });
        const bytes = await responseBytes(response);
        return {
          content: [
            { type: "resource", resource: { uri: `data:application/pdf;base64,${bytesToBase64(bytes)}`, mimeType: "application/pdf" } },
            { type: "text", text: JSON.stringify({ url, bytes: bytes.byteLength }) }
          ]
        };
      } catch (error) {
        return errorResult(`Browser PDF failed: ${String(error)}`);
      }
    }
  );

  mcp.registerTool(
    "browser_snapshot",
    {
      title: "Browser Snapshot",
      description: "Return a rendered page snapshot containing structured page data and a screenshot when supported.",
      inputSchema: { url: z.string().url() }
    },
    async ({ url }) => {
      try {
        const response = await browserQuickAction(env, "snapshot", {
          url,
          formats: ["markdown", "screenshot", "accessibilityTree"]
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return textResult(await response.json());
        }
        return textResult(await response.text());
      } catch (error) {
        return errorResult(`Browser snapshot failed: ${String(error)}`);
      }
    }
  );

  return mcp;
}

const mcpHandler = createMcpHandler((request, env) => server(env));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        name: "DEMO",
        version: "0.2.0",
        status: "online",
        mcp: "/mcp",
        browser: Boolean(env.BROWSER)
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, browser: Boolean(env.BROWSER) });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    if (!authorized(request, env)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    return mcpHandler(request, env);
  }
};
