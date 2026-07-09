# Connecting an AI agent to Byorn over MCP

Byorn exposes a Model Context Protocol (MCP) server at `<your-origin>/api/mcp`
(Streamable HTTP transport). Any MCP-compatible AI agent — Claude Desktop,
Cursor, Codex, or your own client — can connect to it and act on your project
directly, once it has an access token.

Tokens are created per-project from the editor: open the project's logo menu
(top-left of the editor header) → **Connect an AI agent (MCP)**. From there you
can create a token (shown once — copy it immediately), revoke old ones, and
generate the exact config for the client you use.

The sections below are the same instructions the in-app dialog generates,
kept here for reference and for anyone setting things up outside the editor.

## Claude Desktop

Claude Desktop's built-in Settings → Connectors flow only supports OAuth-based
remote servers — there's no field for a static bearer token. To authenticate
with a Byorn token, edit the config file directly and use the `mcp-remote`
bridge, which forwards your token as a custom header:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "byorn": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-origin>/api/mcp",
        "--header",
        "Authorization: Bearer <your-token>"
      ]
    }
  }
}
```

Merge this into any existing `mcpServers` object, save, then fully quit and
reopen Claude Desktop.

## Cursor

Cursor supports remote MCP servers natively — no bridge needed. Add this to
`~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` (project-scoped):

```json
{
  "mcpServers": {
    "byorn": {
      "url": "https://<your-origin>/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Cursor also supports one-click install links:
`cursor://anysphere.cursor-deeplink/mcp/install?name=byorn&config=<base64-encoded-json>`,
where the config JSON is `{"url": "...", "headers": {"Authorization": "Bearer ..."}}`.
The in-editor dialog generates this link for you with the token already baked
in.

## Codex CLI

Codex reads MCP servers from `~/.codex/config.toml` (global) or a trusted
project's `.codex/config.toml`. Append:

```toml
[mcp_servers.byorn]
url = "https://<your-origin>/api/mcp"
http_headers = { Authorization = "Bearer <your-token>" }
```

Restart Codex (CLI and the IDE extension share this file). There is currently
no published deep-link/install-URL scheme for Codex, so this is copy-paste
only — or run `codex mcp add` and answer its prompts with the same values.

## Notes

- Tokens are scoped to a single project. Create a separate token per project
  you want an agent to access.
- Revoke a token from the same dialog at any time — connected agents lose
  access on their next request after revocation.
- The raw token value is only ever shown once, at creation time. If you lose
  it, revoke it and create a new one.
