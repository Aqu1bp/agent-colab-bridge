import test from "node:test";
import assert from "node:assert/strict";
import { SessionBroker } from "../src/broker.js";
import {
  attachFakeRunnerForTest,
  createBridgeHttpHandler,
  type BridgeHttpHandler,
} from "../src/http.js";

const baseUrl = "https://bridge.test";
const adminSecret = "admin_secret_for_tests";

interface Envelope<TData = unknown> {
  ok: boolean;
  data: TData | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

interface CreatedSession {
  session_id: string;
  controller_token: string;
  runner_token: string;
  expires_at: string;
}

interface CommandData {
  session_id: string;
  command_id: string;
  type: string;
  state: string;
  result_payload: unknown | null;
  error: { code: string; message: string; retryable: boolean } | null;
  state_history: string[];
}

function createHarness(): { broker: SessionBroker; handler: BridgeHttpHandler } {
  const broker = new SessionBroker();
  const handler = createBridgeHttpHandler({ broker, adminSecret });
  return { broker, handler };
}

async function readEnvelope<TData>(response: Response): Promise<Envelope<TData>> {
  return (await response.json()) as Envelope<TData>;
}

async function createSession(handler: BridgeHttpHandler): Promise<CreatedSession> {
  const response = await handler(
    new Request(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminSecret}` },
    }),
  );
  const envelope = await readEnvelope<CreatedSession>(response);
  assert.equal(response.status, 201);
  assert.equal(envelope.ok, true);
  assert.ok(envelope.data);
  return envelope.data;
}

function controllerHeaders(token: string, nonce: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "X-Bridge-Timestamp": new Date().toISOString(),
    "X-Bridge-Nonce": nonce,
  };
}

test("GET /health returns ok envelope", async () => {
  const { handler } = createHarness();

  const response = await handler(new Request(`${baseUrl}/health`));
  const envelope = await readEnvelope<{ status: string }>(response);

  assert.equal(response.status, 200);
  assert.deepEqual(envelope, {
    ok: true,
    data: { status: "ok" },
    error: null,
  });
});

test("POST /v1/sessions requires admin secret and returns tokens only there", async () => {
  const { handler } = createHarness();

  const unauthorized = await handler(new Request(`${baseUrl}/v1/sessions`, { method: "POST" }));
  const unauthorizedEnvelope = await readEnvelope(unauthorized);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorizedEnvelope.ok, false);
  assert.equal(unauthorizedEnvelope.error?.code, "UNAUTHORIZED");

  const invalid = await handler(
    new Request(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    }),
  );
  const invalidEnvelope = await readEnvelope(invalid);
  assert.equal(invalid.status, 401);
  assert.equal(invalidEnvelope.error?.code, "UNAUTHORIZED");

  const session = await createSession(handler);
  assert.equal(session.session_id.startsWith("sess_"), true);
  assert.equal(session.controller_token.startsWith("br_"), true);
  assert.equal(session.runner_token.startsWith("br_"), true);
  assert.equal(typeof session.expires_at, "string");
});

test("controller routes reject missing auth with structured JSON", async () => {
  const { handler } = createHarness();
  const session = await createSession(handler);

  const response = await handler(new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`));
  const envelope = await readEnvelope(response);

  assert.equal(response.status, 401);
  assert.deepEqual(envelope, {
    ok: false,
    data: null,
    error: {
      code: "UNAUTHORIZED",
      message: "Missing bearer authorization.",
      retryable: false,
    },
  });
});

test("status route reports session and fake runner state", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
    options: { runnerInstanceId: "runner_http_status" },
  });

  const response = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "status_1"),
    }),
  );
  const envelope = await readEnvelope<{ runner_connected: boolean; runner_instance_id: string }>(
    response,
  );

  assert.equal(response.status, 200);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.runner_connected, true);
  assert.equal(envelope.data?.runner_instance_id, "runner_http_status");
});

test("nonce replay is rejected through HTTP", async () => {
  const { handler } = createHarness();
  const session = await createSession(handler);
  const request = () =>
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "same_nonce"),
    });

  const first = await handler(request());
  const second = await handler(request());
  const envelope = await readEnvelope(second);

  assert.equal(first.status, 200);
  assert.equal(second.status, 401);
  assert.equal(envelope.error?.code, "REPLAY_DETECTED");
});

test("commands route validates JSON and supports ping/status only", async () => {
  const { handler } = createHarness();
  const session = await createSession(handler);

  const unauthenticatedInvalidJson = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      body: "{",
    }),
  );
  const unauthenticatedInvalidJsonEnvelope = await readEnvelope(unauthenticatedInvalidJson);
  assert.equal(unauthenticatedInvalidJson.status, 401);
  assert.equal(unauthenticatedInvalidJsonEnvelope.error?.code, "UNAUTHORIZED");

  const invalidJson = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: controllerHeaders(session.controller_token, "bad_json"),
      body: "{",
    }),
  );
  const invalidJsonEnvelope = await readEnvelope(invalidJson);
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJsonEnvelope.error?.code, "INVALID_ARGUMENT");

  const unsupported = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "unsupported_type"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "colab_run_shell", payload: { command: "echo no" } }),
    }),
  );
  const unsupportedEnvelope = await readEnvelope(unsupported);
  assert.equal(unsupported.status, 400);
  assert.equal(unsupportedEnvelope.error?.code, "INVALID_ARGUMENT");
});

test("command result can be polled after original command response", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
  });

  const created = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "create_ping"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "ping", command_id: "cmd_http_poll" }),
    }),
  );
  const createdEnvelope = await readEnvelope<CommandData>(created);
  assert.equal(created.status, 201);
  assert.equal(createdEnvelope.data?.state, "succeeded");

  const polled = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands/cmd_http_poll`, {
      headers: controllerHeaders(session.controller_token, "poll_ping"),
    }),
  );
  const polledEnvelope = await readEnvelope<CommandData>(polled);

  assert.equal(polled.status, 200);
  assert.equal(polledEnvelope.data?.command_id, "cmd_http_poll");
  assert.deepEqual(polledEnvelope.data?.result_payload, { ok: true, pong: true });
  assert.deepEqual(polledEnvelope.data?.state_history, [
    "accepted",
    "queued",
    "sent_to_runner",
    "runner_acknowledged",
    "running",
    "succeeded",
  ]);
});

test("status command type is accepted through command route", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
    options: { runnerInstanceId: "runner_status_command" },
  });

  const response = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "create_status_command"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "status" }),
    }),
  );
  const envelope = await readEnvelope<CommandData>(response);

  assert.equal(response.status, 201);
  assert.equal(envelope.data?.state, "succeeded");
  assert.deepEqual(envelope.data?.result_payload, {
    session_id: session.session_id,
    runner_connected: true,
    runner_instance_id: "runner_status_command",
    kernel_started_at: "2026-06-28T10:00:00.000Z",
    runner_started_at: "2026-06-28T10:00:01.000Z",
  });
});

test("unknown command result returns 404", async () => {
  const { handler } = createHarness();
  const session = await createSession(handler);

  const response = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands/missing_command`, {
      headers: controllerHeaders(session.controller_token, "missing_command"),
    }),
  );
  const envelope = await readEnvelope(response);

  assert.equal(response.status, 404);
  assert.equal(envelope.error?.code, "INVALID_ARGUMENT");
});

test("duplicate command id with different payload returns conflict", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
  });

  const first = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dup_1"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "ping", payload: { value: 1 }, command_id: "cmd_dup" }),
    }),
  );
  assert.equal(first.status, 201);

  const second = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dup_2"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "ping", payload: { value: 2 }, command_id: "cmd_dup" }),
    }),
  );
  const envelope = await readEnvelope(second);

  assert.equal(second.status, 409);
  assert.equal(envelope.error?.code, "INVALID_ARGUMENT");
});

test("revoke route disables later controller and fake runner use", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
  });

  const revoked = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/revoke`, {
      method: "POST",
      headers: controllerHeaders(session.controller_token, "revoke"),
    }),
  );
  const revokedEnvelope = await readEnvelope<{ revoked: boolean }>(revoked);
  assert.equal(revoked.status, 200);
  assert.equal(revokedEnvelope.data?.revoked, true);

  const status = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "after_revoke"),
    }),
  );
  const statusEnvelope = await readEnvelope(status);
  assert.equal(status.status, 409);
  assert.equal(statusEnvelope.error?.code, "UNAUTHORIZED");

  assert.throws(
    () =>
      attachFakeRunnerForTest({
        broker,
        sessionId: session.session_id,
        runnerToken: session.runner_token,
      }),
    /Session has been revoked/,
  );
});

test("unknown routes return 404 JSON envelope", async () => {
  const { handler } = createHarness();

  const response = await handler(new Request(`${baseUrl}/v1/unknown`));
  const envelope = await readEnvelope(response);

  assert.equal(response.status, 404);
  assert.deepEqual(envelope, {
    ok: false,
    data: null,
    error: {
      code: "INVALID_ARGUMENT",
      message: "Unknown route.",
      retryable: false,
    },
  });
});
