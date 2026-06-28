import test from "node:test";
import assert from "node:assert/strict";
import { BrokerError, SessionBroker } from "../src/broker.js";
import { FakeRunner } from "../src/fake-runner.js";
import { createResultEnvelope } from "../src/protocol.js";
import { authAt, authFactory, fixedAuth } from "./helpers.js";

test("invalid runner token cannot attach", () => {
  const broker = new SessionBroker();
  const session = broker.createSession();

  assert.throws(
    () =>
      broker.attachRunner(
        session.sessionId,
        fixedAuth("wrong-runner-token", "runner-bad"),
        {
          runnerInstanceId: "runner_1",
          kernelStartedAt: new Date().toISOString(),
        },
        () => {
          throw new Error("should not attach");
        },
      ),
    (error) => error instanceof BrokerError && error.bridgeError.code === "UNAUTHORIZED",
  );
});

test("revoked session cannot be used by controller or runner", () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");

  broker.revoke(session.sessionId, controllerAuth());

  assert.throws(
    () => broker.getStatus(session.sessionId, controllerAuth()),
    (error) => error instanceof BrokerError && error.bridgeError.code === "UNAUTHORIZED",
  );
  assert.throws(
    () =>
      broker.attachRunner(
        session.sessionId,
        runnerAuth(),
        { runnerInstanceId: "runner_1", kernelStartedAt: new Date().toISOString() },
        () => {
          throw new Error("should not attach");
        },
      ),
    (error) => error instanceof BrokerError && error.bridgeError.code === "UNAUTHORIZED",
  );
});

test("fake runner ping persists command states and result for later fetch", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  new FakeRunner(broker, session.sessionId, runnerAuth).attach();

  const command = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "ping",
    payload: {},
  });

  assert.equal(command.state, "succeeded");
  assert.deepEqual(command.resultPayload, { ok: true, pong: true });
  assert.deepEqual(command.stateHistory, [
    "accepted",
    "queued",
    "sent_to_runner",
    "runner_acknowledged",
    "running",
    "succeeded",
  ]);

  const fetched = broker.getCommandResult(session.sessionId, controllerAuth(), command.commandId);
  assert.equal(fetched.commandId, command.commandId);
  assert.deepEqual(fetched.resultPayload, { ok: true, pong: true });

  const auditRows = broker.getAuditRows(session.sessionId);
  assert.equal(
    auditRows.some((row) => row.event === "command_create" && row.payloadHash && !("requestPayload" in row)),
    true,
  );
});

test("fake runner status command returns authenticated runner metadata", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  new FakeRunner(broker, session.sessionId, runnerAuth, {
    runnerInstanceId: "runner_status",
  }).attach();

  const command = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "status",
    payload: {},
  });

  assert.equal(command.state, "succeeded");
  assert.equal((command.resultPayload as { runner_instance_id: string }).runner_instance_id, "runner_status");

  const status = broker.getStatus(session.sessionId, controllerAuth());
  assert.equal(status.runner_connected, true);
  assert.equal(status.runner_instance_id, "runner_status");
});

test("fake runner gpu_status command returns deterministic GPU payload", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  new FakeRunner(broker, session.sessionId, runnerAuth).attach();

  const command = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "gpu_status",
    payload: {},
  });

  assert.equal(command.state, "succeeded");
  assert.deepEqual(command.resultPayload, {
    available: true,
    source: "fake",
    gpus: [
      {
        index: 0,
        name: "Fake Colab GPU",
        memory_total_mb: 16384,
        memory_used_mb: 1024,
        utilization_gpu_percent: 7,
      },
    ],
    raw: "Fake Colab GPU, 16384 MiB, 1024 MiB, 7 %",
  });
});

test("fake runner run_shell returns bounded foreground execution result", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  new FakeRunner(broker, session.sessionId, runnerAuth).attach();

  const command = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "run_shell",
    payload: { command: "printf shell-ok", timeout_sec: 5, max_output_bytes: 1024 },
  });
  const result = command.resultPayload as {
    stdout: string;
    stderr: string;
    exit_code: number | null;
    timed_out: boolean;
    truncated: boolean;
  };

  assert.equal(command.state, "succeeded");
  assert.equal(result.stdout, "shell-ok");
  assert.equal(result.stderr, "");
  assert.equal(result.exit_code, 0);
  assert.equal(result.timed_out, false);
  assert.equal(result.truncated, false);
});

test("fake runner run_python returns bounded foreground execution result", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  new FakeRunner(broker, session.sessionId, runnerAuth).attach();

  const command = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "run_python",
    payload: { code: "print('python-ok')", timeout_sec: 5, max_output_bytes: 1024 },
  });
  const result = command.resultPayload as {
    stdout: string;
    exit_code: number | null;
    timed_out: boolean;
    truncated: boolean;
  };

  assert.equal(command.state, "succeeded");
  assert.equal(result.stdout, "python-ok\n");
  assert.equal(result.exit_code, 0);
  assert.equal(result.timed_out, false);
  assert.equal(result.truncated, false);
});

test("fake runner foreground execution reports truncation and timeout", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  new FakeRunner(broker, session.sessionId, runnerAuth).attach();

  const truncated = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "run_shell",
    payload: { command: "printf abcdef", timeout_sec: 5, max_output_bytes: 3 },
  });
  const truncatedResult = truncated.resultPayload as { stdout: string; truncated: boolean };
  assert.equal(truncatedResult.stdout, "abc");
  assert.equal(truncatedResult.truncated, true);

  const timedOut = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "run_shell",
    payload: {
      command: "node -e \"setTimeout(() => {}, 1000)\"",
      timeout_sec: 0.05,
      max_output_bytes: 1024,
    },
  });
  const timedOutResult = timedOut.resultPayload as { timed_out: boolean; exit_code: number | null };
  assert.equal(timedOutResult.timed_out, true);
  assert.equal(timedOutResult.exit_code, null);
});

test("runner reconnect and restart update metadata explicitly", () => {
  const broker = new SessionBroker();
  const session = broker.createSession(new Date("2026-06-28T10:00:00.000Z"));

  broker.attachRunner(
    session.sessionId,
    authAt(session.runnerToken, "runner_attach", new Date("2026-06-28T10:00:02.000Z")),
    {
      runnerInstanceId: "runner_same",
      kernelStartedAt: "2026-06-28T10:00:00.000Z",
      runnerStartedAt: "2026-06-28T10:00:01.000Z",
    },
    () => {
      throw new Error("not used");
    },
    new Date("2026-06-28T10:00:02.000Z"),
  );
  broker.attachRunner(
    session.sessionId,
    authAt(session.runnerToken, "runner_reconnect", new Date("2026-06-28T10:00:04.000Z")),
    {
      runnerInstanceId: "runner_same",
      kernelStartedAt: "2026-06-28T10:00:00.000Z",
      runnerStartedAt: "2026-06-28T10:00:03.000Z",
    },
    () => {
      throw new Error("not used");
    },
    new Date("2026-06-28T10:00:04.000Z"),
  );
  broker.attachRunner(
    session.sessionId,
    authAt(session.runnerToken, "runner_restart", new Date("2026-06-28T10:05:02.000Z")),
    {
      runnerInstanceId: "runner_new",
      kernelStartedAt: "2026-06-28T10:05:00.000Z",
      runnerStartedAt: "2026-06-28T10:05:01.000Z",
    },
    () => {
      throw new Error("not used");
    },
    new Date("2026-06-28T10:05:02.000Z"),
  );

  const status = broker.getStatus(
    session.sessionId,
    authAt(session.controllerToken, "controller_status", new Date("2026-06-28T10:05:03.000Z")),
    new Date("2026-06-28T10:05:03.000Z"),
  );
  assert.equal(status.runner_connected, true);
  assert.equal(status.runner_instance_id, "runner_new");
  assert.equal(status.kernel_started_at, "2026-06-28T10:05:00.000Z");

  const auditEvents = broker.getAuditRows(session.sessionId).map((row) => row.event);
  assert.equal(auditEvents.includes("runner_attach"), true);
  assert.equal(auditEvents.includes("runner_reconnect"), true);
  assert.equal(auditEvents.includes("runner_restart"), true);
});

test("duplicate command id returns existing command without re-executing", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  let executions = 0;

  broker.attachRunner(
    session.sessionId,
    runnerAuth(),
    { runnerInstanceId: "runner_1", kernelStartedAt: new Date().toISOString() },
    (envelope) => {
      executions += 1;
      broker.acknowledgeCommand(session.sessionId, runnerAuth(), envelope.command_id);
      return createResultEnvelope({
        command: envelope,
        ok: true,
        payload: { execution: executions },
      });
    },
  );

  const first = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "ping",
    payload: { value: 1 },
    commandId: "cmd_duplicate",
  });
  const second = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "ping",
    payload: { value: 1 },
    commandId: "cmd_duplicate",
  });

  assert.equal(executions, 1);
  assert.equal(first.commandId, second.commandId);
  assert.deepEqual(second.resultPayload, { execution: 1 });
});

test("duplicate command id with different payload is rejected", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");
  new FakeRunner(broker, session.sessionId, runnerAuth).attach();

  await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "ping",
    payload: { value: 1 },
    commandId: "cmd_payload_mismatch",
  });

  await assert.rejects(
    () =>
      broker.createCommand(session.sessionId, controllerAuth(), {
        type: "ping",
        payload: { value: 2 },
        commandId: "cmd_payload_mismatch",
      }),
    (error) => error instanceof BrokerError && error.bridgeError.code === "INVALID_ARGUMENT",
  );
});

test("stale runner is reported offline and does not receive commands", async () => {
  const broker = new SessionBroker(undefined, undefined, { runnerStaleMs: 1_000 });
  const startedAt = new Date("2026-06-28T10:00:00.000Z");
  const staleAt = new Date("2026-06-28T10:00:02.000Z");
  const session = broker.createSession(startedAt);
  let executions = 0;

  broker.attachRunner(
    session.sessionId,
    authAt(session.runnerToken, "runner_attach", startedAt),
    { runnerInstanceId: "runner_stale", kernelStartedAt: startedAt.toISOString() },
    (envelope) => {
      executions += 1;
      broker.acknowledgeCommand(
        session.sessionId,
        authAt(session.runnerToken, `runner_ack_${executions}`, staleAt),
        envelope.command_id,
        staleAt,
      );
      return createResultEnvelope({ command: envelope, ok: true, payload: { should_not_run: true } });
    },
    startedAt,
  );

  const status = broker.getStatus(
    session.sessionId,
    authAt(session.controllerToken, "controller_status", staleAt),
    staleAt,
  );
  assert.equal(status.runner_connected, false);
  assert.equal(status.runner_instance_id, "runner_stale");

  const command = await broker.createCommand(
    session.sessionId,
    authAt(session.controllerToken, "controller_command", staleAt),
    { type: "ping", payload: {} },
    staleAt,
  );

  assert.equal(executions, 0);
  assert.equal(command.state, "failed");
  assert.equal(command.error?.code, "RUNNER_OFFLINE");
});

test("runner exception fails command instead of leaving it in flight", async () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller");
  const runnerAuth = authFactory(session.runnerToken, "runner");

  broker.attachRunner(
    session.sessionId,
    runnerAuth(),
    { runnerInstanceId: "runner_throws", kernelStartedAt: new Date().toISOString() },
    (envelope) => {
      broker.acknowledgeCommand(session.sessionId, runnerAuth(), envelope.command_id);
      throw new Error("runner exploded");
    },
  );

  const command = await broker.createCommand(session.sessionId, controllerAuth(), {
    type: "ping",
    payload: {},
  });

  assert.equal(command.state, "failed");
  assert.equal(command.error?.code, "INTERNAL_ERROR");
  assert.deepEqual(command.stateHistory, [
    "accepted",
    "queued",
    "sent_to_runner",
    "runner_acknowledged",
    "failed",
  ]);
});
