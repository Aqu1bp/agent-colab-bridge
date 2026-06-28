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
- MCP tool metadata and result helpers using `content[]`, `structuredContent`, `isError`, annotations, and output schemas.

## Intentionally Not Implemented Yet

- Cloudflare Worker routes, Durable Objects, WebSockets, and SQLite storage.
- Real Colab runner code.
- Shell execution, `run_python`, file tools, and background jobs.
- A full STDIO MCP server.

Dangerous tools are represented as disabled metadata/helper responses only. They do not execute.
