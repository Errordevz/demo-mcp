/**
 * Official AI-client connection methods for DEMO's public MCP server.
 *
 * Research date: 2026-09-25. Every `connectionUrl` is built only from a
 * format that official documentation specifies. Do not add a scheme, query
 * parameter, or prefilled field that those docs do not describe. If a
 * client has no verified direct method, leave `connectionUrl` null and use
 * the manual fallback.
 *
 * Sources are listed on each client. The served UI reads the payload from
 * this module — it does not hardcode a second set of URLs.
 */

import { MCP_ENDPOINT } from "./content.js";

/** Full HTTPS URL clients must be given. The inspector also shows the host path. */
export const MCP_SERVER_URL = `https://${MCP_ENDPOINT}`;

/** Server id used in install links and config files. Lowercase, no spaces. */
export const MCP_SERVER_NAME = "demo";

export const MCP_DISPLAY_NAME = "DEMO";

export const CONNECT_RESEARCHED_ON = "2026-09-25";

export const CONNECT_PICKER = {
  title: "Connect DEMO",
  subtitle: "Choose a client. Public tools stay login-free; protected tools use OAuth when supported.",
} as const;

export type ConnectMethod = "direct-prefill" | "direct-install" | "official-screen" | "manual";
export type ConnectVerification = "verified" | "manual";
export type ConnectionOpensIn = "new-tab" | "app" | null;

export interface ConnectAlternate {
  label: string;
  url: string;
  /** `app` is an official custom-scheme install link. `https` opens in a browser tab. */
  kind: "https" | "app";
}

export interface McpClientIntegration {
  id: "chatgpt" | "claude" | "cursor" | "vscode" | "claude-code" | "other";
  name: string;
  icon: string;
  summary: string;
  badge: string;
  documentationUrl: string;
  platforms: string[];
  transport: "streamable-http";
  authentication: "none" | "mixed";
  verification: ConnectVerification;
  method: ConnectMethod;
  /**
   * Official handoff URL, or null when no direct URL is documented.
   * Never invent query parameters to make this look prefilled.
   */
  connectionUrl: string | null;
  connectionOpensIn: ConnectionOpensIn;
  /** True only when the official URL itself carries this server's endpoint. */
  prefillsEndpoint: boolean;
  /**
   * True only when official docs say following `connectionUrl` opens that
   * product's own review or install prompt for this server. False means we
   * must not claim a native confirmation dialog will appear.
   */
  destinationPromptsUser: boolean;
  actionLabel: string;
  confirmTitle: string;
  confirmBody: string;
  callout: string;
  steps: string[];
  limitations: string[];
  fallback: string;
  manualCommand: string | null;
  manualConfig: string | null;
  manualConfigTitle: string | null;
  alternates: ConnectAlternate[];
  sources: string[];
}

/** Client payload embedded in the inspector. Sources stay in the module for tests and docs. */
export type McpClientView = Omit<McpClientIntegration, "sources">;

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Claude custom-connector install link.
 * https://claude.com/docs/connectors/building/directory-vs-custom
 *
 * `modal` must be `add-custom-connector`. `connectorUrl` is the percent-encoded
 * MCP server URL. The link only prefills the dialog; the user confirms in Claude.
 */
export function claudeConnectorInstallUrl(surface: "personal" | "organization" = "personal", serverUrl = MCP_SERVER_URL): string {
  const path = surface === "organization"
    ? "https://claude.ai/admin-settings/connectors"
    : "https://claude.ai/customize/connectors";
  const params = new URLSearchParams();
  params.set("modal", "add-custom-connector");
  params.set("connectorName", MCP_DISPLAY_NAME);
  params.set("connectorUrl", serverUrl);
  return `${path}?${params.toString()}`;
}

/**
 * Cursor MCP install deeplink.
 * https://cursor.com/docs/mcp/install-links
 *
 * `config` is standard base64 of the mcp.json server entry (not the wrapper).
 * Remote servers are a `url` field: https://cursor.com/docs/mcp
 * `+` and `/` are percent-encoded so the query string cannot corrupt them.
 * `=` padding is left as in Cursor's own example.
 */
export function cursorInstallUrl(serverUrl = MCP_SERVER_URL, name = MCP_SERVER_NAME): string {
  const config = JSON.stringify({ url: serverUrl });
  const encoded = btoa(config).replace(/\+/g, "%2B").replace(/\//g, "%2F");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encoded}`;
}

/**
 * VS Code MCP installation URL.
 * https://code.visualstudio.com/api/extension-guides/ai/mcp
 *
 * Official form: `vscode:mcp/install?` + encodeURIComponent(JSON.stringify(config)).
 * Insiders: `vscode-insiders:mcp/install?` + the same JSON.
 * HTTP fields `type` and `url` are the documented server configuration
 * (https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
 * The unofficial `?name=&config=` query form is intentionally not used.
 */
export function vscodeInstallUrl(insiders = false, serverUrl = MCP_SERVER_URL, name = MCP_SERVER_NAME): string {
  const payload = { name, type: "http" as const, url: serverUrl };
  const scheme = insiders ? "vscode-insiders" : "vscode";
  return `${scheme}:mcp/install?${encodeURIComponent(JSON.stringify(payload))}`;
}

/**
 * Claude Code remote HTTP install command.
 * https://code.claude.com/docs/en/mcp
 *
 * Documented order: `claude mcp add --transport http <name> [--scope user] <url>`.
 * Run in a terminal, not inside a Claude Code session. There is no documented
 * MCP install deeplink. `claude-cli://open` only prefills a prompt and is not used.
 */
export function claudeCodeAddCommand(scope: "user" | "local" = "user", serverUrl = MCP_SERVER_URL): string {
  if (scope === "user") {
    return `claude mcp add --transport http ${MCP_SERVER_NAME} --scope user ${serverUrl}`;
  }
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${serverUrl}`;
}

const CURSOR_CONFIG = pretty({
  mcpServers: {
    [MCP_SERVER_NAME]: { url: MCP_SERVER_URL },
  },
});

const VSCODE_CONFIG = pretty({
  servers: {
    [MCP_SERVER_NAME]: { type: "http", url: MCP_SERVER_URL },
  },
});

const CLAUDE_CODE_CONFIG = pretty({
  mcpServers: {
    [MCP_SERVER_NAME]: { type: "http", url: MCP_SERVER_URL },
  },
});

const sharedTransport = {
  transport: "streamable-http" as const,
  authentication: "none" as const,
};

export const MCP_CLIENTS: readonly McpClientIntegration[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    icon: "bubble",
    summary: "Plugins page · Mixed Authentication (live check pending).",
    badge: "Official page",
    documentationUrl: "https://developers.openai.com/plugins/deploy/connect-chatgpt",
    platforms: ["ChatGPT web"],
    ...sharedTransport,
    authentication: "mixed",
    verification: "verified",
    method: "official-screen",
    connectionUrl: "https://chatgpt.com/plugins",
    connectionOpensIn: "new-tab",
    prefillsEndpoint: false,
    destinationPromptsUser: false,
    actionLabel: "Continue to ChatGPT",
    confirmTitle: "Connect DEMO to ChatGPT?",
    confirmBody: "You're about to connect DEMO as a remote MCP server in ChatGPT.",
    callout: "Opens the official ChatGPT setup page. It does not connect automatically or prefill this server. Public tools remain anonymous; protected tools are designed for per-tool OAuth when ChatGPT honors the metadata.",
    steps: [
      "Turn on Developer mode. Developer docs: Settings, then Security and login. On Business, Enterprise, and Edu, an admin may need Workspace settings, then Permissions and Roles, or Settings, then Apps, then Advanced settings. Availability depends on your plan.",
      "Continue to ChatGPT Plugins. OpenAI does not document a link that fills in this server or opens a confirmation dialog from a website.",
      "Select the plus button. Name it DEMO and paste the endpoint as the MCP server URL, including /mcp. Choose Mixed Authentication for the expected noauth public tools plus OAuth-protected tools setup, if that option is offered.",
      "This mixed flow has not been live-tested yet. If ChatGPT does not offer Mixed Authentication or does not start DEMO OAuth on a protected call, use only public tools until compatibility is verified.",
      "With mixed auth working, public tools need no sign-in. A protected tool should start DEMO OAuth; sign in through Cloudflare Access and review the requested scopes.",
      "Roblox is a separate approval: call roblox_account_link_start, then open its linkUrl, paste the one-time linkCode, and approve only on Roblox's official consent page. This does not happen during DEMO OAuth.",
    ],
    limitations: [
      "No verified prefilled install URL, and no verified website-to-app confirmation dialog.",
      "No live ChatGPT connection was exercised for this code change; after deployment, verify Mixed Authentication and the first protected-tool challenge in the actual ChatGPT setup.",
      "The documented flow is ChatGPT on the web. A mobile-app install link was not found.",
      "This does not configure Codex or the ChatGPT desktop app. Those use separate MCP setup.",
    ],
    fallback: "Paste the endpoint on the ChatGPT Plugins page after Developer mode is on and select Mixed Authentication.",
    manualCommand: null,
    manualConfig: null,
    manualConfigTitle: null,
    alternates: [],
    sources: [
      "https://developers.openai.com/plugins/deploy/connect-chatgpt",
      "https://developers.openai.com/plugins/build/auth",
      "https://developers.openai.com/plugins/quickstart",
      "https://chatgpt.com/plugins",
      "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt",
    ],
  },
  {
    id: "claude",
    name: "Claude",
    icon: "spark",
    summary: "Add-connector dialog, prefilled.",
    badge: "Verified link",
    documentationUrl: "https://claude.com/docs/connectors/building/directory-vs-custom",
    platforms: ["claude.ai"],
    ...sharedTransport,
    verification: "verified",
    method: "direct-prefill",
    connectionUrl: claudeConnectorInstallUrl("personal"),
    connectionOpensIn: "new-tab",
    prefillsEndpoint: true,
    destinationPromptsUser: true,
    actionLabel: "Continue to Claude",
    confirmTitle: "Connect DEMO to Claude?",
    confirmBody: "You're about to connect DEMO as a remote MCP server in Claude.",
    callout: "Opens Claude’s own Add custom connector dialog. Public tools are login-free; protected tools need per-tool OAuth, which is only configured for ChatGPT here.",
    steps: [
      "Continue to Claude. The official link opens the dialog with the name DEMO and this URL filled in, and notes that the values came from an external link.",
      "Sign in if Claude asks. Review the name and URL before you continue.",
      "For public tools, choose no sign-in if asked and leave transport as detected (Streamable HTTP, not SSE). This connection does not configure protected-tool OAuth.",
      "Confirm in Claude only if you trust this server. The link does not add the connector or grant any permission by itself.",
    ],
    limitations: [
      "Free plans can add one custom connector. Team and Enterprise members usually need an Owner.",
      "After you confirm, Anthropic reaches the server from its cloud for claude.ai, Claude Desktop, Cowork, and the mobile apps. This page cannot see that confirmation.",
      "This connector setup is no-auth for public tools; protected Roblox and jev_decide calls need per-tool OAuth, and Claude compatibility is not verified here.",
      "No separate native-app install scheme was documented. The web dialog is the official path.",
    ],
    fallback: "Open Customize, then Connectors, and paste the endpoint into Add custom connector.",
    manualCommand: null,
    manualConfig: null,
    manualConfigTitle: null,
    alternates: [
      {
        label: "Organization owner dialog",
        url: claudeConnectorInstallUrl("organization"),
        kind: "https",
      },
    ],
    sources: [
      "https://claude.com/docs/connectors/building/directory-vs-custom",
      "https://claude.com/docs/connectors/custom/add-unlisted",
      "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: "pointer",
    summary: "Desktop install prompt.",
    badge: "Verified link",
    documentationUrl: "https://cursor.com/docs/mcp/install-links",
    platforms: ["Cursor desktop"],
    ...sharedTransport,
    verification: "verified",
    method: "direct-install",
    connectionUrl: cursorInstallUrl(),
    connectionOpensIn: "app",
    prefillsEndpoint: true,
    destinationPromptsUser: true,
    actionLabel: "Continue to Cursor",
    confirmTitle: "Connect DEMO to Cursor?",
    confirmBody: "You're about to connect DEMO as a remote MCP server in Cursor.",
    callout: "Opens Cursor’s install prompt. Public tools need no login; this no-auth setup does not enable protected per-tool OAuth.",
    steps: [
      "Continue to Cursor. The official install link asks Cursor to prompt you to install this server. Your browser may ask permission to open the app.",
      "Approve the prompt in Cursor only if you trust this server. DEMO does not install the server itself.",
      "If Cursor does not open, copy the configuration below into ~/.cursor/mcp.json for every project, or .cursor/mcp.json for one project.",
    ],
    limitations: [
      "This no-auth setup exposes public tools; protected Roblox and jev_decide calls require per-tool OAuth, which is not verified for Cursor here.",
      "Desktop only. There is no verified iPhone or mobile install link.",
      "The link needs Cursor installed, with the cursor:// handler registered.",
    ],
    fallback: "Add the mcp.json entry in Cursor settings or on disk.",
    manualCommand: null,
    manualConfig: CURSOR_CONFIG,
    manualConfigTitle: "Cursor mcp.json",
    alternates: [],
    sources: [
      "https://cursor.com/docs/mcp/install-links",
      "https://cursor.com/docs/mcp",
    ],
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    icon: "code",
    summary: "Desktop install prompt.",
    badge: "Verified link",
    documentationUrl: "https://code.visualstudio.com/api/extension-guides/ai/mcp",
    platforms: ["VS Code desktop"],
    ...sharedTransport,
    verification: "verified",
    method: "direct-install",
    connectionUrl: vscodeInstallUrl(false),
    connectionOpensIn: "app",
    prefillsEndpoint: true,
    destinationPromptsUser: true,
    actionLabel: "Continue to Visual Studio Code",
    confirmTitle: "Connect DEMO to Visual Studio Code?",
    confirmBody: "You're about to connect DEMO as a remote MCP server in Visual Studio Code.",
    callout: "Opens VS Code’s install flow. Public tools need no login; this no-auth setup does not enable protected per-tool OAuth.",
    steps: [
      "Continue to Visual Studio Code. The official vscode:mcp/install link carries this server. Your browser may ask permission to open VS Code.",
      "Confirm the install in VS Code, and trust the server only if you intend to use it. VS Code asks before a newly added server starts.",
      "If VS Code does not open, copy the configuration below into .vscode/mcp.json, or run MCP: Open User Configuration and paste the server entry.",
    ],
    limitations: [
      "This no-auth setup exposes public tools; protected Roblox and jev_decide calls require per-tool OAuth, which is not verified for VS Code here.",
      "Desktop only. There is no verified mobile install link.",
      "VS Code Insiders uses the separate documented vscode-insiders: scheme.",
    ],
    fallback: "Add the servers entry to .vscode/mcp.json or your user MCP configuration.",
    manualCommand: null,
    manualConfig: VSCODE_CONFIG,
    manualConfigTitle: "VS Code mcp.json",
    alternates: [
      {
        label: "VS Code Insiders",
        url: vscodeInstallUrl(true),
        kind: "app",
      },
    ],
    sources: [
      "https://code.visualstudio.com/api/extension-guides/ai/mcp",
      "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
      "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    icon: "terminal",
    summary: "Terminal command. No install link.",
    badge: "Manual setup",
    documentationUrl: "https://code.claude.com/docs/en/mcp",
    platforms: ["Terminal"],
    ...sharedTransport,
    verification: "manual",
    method: "manual",
    connectionUrl: null,
    connectionOpensIn: null,
    prefillsEndpoint: false,
    destinationPromptsUser: false,
    actionLabel: "Copy install command",
    confirmTitle: "Connect DEMO to Claude Code?",
    confirmBody: "You're about to connect DEMO as a remote MCP server in Claude Code.",
    callout: "Manual no-auth setup for public tools. Protected per-tool OAuth is not verified for Claude Code here.",
    steps: [
      "Copy the command and run it in a terminal, not inside a Claude Code session. It registers a user-scoped HTTP server named demo.",
      "Start Claude Code and run /mcp to see the server. Approve tool calls when Claude Code asks.",
      "For one project only, omit --scope user and run the command in that project. The type field is required in .mcp.json.",
    ],
    limitations: [
      "No official MCP install deeplink. claude-cli:// only prefills a prompt, so it is not used here.",
      "The command writes local config. It does not open a confirmation dialog or prove the server responded.",
    ],
    fallback: "Run the documented claude mcp add command, or write .mcp.json.",
    manualCommand: claudeCodeAddCommand("user"),
    manualConfig: CLAUDE_CODE_CONFIG,
    manualConfigTitle: "Project .mcp.json",
    alternates: [],
    sources: [
      "https://code.claude.com/docs/en/mcp",
      "https://code.claude.com/docs/en/mcp-quickstart",
      "https://code.claude.com/docs/en/deep-links",
    ],
  },
  {
    id: "other",
    name: "Other MCP Client",
    icon: "plug",
    summary: "Copy the endpoint.",
    badge: "Manual setup",
    documentationUrl: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports",
    platforms: ["Any remote MCP client"],
    ...sharedTransport,
    verification: "manual",
    method: "manual",
    connectionUrl: null,
    connectionOpensIn: null,
    prefillsEndpoint: false,
    destinationPromptsUser: false,
    actionLabel: "Copy endpoint",
    confirmTitle: "Connect DEMO to your MCP-compatible client.",
    confirmBody: "Paste this endpoint into a client that accepts a remote MCP server.",
    callout: "Manual setup. Public tools need no login; protected tools require an OAuth-capable MCP client and per-tool support.",
    steps: [
      "Paste the endpoint into your client’s remote MCP server settings.",
      "Use Streamable HTTP. Public tools require no authentication header. Protected tools require per-tool OAuth support; use ChatGPT Mixed Authentication for the configured protected-tool flow.",
      "Follow that client’s own documentation. This page cannot confirm the connection.",
    ],
    limitations: [
      "Clients do not share one install link. A method that is not listed above was not verified.",
    ],
    fallback: "Copy the endpoint and follow the client’s remote-server instructions.",
    manualCommand: null,
    manualConfig: null,
    manualConfigTitle: null,
    alternates: [],
    sources: [
      "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports",
    ],
  },
];

function manualConfigFor(clientId: McpClientIntegration["id"], serverUrl: string): string | null {
  if (clientId === "cursor") return pretty({ mcpServers: { [MCP_SERVER_NAME]: { url: serverUrl } } });
  if (clientId === "vscode") return pretty({ servers: { [MCP_SERVER_NAME]: { type: "http", url: serverUrl } } });
  if (clientId === "claude-code") return pretty({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: serverUrl } } });
  return null;
}

function clientForServer(client: McpClientIntegration, serverUrl: string): McpClientIntegration {
  switch (client.id) {
    case "claude":
      return {
        ...client,
        connectionUrl: claudeConnectorInstallUrl("personal", serverUrl),
        alternates: [{ label: "Organization owner dialog", url: claudeConnectorInstallUrl("organization", serverUrl), kind: "https" }],
      };
    case "cursor":
      return { ...client, connectionUrl: cursorInstallUrl(serverUrl), manualConfig: manualConfigFor(client.id, serverUrl) };
    case "vscode":
      return {
        ...client,
        connectionUrl: vscodeInstallUrl(false, serverUrl),
        alternates: [{ label: "VS Code Insiders", url: vscodeInstallUrl(true, serverUrl), kind: "app" }],
        manualConfig: manualConfigFor(client.id, serverUrl),
      };
    case "claude-code":
      return {
        ...client,
        manualCommand: `claude mcp add --transport http ${MCP_SERVER_NAME} --scope user ${serverUrl}`,
        manualConfig: manualConfigFor(client.id, serverUrl),
      };
    default:
      return client;
  }
}

export function connectClientPayload(serverUrl = MCP_SERVER_URL): McpClientView[] {
  return MCP_CLIENTS.map((source) => {
    const { sources: _sources, ...client } = clientForServer(source, serverUrl);
    return client;
  });
}

export function mcpClientById(id: string): McpClientIntegration | undefined {
  return MCP_CLIENTS.find((client) => client.id === id);
}
