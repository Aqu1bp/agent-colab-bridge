import test from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "../src/auth.js";
import { attachFakeRunnerForTest } from "../src/http.js";
import { InMemoryRunnerTransport } from "../src/runner-connection.js";
import worker, {
  ColabBridgeSessionDurableObject,
  createWorkerFetchHandler,
  getWorkerBrokerForTest,
  type BridgeWorkerEnv,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStorageLike,
  type DurableObjectStubLike,
  type DurableObjectStateLike,
  type WorkerWebSocketLike,
} from "../src/worker.js";

const baseUrl = "https://worker.test";
const adminSecret = "worker_admin_secret_for_tests";

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

async function fetchWorker(env: BridgeWorkerEnv, request: Request): Promise<Response> {
  return worker.fetch(request, env);
}

async function readEnvelope<TData>(response: Response): Promise<Envelope<TData>> {
  return (await response.json()) as Envelope<TData>;
}

async function createSession(env: BridgeWorkerEnv): Promise<CreatedSession> {
  const response = await fetchWorker(
    env,
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

function runnerHeaders(
  token: string,
  nonce: string,
  options: {
    runnerInstanceId?: string;
    kernelStartedAt?: string;
    runnerStartedAt?: string;
  } = {},
): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "X-Bridge-Timestamp": new Date().toISOString(),
    "X-Bridge-Nonce": nonce,
    "X-Bridge-Runner-Instance-Id": options.runnerInstanceId ?? "runner_worker_attach",
    "X-Bridge-Kernel-Started-At":
      options.kernelStartedAt ?? "2026-06-28T10:00:00.000Z",
    "X-Bridge-Runner-Started-At":
      options.runnerStartedAt ?? "2026-06-28T10:00:01.000Z",
  };
}

class MemoryDurableObjectStorage implements DurableObjectStorageLike {
  readonly values = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.values.delete(item);
    }
  }
}

class MemoryDurableObjectState implements DurableObjectStateLike {
  readonly sockets: TestWebSocket[] = [];
  owner?: ColabBridgeSessionDurableObject;

  constructor(readonly storage: DurableObjectStorageLike) {}

  acceptWebSocket(socket: WorkerWebSocketLike): void {
    const testSocket = socket as TestWebSocket;
    this.sockets.push(testSocket);
    testSocket.addEventListener("message", (event) => {
      void this.owner?.webSocketMessage(testSocket, event.data);
    });
    testSocket.addEventListener("close", () => {
      void this.owner?.webSocketClose(testSocket);
    });
  }

  getWebSockets(): WorkerWebSocketLike[] {
    return this.sockets;
  }
}

class TestWebSocket implements WorkerWebSocketLike {
  peer?: TestWebSocket;
  accepted = false;
  closed = false;
  private attachment: unknown;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  send(message: string): void {
    this.peer?.dispatch("message", { data: message });
  }

  close(): void {
    this.closed = true;
    this.peer?.dispatch("close", { data: "" });
  }

  accept(): void {
    this.accepted = true;
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = structuredClone(attachment);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  private dispatch(type: string, event: { data: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class TestWebSocketPair {
  static lastPair: { client: TestWebSocket; server: TestWebSocket } | null = null;

  constructor() {
    const client = new TestWebSocket();
    const server = new TestWebSocket();
    client.peer = server;
    server.peer = client;
    TestWebSocketPair.lastPair = { client, server };
    return { 0: client, 1: server };
  }
}

class MemoryDurableObjectNamespace implements DurableObjectNamespaceLike {
  readonly requestedNames: string[] = [];
  private readonly storages = new Map<string, MemoryDurableObjectStorage>();

  constructor(private readonly adminSecret: string) {}

  idFromName(name: string): DurableObjectIdLike {
    this.requestedNames.push(name);
    return { name };
  }

  get(id: DurableObjectIdLike): DurableObjectStubLike {
    const name = (id as { name: string }).name;
    let storage = this.storages.get(name);
    if (!storage) {
      storage = new MemoryDurableObjectStorage();
      this.storages.set(name, storage);
    }

    return {
      fetch: (request) =>
        new ColabBridgeSessionDurableObject(
          { storage },
          { ADMIN_SECRET: this.adminSecret },
        ).fetch(request),
    };
  }
}

test("Worker GET /health returns ok without admin config", async () => {
  const response = await fetchWorker({}, new Request(`${baseUrl}/health`));
  const envelope = await readEnvelope<{ status: string }>(response);

  assert.equal(response.status, 200);
  assert.deepEqual(envelope, {
    ok: true,
    data: { status: "ok" },
    error: null,
  });
});

test("Worker fails closed when ADMIN_SECRET is missing", async () => {
  const response = await fetchWorker(
    {},
    new Request(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: "Bearer anything" },
    }),
  );
  const envelope = await readEnvelope(response);

  assert.equal(response.status, 500);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "INTERNAL_ERROR");
  assert.match(envelope.error?.message ?? "", /ADMIN_SECRET/);
});

test("Worker POST /v1/sessions requires admin bearer secret", async () => {
  const env = { ADMIN_SECRET: adminSecret };

  const missing = await fetchWorker(env, new Request(`${baseUrl}/v1/sessions`, { method: "POST" }));
  const missingEnvelope = await readEnvelope(missing);
  assert.equal(missing.status, 401);
  assert.equal(missingEnvelope.error?.code, "UNAUTHORIZED");

  const wrong = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    }),
  );
  const wrongEnvelope = await readEnvelope(wrong);
  assert.equal(wrong.status, 401);
  assert.equal(wrongEnvelope.error?.code, "UNAUTHORIZED");

  const session = await createSession(env);
  assert.equal(session.session_id.startsWith("sess_"), true);
  assert.equal(session.controller_token.startsWith("br_"), true);
  assert.equal(session.runner_token.startsWith("br_"), true);
});

test("Worker supports status, command create, command poll, and revoke", async () => {
  const env = { ADMIN_SECRET: adminSecret };
  const session = await createSession(env);
  const broker = getWorkerBrokerForTest(env);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
    options: { runnerInstanceId: "runner_worker_status" },
  });

  const status = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "worker_status"),
    }),
  );
  const statusEnvelope = await readEnvelope<{ runner_connected: boolean; runner_instance_id: string }>(
    status,
  );
  assert.equal(status.status, 200);
  assert.equal(statusEnvelope.data?.runner_connected, true);
  assert.equal(statusEnvelope.data?.runner_instance_id, "runner_worker_status");

  const created = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "worker_ping"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "ping", command_id: "cmd_worker_ping" }),
    }),
  );
  const createdEnvelope = await readEnvelope<CommandData>(created);
  assert.equal(created.status, 201);
  assert.equal(createdEnvelope.data?.state, "succeeded");
  assert.deepEqual(createdEnvelope.data?.result_payload, { ok: true, pong: true });

  const polled = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands/cmd_worker_ping`, {
      headers: controllerHeaders(session.controller_token, "worker_poll"),
    }),
  );
  const polledEnvelope = await readEnvelope<CommandData>(polled);
  assert.equal(polled.status, 200);
  assert.equal(polledEnvelope.data?.command_id, "cmd_worker_ping");
  assert.deepEqual(polledEnvelope.data?.state_history, [
    "accepted",
    "queued",
    "sent_to_runner",
    "runner_acknowledged",
    "running",
    "succeeded",
  ]);

  const nonCreateResponseText = JSON.stringify([
    statusEnvelope,
    createdEnvelope,
    polledEnvelope,
  ]);
  assert.equal(nonCreateResponseText.includes(session.controller_token), false);
  assert.equal(nonCreateResponseText.includes(session.runner_token), false);

  const revoked = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/revoke`, {
      method: "POST",
      headers: controllerHeaders(session.controller_token, "worker_revoke"),
    }),
  );
  const revokedEnvelope = await readEnvelope<{ revoked: boolean }>(revoked);
  assert.equal(revoked.status, 200);
  assert.equal(revokedEnvelope.data?.revoked, true);

  const afterRevoke = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "worker_after_revoke"),
    }),
  );
  const afterRevokeEnvelope = await readEnvelope(afterRevoke);
  assert.equal(afterRevoke.status, 409);
  assert.equal(afterRevokeEnvelope.error?.code, "UNAUTHORIZED");
});

test("Worker Durable Object binding routes each session to its own object", async () => {
  const namespace = new MemoryDurableObjectNamespace(adminSecret);
  const env = { ADMIN_SECRET: adminSecret, COLAB_BRIDGE_SESSIONS: namespace };
  const first = await createSession(env);
  const second = await createSession(env);

  assert.notEqual(first.session_id, second.session_id);
  assert.equal(namespace.requestedNames.includes(first.session_id), true);
  assert.equal(namespace.requestedNames.includes(second.session_id), true);

  const firstStatus = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${first.session_id}/status`, {
      headers: controllerHeaders(first.controller_token, "first_do_status"),
    }),
  );
  const firstStatusEnvelope = await readEnvelope<{ runner_connected: boolean }>(firstStatus);
  assert.equal(firstStatus.status, 200);
  assert.equal(firstStatusEnvelope.data?.runner_connected, false);
  assert.equal(namespace.requestedNames.at(-1), first.session_id);

  const secondStatus = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${second.session_id}/status`, {
      headers: controllerHeaders(second.controller_token, "second_do_status"),
    }),
  );
  assert.equal(secondStatus.status, 200);
  assert.equal(namespace.requestedNames.at(-1), second.session_id);
});

test("Worker Durable Object binding persists nonce replay state", async () => {
  const namespace = new MemoryDurableObjectNamespace(adminSecret);
  const env = { ADMIN_SECRET: adminSecret, COLAB_BRIDGE_SESSIONS: namespace };
  const session = await createSession(env);

  const first = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "persisted_do_nonce"),
    }),
  );
  assert.equal(first.status, 200);

  const replay = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "persisted_do_nonce"),
    }),
  );
  const replayEnvelope = await readEnvelope(replay);
  assert.equal(replay.status, 401);
  assert.equal(replayEnvelope.error?.code, "REPLAY_DETECTED");
});

test("Worker command route disables dangerous command types by default", async () => {
  const env = { ADMIN_SECRET: adminSecret };
  const session = await createSession(env);

  const shellDisabled = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "worker_unsafe_command"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "run_shell", payload: { command: "echo no" } }),
    }),
  );
  const shellEnvelope = await readEnvelope(shellDisabled);

  assert.equal(shellDisabled.status, 403);
  assert.equal(shellEnvelope.error?.code, "TOOL_DISABLED");

  const writeDisabled = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "worker_write_disabled"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "write_file",
        payload: { path: "blocked.txt", content: "no", mode: "overwrite" },
      }),
    }),
  );
  const writeEnvelope = await readEnvelope(writeDisabled);

  assert.equal(writeDisabled.status, 403);
  assert.equal(writeEnvelope.error?.code, "TOOL_DISABLED");
});

test("Worker runner/ws route requires runner auth and authenticated attach updates status", async () => {
  const env = { ADMIN_SECRET: adminSecret };
  const session = await createSession(env);

  const unauthenticated = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/runner/ws`, {
      headers: {
        "X-Bridge-Runner-Instance-Id": "runner_unauthenticated",
        "X-Bridge-Kernel-Started-At": "2026-06-28T10:00:00.000Z",
      },
    }),
  );
  const unauthenticatedEnvelope = await readEnvelope(unauthenticated);

  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticatedEnvelope.error?.code, "UNAUTHORIZED");

  const broker = getWorkerBrokerForTest(env);
  const handler = createWorkerFetchHandler(env, {
    broker,
    runnerTransportFactory: () =>
      new InMemoryRunnerTransport(() => {
        throw new Error("not used by this attach test");
      }),
  });

  const attached = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/runner/ws`, {
      headers: runnerHeaders(session.runner_token, "worker_runner_attach", {
        runnerInstanceId: "runner_worker_ws",
      }),
    }),
  );
  const attachedEnvelope = await readEnvelope<{
    runner_connected: boolean;
    runner_instance_id: string;
  }>(attached);

  assert.equal(attached.status, 200);
  assert.equal(attachedEnvelope.data?.runner_connected, true);
  assert.equal(attachedEnvelope.data?.runner_instance_id, "runner_worker_ws");

  const status = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/status`, {
      headers: controllerHeaders(session.controller_token, "worker_runner_attached_status"),
    }),
  );
  const statusEnvelope = await readEnvelope<{
    runner_connected: boolean;
    runner_instance_id: string;
    kernel_started_at: string;
    runner_started_at: string;
    last_heartbeat_at: string;
  }>(status);

  assert.equal(status.status, 200);
  assert.equal(statusEnvelope.data?.runner_connected, true);
  assert.equal(statusEnvelope.data?.runner_instance_id, "runner_worker_ws");
  assert.equal(statusEnvelope.data?.kernel_started_at, "2026-06-28T10:00:00.000Z");
  assert.equal(statusEnvelope.data?.runner_started_at, "2026-06-28T10:00:01.000Z");
  assert.equal(typeof statusEnvelope.data?.last_heartbeat_at, "string");

  const replay = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/runner/ws`, {
      headers: runnerHeaders(session.runner_token, "worker_runner_attach", {
        runnerInstanceId: "runner_worker_ws",
      }),
    }),
  );
  const replayEnvelope = await readEnvelope(replay);
  assert.equal(replay.status, 401);
  assert.equal(replayEnvelope.error?.code, "REPLAY_DETECTED");
});

test("Durable Object runner WebSocket forwards commands and resolves results after restore", async () => {
  const previousWebSocketPair = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = TestWebSocketPair;
  try {
    const storage = new MemoryDurableObjectStorage();
    const state = new MemoryDurableObjectState(storage);
    const env = { ADMIN_SECRET: adminSecret };
    let durableObject = new ColabBridgeSessionDurableObject(state, env);
    state.owner = durableObject;

    const created = await durableObject.fetch(
      new Request(`${baseUrl}/v1/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminSecret}` },
      }),
    );
    const session = (await readEnvelope<CreatedSession>(created)).data;
    assert.ok(session);

    const attached = await durableObject.fetch(
      new Request(`${baseUrl}/v1/sessions/${session.session_id}/runner/ws`, {
        headers: {
          ...runnerHeaders(session.runner_token, "do_runner_ws", {
            runnerInstanceId: "runner_do_ws",
          }),
          Upgrade: "websocket",
        },
      }),
    );

    assert.equal(attached.headers.get("x-colab-bridge-test-websocket"), "accepted");
    assert.equal(state.sockets.length, 1);
    assert.deepEqual(state.sockets[0]?.deserializeAttachment(), {
      side: "runner",
      sessionId: session.session_id,
      runnerInstanceId: "runner_do_ws",
      kernelStartedAt: "2026-06-28T10:00:00.000Z",
      runnerStartedAt: "2026-06-28T10:00:01.000Z",
    });

    durableObject = new ColabBridgeSessionDurableObject(state, env);
    state.owner = durableObject;
    const pair = TestWebSocketPair.lastPair;
    assert.ok(pair);
    pair.client.addEventListener("message", (event) => {
      const command = JSON.parse(event.data) as {
        session_id: string;
        command_id: string;
        message_id: string;
        type: string;
      };
      pair.client.send(
        JSON.stringify({
          protocol_version: 1,
          session_id: command.session_id,
          command_id: command.command_id,
          message_id: "msg_result",
          reply_to: command.message_id,
          kind: "result",
          type: `${command.type}_result`,
          sent_at: new Date().toISOString(),
          ok: true,
          payload: { ok: true, pong: true },
        }),
      );
    });

    const commandResponse = await durableObject.fetch(
      new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
        method: "POST",
        headers: {
          ...controllerHeaders(session.controller_token, "do_runner_ws_ping"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "ping" }),
      }),
    );
    const commandEnvelope = await readEnvelope<CommandData>(commandResponse);

    assert.equal(commandResponse.status, 201);
    assert.equal(commandEnvelope.data?.state, "succeeded");
    assert.deepEqual(commandEnvelope.data?.result_payload, { ok: true, pong: true });

    durableObject = new ColabBridgeSessionDurableObject(state, env);
    state.owner = durableObject;
    const polledAfterReconstruction = await durableObject.fetch(
      new Request(
        `${baseUrl}/v1/sessions/${session.session_id}/commands/${commandEnvelope.data?.command_id}`,
        {
          headers: controllerHeaders(session.controller_token, "do_runner_ws_poll_after_reconstruct"),
        },
      ),
    );
    const pollEnvelope = await readEnvelope<CommandData>(polledAfterReconstruction);

    assert.equal(polledAfterReconstruction.status, 200);
    assert.equal(pollEnvelope.data?.state, "succeeded");
    assert.deepEqual(pollEnvelope.data?.result_payload, { ok: true, pong: true });
    assert.equal(
      [...storage.values.keys()].some((key) => key.startsWith("colab_mcp_bridge_row_v1:command:")),
      true,
    );
  } finally {
    if (previousWebSocketPair === undefined) {
      delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    } else {
      (globalThis as { WebSocketPair?: unknown }).WebSocketPair = previousWebSocketPair;
    }
    TestWebSocketPair.lastPair = null;
  }
});

test("Durable Object shape persists session and nonce state through storage", async () => {
  const env = { ADMIN_SECRET: adminSecret };
  const storage = new MemoryDurableObjectStorage();
  const firstObject = new ColabBridgeSessionDurableObject({ storage }, env);

  const created = await firstObject.fetch(
    new Request(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminSecret}` },
    }),
  );
  const createdEnvelope = await readEnvelope<CreatedSession>(created);
  assert.equal(created.status, 201);
  assert.ok(createdEnvelope.data);

  const firstStatus = await firstObject.fetch(
    new Request(`${baseUrl}/v1/sessions/${createdEnvelope.data.session_id}/status`, {
      headers: controllerHeaders(createdEnvelope.data.controller_token, "do_persisted_nonce"),
    }),
  );
  assert.equal(firstStatus.status, 200);

  const reconstructedObject = new ColabBridgeSessionDurableObject({ storage }, env);
  const replay = await reconstructedObject.fetch(
    new Request(`${baseUrl}/v1/sessions/${createdEnvelope.data.session_id}/status`, {
      headers: controllerHeaders(createdEnvelope.data.controller_token, "do_persisted_nonce"),
    }),
  );
  const replayEnvelope = await readEnvelope(replay);
  assert.equal(replay.status, 401);
  assert.equal(replayEnvelope.error?.code, "REPLAY_DETECTED");

  const freshStatus = await reconstructedObject.fetch(
    new Request(`${baseUrl}/v1/sessions/${createdEnvelope.data.session_id}/status`, {
      headers: controllerHeaders(createdEnvelope.data.controller_token, "do_fresh_nonce"),
    }),
  );
  const freshEnvelope = await readEnvelope<{ runner_connected: boolean }>(freshStatus);
  assert.equal(freshStatus.status, 200);
  assert.equal(freshEnvelope.data?.runner_connected, false);
  assert.equal(storage.values.has("colab_mcp_bridge_state_v1"), false);
  assert.equal(storage.values.has("colab_mcp_bridge_row_v1:index"), true);
  assert.equal(
    [...storage.values.keys()].some((key) => key.startsWith("colab_mcp_bridge_row_v1:session:")),
    true,
  );
  assert.equal(
    [...storage.values.keys()].some((key) => key.startsWith("colab_mcp_bridge_row_v1:nonce:")),
    true,
  );
});

test("Durable Object migrates legacy snapshot state into row storage", async () => {
  const env = { ADMIN_SECRET: adminSecret };
  const storage = new MemoryDurableObjectStorage();
  const sessionId = "sess_legacy_snapshot";
  const controllerToken = "br_legacy_controller";
  const runnerToken = "br_legacy_runner";
  const now = new Date().toISOString();

  await storage.put("colab_mcp_bridge_state_v1", {
    sessions: [
      {
        sessionId,
        controllerTokenHash: hashToken(controllerToken),
        runnerTokenHash: hashToken(runnerToken),
        createdAt: now,
        expiresAt: "2999-01-01T00:00:00.000Z",
        revokedAt: null,
        runnerConnected: false,
        runnerInstanceId: null,
        kernelStartedAt: null,
        runnerStartedAt: null,
        lastHeartbeatAt: null,
      },
    ],
    commands: [
      {
        sessionId,
        commandId: "cmd_legacy_done",
        type: "ping",
        state: "succeeded",
        requestPayload: {},
        requestPayloadHash: "legacy_hash",
        resultPayload: { ok: true, migrated: true },
        error: null,
        deadlineAt: "2999-01-01T00:00:00.000Z",
        createdAt: now,
        updatedAt: now,
        runnerInstanceId: "runner_legacy",
        stateHistory: ["accepted", "queued", "sent_to_runner", "running", "succeeded"],
      },
    ],
    audits: [
      {
        sessionId,
        at: now,
        event: "session_create",
        callerSide: "system",
        outcome: "accepted",
      },
    ],
    nonces: [
      {
        sessionId,
        side: "controller",
        nonce: "legacy_used_nonce",
        seenAt: now,
      },
    ],
  });

  const durableObject = new ColabBridgeSessionDurableObject({ storage }, env);
  const status = await durableObject.fetch(
    new Request(`${baseUrl}/v1/sessions/${sessionId}/status`, {
      headers: controllerHeaders(controllerToken, "legacy_fresh_nonce"),
    }),
  );
  const statusEnvelope = await readEnvelope<{ runner_connected: boolean }>(status);

  assert.equal(status.status, 200);
  assert.equal(statusEnvelope.data?.runner_connected, false);
  assert.equal(storage.values.has("colab_mcp_bridge_row_v1:index"), true);
  assert.equal(
    [...storage.values.keys()].some((key) => key.startsWith("colab_mcp_bridge_row_v1:command:")),
    true,
  );

  const reconstructedObject = new ColabBridgeSessionDurableObject({ storage }, env);
  const legacyCommand = await reconstructedObject.fetch(
    new Request(`${baseUrl}/v1/sessions/${sessionId}/commands/cmd_legacy_done`, {
      headers: controllerHeaders(controllerToken, "legacy_poll_nonce"),
    }),
  );
  const commandEnvelope = await readEnvelope<CommandData>(legacyCommand);

  assert.equal(legacyCommand.status, 200);
  assert.equal(commandEnvelope.data?.state, "succeeded");
  assert.deepEqual(commandEnvelope.data?.result_payload, { ok: true, migrated: true });

  const replay = await reconstructedObject.fetch(
    new Request(`${baseUrl}/v1/sessions/${sessionId}/status`, {
      headers: controllerHeaders(controllerToken, "legacy_used_nonce"),
    }),
  );
  const replayEnvelope = await readEnvelope(replay);
  assert.equal(replay.status, 401);
  assert.equal(replayEnvelope.error?.code, "REPLAY_DETECTED");
});
