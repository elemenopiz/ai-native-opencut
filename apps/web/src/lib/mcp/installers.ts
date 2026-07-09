/**
 * Per-client MCP install config generation — pure functions, no I/O.
 *
 * Byorn exposes its MCP server at `<origin>/api/mcp` (Streamable HTTP transport,
 * authenticated via `Authorization: Bearer <token>`). Each of these functions
 * renders the exact config a given AI client expects to add that endpoint as a
 * remote MCP server, plus (where the client supports it) a one-click deep link.
 *
 * Shapes were verified against each client's current docs as of 2026-07:
 *  - Claude Desktop: the Settings > Connectors UI is OAuth-only and has no field
 *    for a static bearer token, so authenticated remote servers are wired via
 *    `claude_desktop_config.json` using the `mcp-remote` stdio bridge, which
 *    forwards a custom header to the remote endpoint. This is the
 *    community-standard, version-agnostic path (see e.g. Anthropic's own
 *    Filesystem-server quickstart for the config file location + shape, and
 *    numerous connector guides — Sentry/Notion/GitHub MCP docs — that all use
 *    `mcp-remote` for Claude Desktop specifically because native `url`+`headers`
 *    support for arbitrary headers rolled out inconsistently across versions).
 *    Source: https://modelcontextprotocol.io/docs/develop/connect-local-servers ,
 *    https://modelcontextprotocol.io/docs/develop/connect-remote-servers ,
 *    community bug report on missing bearer-token UI:
 *    https://github.com/anthropics/claude-ai-mcp/issues/112
 *  - Cursor: native `url` + `headers` remote-server shape in `mcp.json`, no
 *    `type` field required. Source: https://cursor.com/docs/mcp . Deep link
 *    format `cursor://anysphere.cursor-deeplink/mcp/install?name=&config=` (config
 *    is base64 of the single-server JSON object) per
 *    https://cursor.com/docs/context/mcp/install-links .
 *  - Codex CLI: TOML `[mcp_servers.<name>]` block in `config.toml`, `url` +
 *    `http_headers` for a static Authorization header (no experimental flag
 *    needed for streamable-http remotes). Source:
 *    https://developers.openai.com/codex/config-reference and
 *    https://developers.openai.com/codex/mcp .
 */

export type McpClientId = "claude-desktop" | "cursor" | "codex";

export interface McpInstallerInput {
	/** Live origin the MCP endpoint is served from, e.g. `https://byorn.app` or `http://localhost:3000`. */
	origin: string;
	/** Raw bearer token, freshly created (shown once) or pasted by the user. */
	token: string;
	/** Display name for the server entry. Defaults to "byorn". */
	serverName?: string;
}

export interface McpInstallerResult {
	client: McpClientId;
	/** Where the user should put this config, per-OS when relevant. */
	filePath: string;
	/** The config content to copy-paste (JSON or TOML depending on client). */
	json: string;
	/** Syntax used for `json` — most clients are JSON, Codex is TOML. */
	language: "json" | "toml";
	/** One-click install URL, when the client supports a deep link. Absent otherwise. */
	deepLink?: string;
	/** Human instructions shown alongside the config. */
	instructions: string;
}

const DEFAULT_SERVER_NAME = "byorn";

/** MCP server names must be simple identifiers — slugify anything user-supplied. */
function slugifyServerName(name: string | undefined): string {
	const slug = (name ?? DEFAULT_SERVER_NAME)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || DEFAULT_SERVER_NAME;
}

function mcpUrl(origin: string): string {
	return `${origin.replace(/\/+$/, "")}/api/mcp`;
}

export function getClaudeDesktopInstaller({
	origin,
	token,
	serverName,
}: McpInstallerInput): McpInstallerResult {
	const name = slugifyServerName(serverName);
	const config = {
		mcpServers: {
			[name]: {
				command: "npx",
				args: [
					"-y",
					"mcp-remote",
					mcpUrl(origin),
					"--header",
					`Authorization: Bearer ${token}`,
				],
			},
		},
	};

	return {
		client: "claude-desktop",
		filePath:
			"macOS: ~/Library/Application Support/Claude/claude_desktop_config.json  ·  Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
		json: JSON.stringify(config, null, 2),
		language: "json",
		// No deep-link scheme is published for Claude Desktop config installs —
		// Settings > Connectors only accepts OAuth-based remotes, not static bearer
		// tokens, so this has to be a manual file edit + restart.
		instructions:
			"Open Claude Desktop -> Settings -> Developer -> Edit Config. Paste this into claude_desktop_config.json (merging with any existing mcpServers entries), save, then fully quit and reopen Claude Desktop. This uses the mcp-remote bridge, which forwards your bearer token as a custom header — Claude Desktop's built-in Connectors UI doesn't support static bearer tokens directly.",
	};
}

export function getCursorInstaller({
	origin,
	token,
	serverName,
}: McpInstallerInput): McpInstallerResult {
	const name = slugifyServerName(serverName);
	const serverConfig = {
		url: mcpUrl(origin),
		headers: {
			Authorization: `Bearer ${token}`,
		},
	};
	const config = { mcpServers: { [name]: serverConfig } };

	const deepLinkConfig = JSON.stringify(serverConfig);
	const base64Config =
		typeof btoa === "function"
			? btoa(deepLinkConfig)
			: Buffer.from(deepLinkConfig, "utf-8").toString("base64");
	const deepLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(base64Config)}`;

	return {
		client: "cursor",
		filePath: "~/.cursor/mcp.json (global) or <project>/.cursor/mcp.json (project-scoped)",
		json: JSON.stringify(config, null, 2),
		language: "json",
		deepLink,
		instructions:
			'Click "Install in Cursor" to prompt Cursor to add this server automatically, or open Cursor -> Settings -> MCP -> Add new MCP server and paste this JSON into ~/.cursor/mcp.json.',
	};
}

export function getCodexInstaller({
	origin,
	token,
	serverName,
}: McpInstallerInput): McpInstallerResult {
	const name = slugifyServerName(serverName).replace(/-/g, "_");
	const toml = [
		`[mcp_servers.${name}]`,
		`url = "${mcpUrl(origin)}"`,
		`http_headers = { Authorization = "Bearer ${token}" }`,
	].join("\n");

	return {
		client: "codex",
		filePath: "~/.codex/config.toml (global) or <project>/.codex/config.toml (trusted projects only)",
		json: toml,
		language: "toml",
		// Codex has no published deep-link/install-URL scheme as of 2026-07 —
		// `codex mcp add` is a CLI command, not a clickable URL, so this stays
		// copy-paste (or a terminal one-liner, offered separately in the UI).
		instructions:
			"Append this block to ~/.codex/config.toml (or run `codex mcp add` and answer the prompts with the same values), then restart Codex. The CLI and IDE extension share this config file.",
	};
}

export interface McpClientDescriptor {
	id: McpClientId;
	label: string;
	generate: (input: McpInstallerInput) => McpInstallerResult;
}

export const MCP_CLIENTS: McpClientDescriptor[] = [
	{ id: "claude-desktop", label: "Claude Desktop", generate: getClaudeDesktopInstaller },
	{ id: "cursor", label: "Cursor", generate: getCursorInstaller },
	{ id: "codex", label: "Codex", generate: getCodexInstaller },
];

export function getMcpInstaller(
	client: McpClientId,
	input: McpInstallerInput,
): McpInstallerResult {
	const descriptor = MCP_CLIENTS.find((c) => c.id === client);
	if (!descriptor) {
		throw new Error(`Unknown MCP client: ${client}`);
	}
	return descriptor.generate(input);
}
