# Colab MCP Bridge

First safe build slice for the Colab MCP Bridge.

## Run Tests

```bash
npm install
npm test
```

## Local MCP Server

Build the TypeScript output, then run the local stdio JSON-RPC MCP server:

```bash
npm run build
COLAB_MCP_BRIDGE_BASE_URL=https://bridge.example \
COLAB_MCP_BRIDGE_SESSION_ID=sess_... \
COLAB_MCP_BRIDGE_CONTROLLER_TOKEN=br_... \
node dist/src/mcp-server.js
```

`COLAB_MCP_BRIDGE_WORKER_URL` can be used instead of
`COLAB_MCP_BRIDGE_BASE_URL`. The same values can also be loaded from a JSON
config file with `base_url` or `worker_url`, `session_id`, and
`controller_token`.

## Implemented In This Slice

- TypeScript scaffold with protocol types and envelope helpers.
- Token generation, hashing, verification, timestamp skew validation, nonce replay rejection, revoke support, and audit logging.
- A local in-memory broker with an explicit repository interface and persisted command state transitions.
- A fake runner path for authenticated `ping` and `status` commands.
- A local Worker-style HTTP route layer over the broker, testable with plain Node
  `Request`/`Response` objects.
- HTTP routes for health, authenticated session creation, controller status,
  command creation, command result polling, and revoke.
- MCP tool metadata and result helpers using `content[]`, `structuredContent`, `isError`, annotations, and output schemas.
- A minimal JSON-RPC MCP server over stdio or an in-memory transport.
- MCP `initialize`, `tools/list`, and `tools/call` support for the current safe
  tool surface.
- Local MCP config parsing/loading and authenticated HTTP client calls with a
  fresh timestamp and nonce per bridge request.

## Intentionally Not Implemented Yet

- Real Cloudflare deployment, Durable Objects, WebSockets, and SQLite storage.
- Real Colab runner code.
- Shell execution, `run_python`, file tools, and background jobs.
- Deployed Cloudflare wiring for the MCP server. The server is local and
  testable, and currently targets the existing HTTP handler/client path.

The HTTP route layer intentionally has no runner-attach production endpoint; tests attach
`FakeRunner` through an exported helper. Dangerous tools are represented as disabled
metadata/helper responses only. They do not execute.
