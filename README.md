# Colab MCP Bridge

First safe build slice for the Colab MCP Bridge.

## Run Tests

```bash
npm install
npm test
```

## Local Setup And Doctor

After deploying a Worker and configuring its `ADMIN_SECRET`, create a bridge
session and write the local MCP config with:

```bash
export COLAB_MCP_BRIDGE_BASE_URL=https://bridge.example
export COLAB_MCP_BRIDGE_ADMIN_SECRET=...

npm run setup:bridge
```

This writes `~/.config/colab-mcp-bridge/config.json` by default with
`base_url`, `session_id`, `controller_token`, and
`enable_dangerous_tools`. It does not persist the runner token and never prints
admin, controller, or runner token values.

To create the Worker session and immediately bootstrap Colab while keeping the
runner token in process environment only:

```bash
npm run setup:bridge -- --bootstrap --colab-session colab-mcp-bridge --gpu T4
```

Check local prerequisites and config shape with:

```bash
npm run doctor
```

The doctor checks Node, installed package files, `uvx`, `google-colab-cli`,
`wrangler`, local MCP config, Worker `/health` when a URL is configured, and
authenticated bridge status when the local controller token exists. Use
`npm run doctor -- --skip-network` for local-only checks.

## Deploy And Smoke Test

Deploy the Worker/Durable Object with Wrangler:

```bash
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS # enter 1 only if you want shell/job/file-write tools enabled
npx wrangler deploy
```

Then create a bridge session and bootstrap Colab:

```bash
export COLAB_MCP_BRIDGE_BASE_URL=https://<worker-name>.<subdomain>.workers.dev
export COLAB_MCP_BRIDGE_ADMIN_SECRET=...

npm run setup:bridge -- --enable-dangerous-tools --bootstrap --colab-session colab-mcp-bridge --gpu T4
```

Run local diagnostics:

```bash
npm run doctor -- --require-network
```

Finally, smoke test the real Codex-facing MCP path:

```bash
npm run smoke:mcp
npm run smoke:mcp -- --dangerous # also verifies colab_run_shell
```

The smoke command starts the local stdio MCP server, reads the local config, and
calls MCP tools against the deployed Worker and connected Colab runner. It does
not print token values.

## Bootstrap A Colab Runtime

The primary bootstrap flow uses PyPI's `google-colab-cli` through `uvx`. The CLI
provisions or reuses the Colab runtime; this MCP bridge controls the already-live
runner after it connects.

Create a bridge session through the Worker first, then export the values needed
by the Colab runner. The runner token is only for the Colab-side runner; the
controller token is optional here and is used only for status polling.

```bash
export COLAB_MCP_BRIDGE_BASE_URL=https://bridge.example
export COLAB_MCP_BRIDGE_SESSION_ID=sess_...
export COLAB_MCP_BRIDGE_RUNNER_TOKEN=br_...
export COLAB_MCP_BRIDGE_CONTROLLER_TOKEN=br_... # optional status polling

npm run bootstrap:colab
```

The bootstrap script shells out to:

```bash
uvx --from google-colab-cli colab ...
```

It checks for a named Colab session, creates one if needed, requests a T4 GPU by
default, installs `websockets`, creates `/content/project`, uploads
`python/colab_runner.py`, uploads a temporary runner config file, and starts the
runner in the Colab runtime with `COLAB_BRIDGE_URL`,
`COLAB_BRIDGE_SESSION_ID`, and `COLAB_BRIDGE_RUNNER_TOKEN` set. It also sets
`COLAB_BRIDGE_PROJECT_ROOT` so the runner uses the requested project root. Token
values are not printed, and the start script deletes the uploaded runner config
after reading it.

Useful options:

```bash
npm run bootstrap:colab -- --dry-run
npm run bootstrap:colab -- --colab-session colab-mcp-bridge --gpu T4
npm run bootstrap:colab -- --project-root /content/project --runner-path python/colab_runner.py
npm run bootstrap:colab -- --bridge-config ./bootstrap.json
```

The explicit bootstrap config can contain `base_url` or `worker_url`,
`session_id`, `runner_token`, and optional `controller_token`,
`colab_session`, `project_root`, `runner_path`, `remote_runner_path`,
`remote_config_path`, `gpu`, and `colab_config`. The script does not create or
modify local user config.

If `google-colab-cli` is not available or cannot authenticate, the fallback is a
manual Colab notebook bootstrap:

```python
%pip install websockets
from pathlib import Path
import os

Path("/content/project").mkdir(parents=True, exist_ok=True)
os.environ["COLAB_BRIDGE_URL"] = "https://bridge.example"
os.environ["COLAB_BRIDGE_SESSION_ID"] = "sess_..."
os.environ["COLAB_BRIDGE_RUNNER_TOKEN"] = "br_..."
os.environ["COLAB_BRIDGE_PROJECT_ROOT"] = "/content/project"

# Upload python/colab_runner.py to /content/project/colab_runner.py first.
%run /content/project/colab_runner.py
```

Use `google-colab-cli upload` / `download` or external storage such as Google
Drive, GCS, Hugging Face Hub, or GitHub Releases for large artifacts. Do not send
datasets, checkpoints, package caches, or full training outputs through
Cloudflare.

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

Dangerous foreground execution, file writes, and background job control are
disabled unless explicitly enabled in local policy. To allow
`colab_run_shell`, `colab_run_python`, `colab_write_file`, `colab_start_job`,
and `colab_interrupt_job`, set one of:

```bash
COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS=1
```

or add `"enable_dangerous_tools": true` / `"enableDangerousTools": true` to the
local config file. The Worker/HTTP handler must also be started with the same
explicit enablement, for example with `COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS=1`
in the Worker environment. Without this, `run_shell`, `run_python`, and
`write_file`, `start_job`, and `interrupt_job` return `TOOL_DISABLED`.
`read_file` and `tail_job` are read-only and enabled by default, but the runner
still enforces project-root path and size/log limits.

## Implemented In This Slice

- TypeScript scaffold with protocol types and envelope helpers.
- Token generation, hashing, verification, timestamp skew validation, nonce replay rejection, revoke support, and audit logging.
- A local in-memory broker with an explicit repository interface and persisted command state transitions.
- A fake runner path for authenticated `ping`, `status`, and fixed
  `gpu_status` commands, plus bounded foreground `run_shell` and `run_python`
  when explicitly enabled.
- A local Worker-style HTTP route layer over the broker, testable with plain Node
  `Request`/`Response` objects.
- HTTP routes for health, authenticated session creation, controller status,
  command creation, command result polling, revoke, and the authenticated
  runner WebSocket route `GET /v1/sessions/:session_id/runner/ws`.
- A runner transport seam for Node tests, with runner attach authenticated by
  headers and session metadata updated on attach, reconnect, and restart.
- Cloudflare Durable Object runner WebSocket handling using `WebSocketPair`,
  accepted server sockets, serialized runner socket attachments, heartbeat
  messages, and command/result forwarding over the runner socket.
- MCP tool metadata and result helpers using `content[]`, `structuredContent`, `isError`, annotations, and output schemas.
- A minimal JSON-RPC MCP server over stdio or an in-memory transport.
- MCP `initialize`, `tools/list`, and `tools/call` support for the current safe
  tool surface.
- `colab_gpu_status`, enabled by default as a read-only, open-world,
  idempotent MCP tool. It creates only the fixed `gpu_status` command and
  returns the serialized command result.
- `colab_run_shell` and `colab_run_python`, still disabled by default and only
  executable when local MCP config/options and HTTP/Worker context explicitly
  enable dangerous tools. These commands enforce a default 30 second timeout,
  a hard 120 second timeout maximum, and a 20 KiB output cap.
- `colab_write_file`, disabled by default and gated by the same explicit local
  dangerous-tool enablement on both MCP and HTTP/Worker sides. It writes UTF-8
  text under the project root with `overwrite`, `append`, or `create_new` mode
  and a 1 MiB content cap.
- `colab_read_file`, enabled by default as a read-only, open-world, idempotent
  MCP tool. It reads UTF-8 text under the project root with a 20 KiB default
  read limit, a 1 MiB hard cap, and truncation metadata.
- Runner-side file path safety for file tools: relative paths only, lexical
  traversal rejection, no symlink parents, no symlink targets, regular-file
  checks, same-directory temp writes for `overwrite`, and create-new protection.
- `colab_start_job`, disabled by default and gated by the same explicit local
  dangerous-tool enablement. It starts one background shell job in the runner
  project root, in a new process group, and returns immediately with a `job_id`.
- `colab_tail_job`, enabled by default as a read-only, open-world, idempotent
  MCP tool. It returns bounded merged stdout/stderr log events by cursor with a
  20 KiB default tail limit and a 200 KiB hard cap.
- `colab_interrupt_job`, disabled by default and gated by explicit local
  dangerous-tool enablement. It signals the job process group and escalates from
  `SIGTERM` to `SIGKILL` after `kill_after_sec`.
- Runner-side background job state for the fake runner and Python Colab runner:
  one active job, bounded 200 KiB log ring, cursor expiry, `log_dropped` events,
  completed-job tailing while runner process state remains, and process-group
  interrupt handling.
- Local MCP config parsing/loading and authenticated HTTP client calls with a
  fresh timestamp and nonce per bridge request.
- A Cloudflare Worker-shaped entry module with an env-scoped in-memory fallback
  for local tests and a Durable Object class with explicit persisted broker
  state shape.
- Secret-free Wrangler configuration for the Worker and Durable Object binding.
- A Python Colab runner at `python/colab_runner.py` documenting the outbound
  runner connection shape and implementing the fixed GPU probe, bounded
  foreground shell/Python commands, safe file read/write commands, and
  background job start/tail/interrupt commands under `/content/project`.

## Intentionally Not Implemented Yet

- Real deployed Cloudflare integration tests, real Colab smoke tests, and full
  SQLite table-backed Durable Object storage.
- Durable Object-backed job/log persistence across Worker hibernation or Colab
  runner process restart. Current job/log state is owned by the connected
  runner process.
- Deployed Cloudflare wiring for the MCP server. The server is local and
  testable, and currently targets the existing HTTP handler/client path.

Shell/Python foreground execution and background job starts are remote code
execution in the Colab VM, interrupts terminate process groups, and file writes
are destructive file access; all remain disabled by default in metadata and
local policy. They execute only after explicit local enablement on both the MCP
and HTTP/Worker sides. File path restrictions on `read_file` and `write_file`
do not limit what enabled shell, Python, or background job commands can do.
