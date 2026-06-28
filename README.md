# Colab MCP Bridge

First safe build slice for the Colab MCP Bridge.

## Run Tests

```bash
npm install
npm test
```

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

## Intentionally Not Implemented Yet

- Real Cloudflare deployment, Durable Objects, WebSockets, and SQLite storage.
- Real Colab runner code.
- Shell execution, `run_python`, file tools, and background jobs.
- A full STDIO MCP server.

The HTTP route layer intentionally has no runner-attach production endpoint; tests attach
`FakeRunner` through an exported helper. Dangerous tools are represented as disabled
metadata/helper responses only. They do not execute.
