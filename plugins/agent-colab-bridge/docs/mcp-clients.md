# MCP Client Setup

`agent-colab-bridge` can run as a generic local stdio MCP server from the npm
package:

```bash
npx -y agent-colab-bridge mcp
```

The server writes MCP JSON-RPC messages to stdout. Startup diagnostics and
errors are written to stderr.

## Claude Code

Add the server with Claude Code's stdio transport:

```bash
claude mcp add --transport stdio colab-bridge -- npx -y agent-colab-bridge mcp
```

For project-scoped configuration, Claude Code may create or read a project
`.mcp.json`. Review and approve that file only for projects you trust, because
this bridge can enable remote code execution inside your Colab runtime after
setup.

## Cursor

Create `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "colab-bridge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-colab-bridge", "mcp"]
    }
  }
}
```

## OpenCode

Add the local MCP server to `opencode.json`:

```json
{
  "mcp": {
    "colab-bridge": {
      "type": "local",
      "command": ["npx", "-y", "agent-colab-bridge", "mcp"],
      "enabled": true
    }
  }
}
```
