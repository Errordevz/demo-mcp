import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type Env = {
  DEMO_API_KEY?: string;
};

function authorized(request: Request, env: Env) {
  if (!env.DEMO_API_KEY) return true;
  const value = request.headers.get("Authorization") ?? "";
  return value === `Bearer ${env.DEMO_API_KEY}`;
}

function server() {
  const mcp = new McpServer(
    { name: "DEMO", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

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
          version: "0.1.0",
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
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid JSON: ${String(error)}` }]
        };
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
      return { content: [{ type: "text", text: hash }] };
    }
  );

  mcp.registerTool(
    "generate_uuid",
    {
      title: "Generate UUID",
      description: "Generate a random UUID.",
      inputSchema: {}
    },
    async () => ({
      content: [{ type: "text", text: crypto.randomUUID() }]
    })
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
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Only HTTP(S) URLs are allowed." }]
        };
      }

      const response = await fetch(parsed, {
        method,
        redirect: "follow"
      });

      const body = method === "HEAD"
        ? ""
        : (await response.text()).slice(0, 1_000_000);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: response.status,
            contentType: response.headers.get("content-type"),
            body
          })
        }]
      };
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
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: false
        })
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify(await response.json())
        }]
      };
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
      const response = await fetch(
        `https://games.roblox.com/v1/games?universeIds=${universeId}`
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify(await response.json())
        }]
      };
    }
  );

  return mcp;
}

const mcpHandler = createMcpHandler(() => server());

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        name: "DEMO",
        version: "0.1.0",
        status: "online",
        mcp: "/mcp"
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
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
