# Colab MCP Bridge

First safe build slice for the Colab MCP Bridge.

## Run Tests

```bash
npm install
npm test
```

## Worker Slice

The Worker-shaped entrypoint is `src/worker.ts`. It exports the default
`fetch` handler plus `ColabBridgeSessionDurableObject` for the current safe HTTP
bridge routes. Tests call the Worker with plain Node `Request`/`Response`
objects and a mocked env:

```ts
await worker.fetch(request, { ADMIN_SECRET: "test_admin_secret" });
```

`wrangler.toml` defines the Durable Object binding and deliberately does not
contain secrets. Configure the deployment admin secret outside source control,
for example with Wrangler secrets:

```bash
npx wrangler secret put ADMIN_SECRET
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
- A fake runner path for authenticated `ping`, `status`, and fixed
  `gpu_status` commands.
- A local Worker-style HTTP route layer over the broker, testable with plain Node
  `Request`/`Response` objects.
- HTTP routes for health, authenticated session creation, controller status,
  command creation, command result polling, revoke, and the authenticated
  runner attach route shape `GET /v1/sessions/:session_id/runner/ws`.
- A runner transport seam for Node tests, with runner attach authenticated by
  headers and session metadata updated on attach, reconnect, and restart.
- MCP tool metadata and result helpers using `content[]`, `structuredContent`, `isError`, annotations, and output schemas.
- A minimal JSON-RPC MCP server over stdio or an in-memory transport.
- MCP `initialize`, `tools/list`, and `tools/call` support for the current safe
  tool surface.
- `colab_gpu_status`, enabled by default as a read-only, open-world,
  idempotent MCP tool. It creates only the fixed `gpu_status` command and
  returns the serialized command result.
- Local MCP config parsing/loading and authenticated HTTP client calls with a
  fresh timestamp and nonce per bridge request.
- A Cloudflare Worker-shaped entry module with an env-scoped in-memory fallback
  for local tests and a Durable Object class with explicit persisted broker
  state shape.
- Secret-free Wrangler configuration for the Worker and Durable Object binding.
- A Python Colab runner skeleton at `python/colab_runner.py` documenting the
  outbound runner connection shape and implementing only the fixed GPU probe.

## Intentionally Not Implemented Yet

- Real deployed Cloudflare integration tests, full WebSocket handling in Node
  tests, and full SQLite table-backed Durable Object storage.
- Shell execution, `run_python`, file tools, and background jobs.
- Deployed Cloudflare wiring for the MCP server. The server is local and
  testable, and currently targets the existing HTTP handler/client path.

The runner GPU status path remains fixed-command only. It does not expose
arbitrary shell execution, Python execution, file access, or background jobs.
Dangerous tools are represented as disabled metadata/helper responses only.
They do not execute.
