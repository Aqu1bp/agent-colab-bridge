import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  MAX_FILE_CONTENT_BYTES,
  MAX_READ_FILE_BYTES,
  createCommandEnvelope,
  createResultEnvelope,
  normalizeForegroundRunPayload,
  normalizeReadFilePayload,
  normalizeWriteFilePayload,
  payloadHash,
} from "../src/protocol.js";

test("protocol helpers create command and result envelopes", () => {
  const command = createCommandEnvelope({
    sessionId: "sess_1",
    commandId: "cmd_1",
    type: "ping",
    payload: { value: true },
    deadlineAt: "2026-06-28T10:00:30.000Z",
    sentAt: "2026-06-28T10:00:00.000Z",
  });

  assert.equal(command.protocol_version, PROTOCOL_VERSION);
  assert.equal(command.kind, "command");
  assert.equal(command.type, "ping");
  assert.equal(command.session_id, "sess_1");
  assert.equal(command.command_id, "cmd_1");

  const result = createResultEnvelope({
    command,
    ok: true,
    payload: { pong: true },
    sentAt: "2026-06-28T10:00:01.000Z",
  });

  assert.equal(result.kind, "result");
  assert.equal(result.type, "ping_result");
  assert.equal(result.reply_to, command.message_id);
  assert.deepEqual(result.payload, { pong: true });
});

test("protocol helpers support gpu_status command envelopes", () => {
  const command = createCommandEnvelope({
    sessionId: "sess_1",
    commandId: "cmd_gpu",
    type: "gpu_status",
    payload: {},
    deadlineAt: "2026-06-28T10:00:30.000Z",
    sentAt: "2026-06-28T10:00:00.000Z",
  });

  const result = createResultEnvelope({
    command,
    ok: true,
    payload: { available: false, source: "none", gpus: [], raw: "" },
    sentAt: "2026-06-28T10:00:01.000Z",
  });

  assert.equal(command.type, "gpu_status");
  assert.equal(result.type, "gpu_status_result");
});

test("protocol helpers support run_shell and run_python command envelopes", () => {
  const shell = createCommandEnvelope({
    sessionId: "sess_1",
    commandId: "cmd_shell",
    type: "run_shell",
    payload: { command: "echo hi", timeout_sec: 30, max_output_bytes: 1024 },
    deadlineAt: "2026-06-28T10:00:30.000Z",
    sentAt: "2026-06-28T10:00:00.000Z",
  });
  const python = createCommandEnvelope({
    sessionId: "sess_1",
    commandId: "cmd_python",
    type: "run_python",
    payload: { code: "print('hi')", timeout_sec: 30, max_output_bytes: 1024 },
    deadlineAt: "2026-06-28T10:00:30.000Z",
    sentAt: "2026-06-28T10:00:00.000Z",
  });

  assert.equal(createResultEnvelope({ command: shell, ok: true, payload: {} }).type, "run_shell_result");
  assert.equal(createResultEnvelope({ command: python, ok: true, payload: {} }).type, "run_python_result");
});

test("protocol helpers support write_file and read_file command envelopes", () => {
  const write = createCommandEnvelope({
    sessionId: "sess_1",
    commandId: "cmd_write",
    type: "write_file",
    payload: { path: "src/train.py", content: "print(1)", mode: "overwrite" },
    deadlineAt: "2026-06-28T10:00:30.000Z",
    sentAt: "2026-06-28T10:00:00.000Z",
  });
  const read = createCommandEnvelope({
    sessionId: "sess_1",
    commandId: "cmd_read",
    type: "read_file",
    payload: { path: "src/train.py", max_bytes: 1024 },
    deadlineAt: "2026-06-28T10:00:30.000Z",
    sentAt: "2026-06-28T10:00:00.000Z",
  });

  assert.equal(createResultEnvelope({ command: write, ok: true, payload: {} }).type, "write_file_result");
  assert.equal(createResultEnvelope({ command: read, ok: true, payload: {} }).type, "read_file_result");
});

test("foreground command payload validation applies defaults and caps", () => {
  assert.deepEqual(normalizeForegroundRunPayload("run_shell", { command: "pwd" }), {
    command: "pwd",
    timeout_sec: 30,
    max_output_bytes: 20 * 1024,
  });
  assert.deepEqual(normalizeForegroundRunPayload("run_python", { code: "print(1)" }), {
    code: "print(1)",
    timeout_sec: 30,
    max_output_bytes: 20 * 1024,
  });

  assert.throws(() =>
    normalizeForegroundRunPayload("run_shell", {
      command: "sleep 999",
      timeout_sec: 121,
    }),
  );
  assert.throws(() =>
    normalizeForegroundRunPayload("run_python", {
      code: "print('too much')",
      max_output_bytes: 20 * 1024 + 1,
    }),
  );
});

test("file command payload validation applies defaults and caps", () => {
  assert.deepEqual(
    normalizeWriteFilePayload({ path: "notes.txt", content: "hello", mode: "append" }),
    {
      path: "notes.txt",
      content: "hello",
      mode: "append",
    },
  );
  assert.deepEqual(normalizeReadFilePayload({ path: "notes.txt" }), {
    path: "notes.txt",
    max_bytes: 20 * 1024,
  });

  assert.throws(() =>
    normalizeWriteFilePayload({
      path: "large.txt",
      content: "a".repeat(MAX_FILE_CONTENT_BYTES + 1),
      mode: "overwrite",
    }),
  );
  assert.throws(() =>
    normalizeReadFilePayload({
      path: "large.txt",
      max_bytes: MAX_READ_FILE_BYTES + 1,
    }),
  );
  assert.throws(() =>
    normalizeWriteFilePayload({
      path: "notes.txt",
      content: "hello",
      mode: "invalid",
    }),
  );
});

test("payload hashes are stable regardless of object key order", () => {
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
});
