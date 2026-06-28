import test from "node:test";
import assert from "node:assert/strict";
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

test("Worker command route exposes only safe command types", async () => {
  const env = { ADMIN_SECRET: adminSecret };
  const session = await createSession(env);

  const unsupported = await fetchWorker(
    env,
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "worker_unsafe_command"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "colab_run_shell", payload: { command: "echo no" } }),
    }),
  );
  const envelope = await readEnvelope(unsupported);

  assert.equal(unsupported.status, 400);
  assert.equal(envelope.error?.code, "INVALID_ARGUMENT");
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
});
