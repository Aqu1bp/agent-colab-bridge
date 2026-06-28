# Colab MCP Bridge Implementation Spec

Status: Revised after independent review
Date: 2026-06-28

## Objective

Build a Codex-to-Colab bridge that lets Codex operate a Google Colab Pro GPU runtime through MCP tools without requiring inbound network access to the Colab VM.

The bridge is an authenticated remote job runner, not a general-purpose secure sandbox. Colab keeps an outbound WebSocket open to Cloudflare. Codex talks to a local MCP server on the Mac. Cloudflare coordinates the session.

```text
Codex
  |
  | MCP stdio
  v
Local MCP adapter on Mac
  |
  | HTTPS/WebSocket
  v
Cloudflare Worker + Durable Object
  ^
  | outbound WebSocket
  |
Colab runner cell
```

## Sources And Constraints

- Codex supports MCP servers through local STDIO and Streamable HTTP configuration. Use a local STDIO MCP server for the MVP because it is simple and avoids exposing another local HTTP listener. Source: https://developers.openai.com/codex/mcp
- MCP tools are listed and called through the standard tools interface. The tool surface for this project should be static at startup; do not require dynamic `notifications/tools/list_changed` behavior for the MVP. Tool call results must use MCP `CallToolResult` shape: `content[]`, optional `structuredContent`, optional `isError`, and declared `outputSchema`s. Source: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Cloudflare Durable Objects are designed for coordination among connected clients and support WebSockets. Use one Durable Object instance per bridge session. Source: https://developers.cloudflare.com/durable-objects/
- Cloudflare recommends the WebSocket Hibernation API for Durable Object WebSocket applications. Hibernation means in-memory state can disappear, so persistent session metadata must be stored explicitly. Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Use SQLite-backed Durable Objects for new sessions. Cloudflare recommends SQLite-backed Durable Objects for new namespaces, and each Durable Object has private transactional storage. Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Cloudflare Durable Objects and Workers have platform limits, including Durable Object storage limits, value size limits, WebSocket message limits, Worker memory limits, and request body limits. The bridge must chunk logs/files and avoid buffering unbounded output in memory. Sources: https://developers.cloudflare.com/durable-objects/platform/limits/ and https://developers.cloudflare.com/workers/platform/limits/
- Google Colab runtimes are ephemeral. Paid Colab plans may reduce some free-tier restrictions while the account has available compute, but GPU type, availability, idle timeout, and maximum runtime are still conditional and not guaranteed. Source: https://research.google.com/colaboratory/faq.html

## Independent Review Changes

An independent agent reviewed the first draft before implementation. The revised spec incorporates the main findings:

- Auth, replay rejection, revoke, audit logging, and rate limiting are now Phase 1 requirements, before any shell execution.
- Durable Object hibernation no longer depends on in-memory pending promises; commands now use a persisted state machine and pollable results.
- MCP tool results are specified as MCP `CallToolResult`s, with `structuredContent`, `content[]`, `isError`, output schemas, and annotations.
- Dangerous tools are disabled by default and require explicit local enablement/approval.
- Durable Object storage is specified as SQLite-backed, with chunked log rows and compaction markers.
- Runner reconnects distinguish network reconnect, runner restart, and unknown/lost job state.
- File path safety, log cursors, and failure-mode tests are now specified more concretely.

## Product Goals

- Give Codex a small set of MCP tools for controlling a Colab runtime.
- Support short foreground commands and long background training/evaluation jobs.
- Stream or tail logs without overrunning MCP, Cloudflare, or model context limits.
- Make Colab runner reconnects tolerable.
- Keep all commands rooted in a project directory by default.
- Make dangerous behavior explicit: `run_shell` is remote code execution in the Colab VM.

## Non-Goals

- No SSH server in Colab.
- No interactive TTY in the MVP.
- No multi-runner scheduling in the MVP.
- No big checkpoint transfer through Cloudflare in the MVP.
- No guarantee that jobs survive Colab VM deletion.
- No attempt to make arbitrary shell commands unable to read secrets. The security model is authentication and containment by operational practice, not a complete sandbox.

## User Workflow

1. Deploy the Cloudflare Worker and Durable Object.
2. Create a bridge session from the local machine. The local command stores the controller token in local config and prints a runner bootstrap snippet.
3. Open a Colab notebook, paste the runner bootstrap snippet, and run it while signed in to a Colab Pro account with a positive compute unit balance.
4. The bootstrap cell starts the Colab runner and prints:

   ```text
   SESSION_ID=...
   BRIDGE_URL=...
   RUNNER_STATUS=connected
   ```

   The bootstrap output must not print controller or runner tokens.

5. Configure the local MCP adapter with the Worker URL, `session_id`, and locally stored controller token.
6. Codex uses MCP tools to check status, upload small files, start jobs, tail logs, and interrupt jobs.
7. Training checkpoints and larger artifacts are saved outside the bridge path, e.g. Google Drive, Hugging Face Hub, GCS, R2, or GitHub Releases.

## Module Map

### Local MCP Adapter

This module presents the external interface to Codex.

Interface:

- MCP tool definitions
- MCP tool argument schemas
- MCP `CallToolResult` mapping, including `content[]`, `structuredContent`, `isError`, and `outputSchema`s
- MCP tool annotations for read-only, destructive, idempotent, and open-world behavior
- Local config loading
- Auth headers, timestamp/nonce replay protection, and timeout behavior
- Local approval/enablement policy for dangerous tools

Implementation:

- Node.js/TypeScript MCP server over STDIO
- Static tool list
- HTTPS/WebSocket client to Cloudflare
- JSON schema validation for inputs and outputs
- Bounded retries for idempotent requests
- Refusal responses for tools disabled by local policy

Depth expectation: callers learn a small tool surface while the adapter hides Cloudflare routing, auth headers, protocol framing, retries, and response normalization.

### Cloudflare Session Broker

This module coordinates one controller and one Colab runner for a session.

Interface:

- HTTP/WebSocket routes
- Session creation/attachment rules
- Auth headers
- Message envelope schema
- Session state and expiry semantics
- Command state machine semantics
- Log cursor semantics

Implementation:

- Worker route dispatcher
- Durable Object per `session_id`
- WebSocket Hibernation API
- Persistent session metadata
- SQLite-backed Durable Object tables for sessions, command inbox/results, jobs, and chunked log rows
- Ring-buffer compaction with explicit dropped-log markers
- Heartbeat and disconnect tracking
- Replay protection and audit logging

Depth expectation: it hides connection lifecycle and rendezvous behavior behind a tiny remote-control protocol.

### Colab Runner

This module executes commands inside the Colab runtime.

Interface:

- Bootstrap configuration
- Runner WebSocket protocol
- Command execution behavior
- File read/write constraints
- Job lifecycle behavior
- Runner identity and reconnect semantics

Implementation:

- Python asyncio process runner
- `runner_instance_id` generated at runner startup
- `kernel_started_at` captured at runner startup
- Shell command execution under `/content/project`
- Process group handling for interrupts
- Log capture and chunking
- GPU status probe
- Path canonicalization for file tools

Depth expectation: it hides Colab process management and runtime quirks behind a small command/job interface.

## MCP Tool Interface

The local adapter must return MCP-compliant `CallToolResult` objects.

For successful tool execution:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Runner connected. No active job."
    }
  ],
  "structuredContent": {
    "ok": true,
    "data": {},
    "error": null
  },
  "isError": false
}
```

For tool execution failure:

```json
{
  "content": [
    {
      "type": "text",
      "text": "RUNNER_OFFLINE: No Colab runner is connected for this session."
    }
  ],
  "structuredContent": {
    "ok": false,
    "data": null,
    "error": {
      "code": "RUNNER_OFFLINE",
      "message": "No Colab runner is connected for this session.",
      "retryable": true
    }
  },
  "isError": true
}
```

Protocol-level adapter bugs, invalid MCP framing, or schema bugs may still raise MCP protocol errors. Expected remote failures use `isError: true` with structured content.

Every MCP tool must declare:

- `inputSchema`
- `outputSchema`
- annotations:
  - `readOnlyHint`
  - `destructiveHint`
  - `idempotentHint`
  - `openWorldHint`

All tools set `openWorldHint: true` because they operate a remote Colab runtime through Cloudflare.

Default local policy:

- Read-only tools are enabled by default.
- `colab_run_shell`, `colab_run_python`, `colab_write_file`, `colab_start_job`, and `colab_interrupt_job` require explicit enablement in local config and should use Codex/MCP approval prompting.
- The static tool list can still include disabled tools; disabled tools return `TOOL_DISABLED`.

### `colab_status`

Arguments:

```json
{}
```

Annotations:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": true
}
```

Returns:

```json
{
  "session_id": "abc123",
  "runner_connected": true,
  "controller_connected": true,
  "runner_instance_id": "runner_...",
  "kernel_started_at": "2026-06-28T09:59:00Z",
  "runner_started_at": "2026-06-28T10:00:00Z",
  "last_heartbeat_at": "2026-06-28T10:05:00Z",
  "project_root": "/content/project",
  "active_job_id": "job_...",
  "session_expires_at": "2026-06-28T18:00:00Z"
}
```

### `colab_gpu_status`

Runs a short GPU probe in Colab.

Annotations:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": true
}
```

Preferred implementation:

```bash
nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader
```

Fallback:

```python
import torch
```

Return both raw and normalized fields when possible.

### `colab_run_shell`

Short foreground shell command.

Annotations:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": false,
  "openWorldHint": true
}
```

Arguments:

```json
{
  "command": "python --version",
  "timeout_sec": 30,
  "max_output_bytes": 20000
}
```

Rules:

- CWD is always the project root.
- Timeout defaults to 30 seconds and has a hard maximum of 120 seconds.
- Output is capped.
- Return exit code, truncated stdout, truncated stderr, duration, and whether truncation occurred.
- Use only for setup/probes/small commands. Training uses `colab_start_job`.

### `colab_run_python`

Short foreground Python execution.

Annotations:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": false,
  "openWorldHint": true
}
```

Arguments:

```json
{
  "code": "print('hello')",
  "timeout_sec": 30,
  "max_output_bytes": 20000
}
```

Implementation: write code to a temporary file under the project temp directory and execute it with `python`.

### `colab_write_file`

Small text file upload.

Annotations:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": false,
  "openWorldHint": true
}
```

Arguments:

```json
{
  "path": "src/train.py",
  "content": "print('train')",
  "mode": "overwrite"
}
```

Rules:

- `path` must be relative to project root.
- Reject absolute paths.
- Reject path traversal.
- Reject symlink escapes.
- Normalize lexical path first and reject `.`-only, empty, absolute, or `..`-containing paths.
- Traverse each existing parent directory with no-follow checks.
- Reject if any parent component is a symlink.
- For `overwrite` and `create_new`, write to a temporary file in the same parent directory and atomically rename.
- Reject overwrite targets that are symlinks.
- For `append`, reject symlink targets and append only to regular files.
- Treat content as UTF-8 text for MVP.
- Maximum content size for MVP: 1 MiB.
- Modes: `overwrite`, `append`, `create_new`.

### `colab_read_file`

Small text file read.

Annotations:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": true
}
```

Arguments:

```json
{
  "path": "logs/latest.txt",
  "max_bytes": 20000
}
```

Rules:

- Same canonical path restrictions as `write_file`.
- Reject symlink targets.
- Treat content as UTF-8 text for MVP.
- Maximum read size for MVP: 1 MiB.
- Return truncation metadata.

### `colab_start_job`

Starts one background job.

Annotations:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": false,
  "openWorldHint": true
}
```

Arguments:

```json
{
  "command": "python train.py --config configs/smoke.yaml",
  "name": "smoke-train",
  "max_log_bytes": 200000
}
```

Rules:

- MVP allows one active background job per session.
- Job starts in a new process group.
- CWD is project root.
- Return immediately with `job_id`.
- Keep a ring buffer of logs.
- Persist job metadata in the Durable Object.
- The job itself runs in Colab, so job process state is lost if the Colab VM dies.
- Store runner instance and process group metadata with the job.
- If a runner reconnects with a different `runner_instance_id`, mark any previously running job `unknown_lost` unless the new runner explicitly reports that process group still exists.

Returns:

```json
{
  "job_id": "job_abc",
  "status": "running",
  "started_at": "2026-06-28T10:00:00Z"
}
```

### `colab_tail_job`

Read-only tail of the merged job event stream.

Annotations:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": true
}
```

Arguments:

```json
{
  "job_id": "job_abc",
  "cursor": 0,
  "max_bytes": 20000
}
```

Returns:

```json
{
  "job_id": "job_abc",
  "status": "running",
  "next_cursor": 18333,
  "events": [
    {
      "cursor": 12345,
      "stream": "stdout",
      "text": "...",
      "at": "2026-06-28T10:00:01Z"
    }
  ],
  "truncated": false,
  "exit_code": null
}
```

Rules:

- Cursor is monotonic over a merged ordered event stream.
- If the cursor has fallen out of the ring buffer, return `CURSOR_EXPIRED` with the oldest available cursor.
- Preserve UTF-8 boundaries when chunking logs.
- Redact configured secret values before log chunks are persisted.
- If logs are dropped due to backpressure or ring-buffer compaction, insert a synthetic `log_dropped` event with byte counts.
- Never return unbounded output.

### `colab_interrupt_job`

Annotations:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": false,
  "openWorldHint": true
}
```

Arguments:

```json
{
  "job_id": "job_abc",
  "signal": "SIGTERM",
  "kill_after_sec": 5
}
```

Rules:

- Signal the process group, not only the parent process.
- Escalate to `SIGKILL` after `kill_after_sec`.
- Return final known status.

## Protocol Design

### Message Envelope

Every command between local adapter, Durable Object, and runner uses this envelope:

```json
{
  "protocol_version": 1,
  "session_id": "sess_...",
  "command_id": "cmd_...",
  "message_id": "msg_...",
  "kind": "command",
  "type": "run_shell",
  "sent_at": "2026-06-28T10:00:00Z",
  "deadline_at": "2026-06-28T10:00:30Z",
  "payload": {}
}
```

Response:

```json
{
  "protocol_version": 1,
  "session_id": "sess_...",
  "command_id": "cmd_...",
  "message_id": "msg_...",
  "reply_to": "msg_...",
  "kind": "result",
  "type": "run_shell_result",
  "sent_at": "2026-06-28T10:00:01Z",
  "ok": true,
  "payload": {}
}
```

`message_id` identifies one transport message. `command_id` identifies the semantic command and is stable across retries.

### Persisted Command State Machine

The Durable Object must persist command state before sending anything to the runner. Do not rely on an in-memory pending promise surviving WebSocket hibernation, Worker eviction, or HTTP disconnect.

Command states:

```text
accepted
queued
sent_to_runner
runner_acknowledged
running
succeeded
failed
timed_out
canceled
expired
unknown
```

State rules:

- `POST /commands` validates auth, creates a `command_id`, stores the command row, then attempts delivery.
- The runner sends an ACK after it receives a command but before executing it.
- Short foreground commands may complete within the HTTP deadline, but the result is still written to the command result table first.
- If HTTP disconnects, the command continues only if it already reached `runner_acknowledged`; otherwise it may remain `queued` until expiration.
- The adapter can poll `GET /commands/:command_id` for final result.
- Deadlines are enforced by stored `deadline_at` values and Durable Object alarms.
- Expired commands must not be executed by the runner if delivered late.
- A command with final result can be fetched repeatedly until its retention window expires.

Minimum stored command fields:

```text
session_id
command_id
type
state
created_at
deadline_at
runner_instance_id
request_payload_hash
result_payload
error_code
retryable
updated_at
```

### Durable Object Storage Schema

Use SQLite-backed Durable Object storage.

Tables:

```text
sessions
  session_id
  controller_token_hash
  runner_token_hash
  created_at
  expires_at
  revoked_at
  runner_connected
  runner_instance_id
  kernel_started_at
  last_heartbeat_at

commands
  session_id
  command_id
  type
  state
  request_payload_json
  request_payload_hash
  result_payload_json
  error_json
  deadline_at
  created_at
  updated_at

jobs
  session_id
  job_id
  command_id
  runner_instance_id
  process_group_id
  status
  started_at
  ended_at
  exit_code
  updated_at

job_log_chunks
  session_id
  job_id
  cursor_start
  cursor_end
  stream
  text
  created_at
```

Compaction:

- Retain only the most recent `job_log_ring_buffer` bytes per job.
- When dropping old chunks, insert a `log_dropped` event at the new oldest cursor.
- Retain completed command results for at least 30 minutes or until session expiry, whichever comes first.

### Delivery Semantics

- Treat delivery as at-least-once.
- Include `message_id` and `command_id`.
- Durable Object deduplicates incoming controller requests by `command_id` when the adapter supplies one; otherwise it creates one.
- Runner deduplicates command execution by `command_id` while the runner process lives.
- Background job start commands are not retried automatically unless the previous attempt is known not to have reached the runner.
- Adapter retries only idempotent status/read/tail operations.
- Non-idempotent commands that reach `runner_acknowledged` are never automatically retried.
- If the bridge cannot determine whether the runner received a non-idempotent command, it returns `COMMAND_STATE_UNKNOWN` and requires explicit user decision.

### Connection Semantics

- Runner connects outbound to Cloudflare via WebSocket.
- Controller can use HTTP request/response for most MCP calls; the Worker forwards command messages to the runner socket.
- For MVP, avoid holding long-lived controller WebSockets from the local adapter. The local adapter makes bounded HTTP calls per tool and polls command results when needed.
- Durable Object stores runner connection status, session metadata, command state, and job metadata.
- WebSocket attachments store only small socket metadata needed for hibernation, such as side, session id, and runner instance id.
- Heartbeat interval: 15 seconds.
- Runner considered stale after 45 seconds without heartbeat.
- Runner reconnect with the same `runner_instance_id` is a network reconnect.
- Runner reconnect with a new `runner_instance_id` is a runner restart.
- Missing heartbeat followed by failed status from Colab is treated as runner offline, not proof that the Colab VM was deleted.

## Cloudflare Routes

Routes are examples; exact names can change during implementation.

```text
GET  /health
POST /v1/sessions
GET  /v1/sessions/:session_id/status
POST /v1/sessions/:session_id/commands
GET  /v1/sessions/:session_id/commands/:command_id
GET  /v1/sessions/:session_id/runner/ws
POST /v1/sessions/:session_id/revoke
```

### Auth

Use separate credentials:

```text
controller_token: used by local MCP adapter
runner_token: used by Colab runner
```

Rules:

- `session_id` is not a secret.
- Tokens must not appear in query strings.
- Prefer `Authorization: Bearer ...` headers for HTTP.
- Controller HTTP requests include `Authorization: Bearer ...`, `X-Bridge-Timestamp`, and `X-Bridge-Nonce`.
- Durable Object stores token hashes, rejects stale timestamps, and rejects reused nonces during the session retention window.
- For WebSocket runner auth, use headers from Python if supported by the client library. If not, the first WebSocket message must be a `runner_auth` message carrying the runner token, timestamp, and nonce. The token must not appear in the URL.
- The runner socket is not allowed to receive commands until runner auth succeeds.
- Store only token hashes in Cloudflare where practical.
- Session TTL defaults to 8 hours.
- Revoke route invalidates both controller and runner credentials for that session.
- Every accepted command writes an audit row containing command type, command id, payload hash, caller side, timestamp, and outcome. Do not log raw command payloads by default.
- Apply per-session rate limits to command creation and runner auth attempts.

### Bootstrap Decision For MVP

Session creation is local-first:

1. A local setup command calls `POST /v1/sessions` using a deployment admin secret.
2. The Worker creates `session_id`, `controller_token`, and `runner_token`.
3. The controller token is written to a local config file with user-only permissions.
4. The runner token is displayed once as part of a Colab bootstrap snippet.
5. The Colab runner sends the runner token in headers or the first WebSocket auth message.
6. After runner auth succeeds, Colab output prints only `SESSION_ID`, `BRIDGE_URL`, and connection status.

The deployment admin secret is never used by Codex tools and is only needed for session creation/revocation setup.

## Security Model

### What This Protects

- Prevents unauthenticated parties from controlling a Colab runner.
- Prevents accidental file reads/writes outside the project root for dedicated file tools.
- Prevents unbounded log/file transfer through the bridge.
- Limits damage from stale sessions through expiration/revocation.

### What This Does Not Protect

- Arbitrary shell commands can access Colab environment variables, files, mounted Drive, network, and any credentials available in the runtime.
- Path restrictions on `read_file` and `write_file` do not restrict what `run_shell` can do.
- Redaction can reduce accidental secret leakage in logs, but cannot stop a malicious command from printing or exfiltrating secrets.
- Colab runtime lifetime and GPU availability are controlled by Google.

### Operational Safety Defaults

- Do not mount Google Drive while the bridge is active unless needed.
- Use a low-risk Google account for experiments.
- Keep Hugging Face, Weights & Biases, Google Cloud, and other tokens out of notebook globals unless needed for a specific run.
- Prefer short-lived tokens.
- Print only `SESSION_ID` and bridge status in notebook output by default, not secrets.
- Require explicit user setup for artifact destinations.

## File And Artifact Strategy

The bridge is not the artifact store.

Use the bridge for:

- source files
- config files
- small logs
- status JSON
- short result summaries

Do not use the bridge for:

- model checkpoints
- datasets
- long raw logs
- package caches
- full training artifacts

Artifact destinations:

- GitHub for code
- Google Drive or GCS for Colab-local artifacts
- Hugging Face Hub for model checkpoints
- Cloudflare R2 only if we intentionally add storage support later

## Error Codes

Initial error code set:

```text
RUNNER_OFFLINE
SESSION_EXPIRED
UNAUTHORIZED
FORBIDDEN_PATH
COMMAND_TIMEOUT
OUTPUT_TRUNCATED
JOB_ALREADY_RUNNING
JOB_NOT_FOUND
CURSOR_EXPIRED
RUNNER_RESTARTED
COMMAND_STATE_UNKNOWN
TOOL_DISABLED
REPLAY_DETECTED
RATE_LIMITED
COMMAND_EXPIRED
RUNNER_AUTH_REQUIRED
INVALID_ARGUMENT
INTERNAL_ERROR
```

Each error includes:

```json
{
  "code": "COMMAND_TIMEOUT",
  "message": "Command exceeded 30 second timeout.",
  "retryable": false
}
```

## Implementation Phases

### Phase 0: Repo Skeleton And Protocol Types

Deliverables:

- Monorepo or simple workspace with:
  - `packages/mcp-server`
  - `packages/worker`
  - `packages/colab-runner`
  - `docs`
- Shared protocol schema definitions.
- Local test fixtures for command/result envelopes.
- MCP `CallToolResult` helpers and output schemas.
- Tool annotation definitions.

Acceptance:

- Type/schema tests validate all tool inputs and protocol messages.
- MCP result helpers emit `content[]`, `structuredContent`, and `isError` correctly.
- README explains local development prerequisites without requiring a deployed Worker.

### Phase 1: Authenticated Cloudflare Session Broker

Deliverables:

- Worker route dispatcher.
- Durable Object session instance.
- Session creation and status.
- Runner WebSocket attach/detach.
- Heartbeat tracking.
- Controller and runner token creation.
- Token hashing, timestamp checks, nonce replay rejection.
- Session revoke.
- Per-session rate limits.
- Audit rows for session creation, auth failures, runner attach, command creation, and revoke.
- Persisted command state machine.
- Pollable command result route.

Acceptance:

- Local Miniflare/Wrangler test can create a session and connect a fake runner.
- Invalid controller token cannot read status or create commands.
- Invalid runner token cannot attach.
- Replayed nonce is rejected.
- Revoked session cannot be used by controller or runner.
- Fake controller can send authenticated `ping` command and receive a persisted response.
- `GET /commands/:command_id` can retrieve a final result after the original HTTP request ends.
- Runner stale status is reported after missed heartbeats.

### Phase 2: Fake Runner And MCP Conformance

Deliverables:

- Fake runner process for local integration tests.
- Local STDIO MCP server.
- Static tool definitions.
- Config loading from env or local config file.
- MCP mapping for `colab_status`.
- MCP mapping for a test-only `ping` or status probe.
- Tool disabled policy for dangerous tools.

Acceptance:

- Codex or an MCP inspector can list tools after server configuration.
- MCP tool results conform to MCP `CallToolResult`.
- Dangerous tools return `TOOL_DISABLED` unless local config enables them.
- Local MCP adapter -> local Worker -> fake runner works for authenticated status/ping.
- Tool failures return structured errors, not raw stack traces.

### Phase 3: Colab Runner Status/GPU MVP

Deliverables:

- Python runner module usable from a Colab cell.
- Outbound WebSocket connection.
- Runner auth.
- `runner_instance_id` and `kernel_started_at`.
- `status` and `gpu_status`.

Acceptance:

- In Colab, runner connects and responds to status.
- `nvidia-smi` can be invoked through `gpu_status`.
- Runner reconnect with same instance is reported distinctly from runner restart.
- Invalid runner bootstrap token fails closed.

### Phase 4: Short Foreground Execution

Deliverables:

- `colab_run_shell`.
- `colab_run_python`.
- Output caps and timeouts.
- Foreground command state transitions.
- Local enablement/approval guidance for RCE tools.

Acceptance:

- `colab_run_shell` and `colab_run_python` are disabled by default.
- When enabled, a short Python command returns stdout/stderr/exit code.
- Command timeout is enforced locally and in the runner.
- HTTP disconnect while command runs still leaves a pollable command result or terminal error state.
- Duplicate `command_id` does not execute twice.

### Phase 5: File Tools

Deliverables:

- `write_file` and `read_file`.
- Canonical path validation.
- Size caps.
- Text encoding handling.

Acceptance:

- Relative file read/write works under `/content/project`.
- Absolute paths, `..`, and symlink escapes are rejected.
- Existing symlink targets are rejected.
- Overwrites are atomic temp-write-and-rename operations.
- Large file attempts are rejected or truncated according to tool semantics.

### Phase 6: Background Jobs

Deliverables:

- `start_job`, `tail_job`, `interrupt_job`.
- One active job per session.
- Process group handling.
- Merged event-stream logs with cursor.
- SQLite-backed chunked log storage.
- Ring-buffer compaction and `log_dropped` markers.
- Job status persistence in Durable Object storage.

Acceptance:

- Start a two-minute dummy training loop.
- Tail logs incrementally by cursor.
- Interrupt terminates child processes.
- Reconnect runner and observe sane status.
- Runner crash mid-job marks job `unknown` or `unknown_lost` instead of `running`.
- Log bursts are capped and produce dropped-log markers under pressure.
- If Colab runtime restarts, status reports `RUNNER_RESTARTED` or equivalent instead of lying about job survival.

### Phase 7: Hardening And Operational Packaging

Deliverables:

- Redaction of known configured secrets in logs.
- Deployed Cloudflare hibernation tests.
- Real Colab idle/reconnect/runtime-reset tests.
- Packaging scripts for local MCP config.
- Documentation for safe Colab account/Drive/token usage.

Acceptance:

- Logs do not include configured token values in ordinary failures.
- Deployed Worker behaves correctly after hibernation.
- Reconnect test passes after temporarily stopping the runner WebSocket.
- User can install/remove the MCP adapter without manual config surgery.

## Testing Strategy

### Unit Tests

- Protocol schema validation.
- MCP tool argument validation.
- MCP `CallToolResult` shape and `outputSchema` conformance.
- Tool annotation snapshots.
- Cloudflare route auth.
- Timestamp and nonce replay rejection.
- Durable Object state transitions.
- Command state machine transitions.
- Path canonicalization and symlink escape rejection.
- Runner command timeout behavior.
- Log ring buffer cursor behavior.
- UTF-8 log chunk boundary preservation.

### Integration Tests Without Colab

- Fake runner WebSocket process.
- Local MCP adapter -> local Worker -> fake runner.
- Real MCP client or MCP inspector conformance.
- Simulated runner disconnect/reconnect.
- Simulated Worker hibernation by reconstructing Durable Object state where possible.
- Duplicate command delivery and late result delivery.
- Runner crash mid-command.
- HTTP disconnect while command runs.
- Unauthorized controller and runner attempts.
- Log burst/backpressure behavior.
- Session revoke while runner is connected.

### Deployed Cloudflare Tests

- Worker deployment smoke test.
- WebSocket hibernation wakeup with runner still attached.
- Durable Object alarm expiry for stale commands.
- Rate-limit behavior.
- Storage compaction behavior for log chunks.

### Real Colab Smoke Tests

1. Start runner in Colab.
2. `colab_status`.
3. `colab_gpu_status`.
4. `colab_write_file("hello.py", ...)`.
5. `colab_run_shell("python hello.py")`.
6. `colab_start_job("python dummy_train.py")`.
7. `colab_tail_job`.
8. `colab_interrupt_job`.
9. Runtime reconnect test.
10. Runner cell restart test.
11. Idle/runtime reset observation test when practical.

## MVP Defaults

```text
project_root: /content/project
session_ttl: 8 hours
command_result_retention: 30 minutes or session expiry
auth_timestamp_skew: 5 minutes
nonce_retention: session lifetime
foreground_timeout_default: 30 seconds
foreground_timeout_max: 120 seconds
foreground_output_max: 20 KiB
file_max: 1 MiB
job_log_ring_buffer: 200 KiB
heartbeat_interval: 15 seconds
runner_stale_after: 45 seconds
active_jobs: 1
dangerous_tools_enabled_by_default: false
```

## MVP Decisions

1. Session creation is done locally through a setup command, not from Colab.
2. Cloudflare stores token hashes for controller and runner tokens.
3. Controller uses HTTP request/response plus polling, not a controller WebSocket.
4. `run_shell`, `run_python`, `write_file`, `start_job`, and `interrupt_job` are disabled by default in local config.
5. One session has one runner and at most one active background job.
6. The bridge is not an artifact store.

## Open Decisions

1. Which external artifact stores to document for large datasets, checkpoints, and training outputs.
2. Whether to package the local MCP adapter as a Codex plugin later.
3. Whether to add a controller WebSocket after the polling flow is reliable.
4. Whether to add large artifact transfer through R2 after the MVP.
5. Whether to support multiple active jobs after the single-job model is stable.

## Recommended First Build Slice

Build the narrowest end-to-end vertical slice:

```text
local MCP colab_status with controller auth
  -> Worker command route with persisted command state
  -> Durable Object session
  -> authenticated fake runner
  -> response back to Codex
```

Then replace the fake runner with the Colab runner and add authenticated `gpu_status`. Only after auth, persisted command state, MCP result conformance, and runner reconnect semantics are proven should `run_shell`, file tools, and background jobs be added.

This keeps the first proof focused on the hard architectural question: can Codex reliably reach a Colab runtime through an outbound Colab WebSocket and a local MCP adapter?
