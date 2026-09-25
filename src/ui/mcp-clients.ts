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
  subtitle: "Choose where you want to connect DEMO.",
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
  authentication: "none";
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
export function claudeConnectorInstallUrl(surface: "personal" | "organization" = "personal"): string {
  const path = surface === "organization"
    ? "https://claude.ai/admin-settings/connectors"
    : "https://claude.ai/customize/connectors";
  const params = new URLSearchParams();
  params.set("modal", "add-custom-connector");
  params.set("connectorName", MCP_DISPLAY_NAME);
  params.set("connectorUrl", MCP_SERVER_URL);
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
export function claudeCodeAddCommand(scope: "user" | "local" = "user"): string {
  if (scope === "user") {
    return `claude mcp add --transport http ${MCP_SERVER_NAME} --scope user ${MCP_SERVER_URL}`;
  }
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_SERVER_URL}`;
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
    summary: "Plugins page. You paste the URL.",
    badge: "Official page",
    documentationUrl: "https://developers.openai.com/plugins/deploy/connect-chatgpt",
    platforms: ["ChatGPT web"],
    ...sharedTransport,
    verification: "verified",
    method: "official-screen",
    connectionUrl: "https://chatgpt.com/plugins",
    connectionOpensIn: "new-tab",
    prefillsEndpoint: false,
    destinationPromptsUser: false,
    actionLabel: "Continue to ChatGPT",
    confirmTitle: "Connect DEMO to ChatGPT?",
    confirmBody: "You're about to connect DEMO as a remote MCP server in ChatGPT.",
    callout: "Opens the official Plugins page. It does not connect automatically, and it does not prefill this server.",
    steps: [
      "Turn on Developer mode. Developer docs: Settings, then Security and login. On Business, Enterprise, and Edu, an admin may need Workspace settings, then Permissions and Roles, or Settings, then Apps, then Advanced settings. Availability depends on your plan.",
      "Continue to ChatGPT Plugins. OpenAI does not document a link that fills in this server or opens a confirmation dialog from a website.",
      "Select the plus button. Name it DEMO. Paste the endpoint as the MCP server URL, including /mcp. If asked, choose no authentication.",
      "Create the connection in ChatGPT. It discovers tools and applies its own approval controls. This page is not told whether you approved it.",
    ],
    limitations: [
      "No verified prefilled install URL, and no verified website-to-app confirmation dialog.",
      "The documented flow is ChatGPT on the web. A mobile-app install link was not found.",
      "This does not configure Codex or the ChatGPT desktop app. Those use a separate MCP setup.",
    ],
    fallback: "Paste the endpoint on the ChatGPT Plugins page after Developer mode is on.",
    manualCommand: null,
    manualConfig: null,
    manualConfigTitle: null,
    alternates: [],
    sources: [
      "https://developers.openai.com/plugins/deploy/connect-chatgpt",
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
    callout: "Opens Claude’s own Add custom connector dialog with this server filled in. You still review and confirm there.",
    steps: [
      "Continue to Claude. The official link opens the dialog with the name DEMO and this URL filled in, and notes that the values came from an external link.",
      "Sign in if Claude asks. Review the name and URL before you continue.",
      "If Claude asks for authentication, choose no sign-in. DEMO does not require it. Leave transport as detected — this URL is Streamable HTTP, not SSE.",
      "Confirm in Claude only if you trust this server. The link does not add the connector or grant any permission by itself.",
    ],
    limitations: [
      "Free plans can add one custom connector. Team and Enterprise members usually need an Owner.",
      "After you confirm, Anthropic reaches the server from its cloud for claude.ai, Claude Desktop, Cowork, and the mobile apps. This page cannot see that confirmation.",
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
    callout: "Opens Cursor’s install prompt on the desktop app. This page cannot see whether you approved it.",
    steps: [
      "Continue to Cursor. The official install link asks Cursor to prompt you to install this server. Your browser may ask permission to open the app.",
      "Approve the prompt in Cursor only if you trust this server. DEMO does not install the server itself.",
      "If Cursor does not open, copy the configuration below into ~/.cursor/mcp.json for every project, or .cursor/mcp.json for one project.",
    ],
    limitations: [
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
    callout: "Opens VS Code’s install flow with this HTTP server. Confirm it there. This page cannot see the result.",
    steps: [
      "Continue to Visual Studio Code. The official vscode:mcp/install link carries this server. Your browser may ask permission to open VS Code.",
      "Confirm the install in VS Code, and trust the server only if you intend to use it. VS Code asks before a newly added server starts.",
      "If VS Code does not open, copy the configuration below into .vscode/mcp.json, or run MCP: Open User Configuration and paste the server entry.",
    ],
    limitations: [
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
    callout: "Manual setup. Claude Code documents a terminal command, not an install link.",
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
    callout: "Manual setup. There is no universal one-click install.",
    steps: [
      "Paste the endpoint into your client’s remote MCP server settings.",
      "Use Streamable HTTP. Do not add an authentication header. DEMO has no account.",
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

export function connectClientPayload(): McpClientView[] {
  return MCP_CLIENTS.map(({ sources: _sources, ...client }) => client);
}

export function mcpClientById(id: string): McpClientIntegration | undefined {
  return MCP_CLIENTS.find((client) => client.id === id);
}
