import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  createCommandEnvelope,
  createResultEnvelope,
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

test("payload hashes are stable regardless of object key order", () => {
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
});
