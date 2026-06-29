import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface JobSummary {
  job_id: string;
  status: string;
  started_at: string;
  exit_code: number | null;
  interrupted_at: string | null;
  active: boolean;
  name?: string;
}

function createHarness(options: { enableDangerousTools?: boolean } = {}): {
  broker: SessionBroker;
  handler: BridgeHttpHandler;
} {
  const broker = new SessionBroker();
  const handler = createBridgeHttpHandler({
    broker,
    adminSecret,
    enableDangerousTools: options.enableDangerousTools,
  });
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

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function assertHttpJobSummary(summary: JobSummary | undefined, jobId: string): void {
  assert.ok(summary);
  assert.equal(summary.job_id, jobId);
  assert.equal(summary.status, "running");
  assert.equal(typeof summary.started_at, "string");
  assert.equal(summary.exit_code, null);
  assert.equal(summary.interrupted_at, null);
  assert.equal(summary.active, true);
  assert.equal(summary.name, "http-summary-job");
  assert.equal("events" in summary, false);
  assert.equal("stdout" in summary, false);
  assert.equal("stderr" in summary, false);
  assert.equal("text" in summary, false);
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

test("commands route validates JSON and rejects unsupported command types", async () => {
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

test("dangerous command types are rejected by default through HTTP", async () => {
  const { handler } = createHarness();
  const session = await createSession(handler);

  const shellResponse = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_default"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "run_shell", payload: { command: "echo no" } }),
    }),
  );
  const shellEnvelope = await readEnvelope(shellResponse);

  assert.equal(shellResponse.status, 403);
  assert.equal(shellEnvelope.error?.code, "TOOL_DISABLED");

  const writeResponse = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_write_default"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "write_file",
        payload: { path: "blocked.txt", content: "no", mode: "overwrite" },
      }),
    }),
  );
  const writeEnvelope = await readEnvelope(writeResponse);

  assert.equal(writeResponse.status, 403);
  assert.equal(writeEnvelope.error?.code, "TOOL_DISABLED");

  const startResponse = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_start_default"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "start_job", payload: { command: "echo no" } }),
    }),
  );
  const startEnvelope = await readEnvelope(startResponse);

  assert.equal(startResponse.status, 403);
  assert.equal(startEnvelope.error?.code, "TOOL_DISABLED");

  const interruptResponse = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_interrupt_default"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "interrupt_job", payload: { job_id: "job_missing" } }),
    }),
  );
  const interruptEnvelope = await readEnvelope(interruptResponse);

  assert.equal(interruptResponse.status, 403);
  assert.equal(interruptEnvelope.error?.code, "TOOL_DISABLED");
});

test("dangerous command types are accepted through HTTP when explicitly enabled", async () => {
  const { broker, handler } = createHarness({ enableDangerousTools: true });
  const session = await createSession(handler);
  const runner = attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
  });

  const shell = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_shell_enabled"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "run_shell", payload: { command: "printf http-shell" } }),
    }),
  );
  const shellEnvelope = await readEnvelope<CommandData>(shell);
  const shellResult = shellEnvelope.data?.result_payload as { stdout: string; exit_code: number };
  assert.equal(shell.status, 201);
  assert.equal(shellEnvelope.data?.type, "run_shell");
  assert.equal(shellResult.stdout, "http-shell");
  assert.equal(shellResult.exit_code, 0);

  const python = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_python_enabled"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "run_python", payload: { code: "print('http-python')" } }),
    }),
  );
  const pythonEnvelope = await readEnvelope<CommandData>(python);
  const pythonResult = pythonEnvelope.data?.result_payload as { stdout: string; exit_code: number };
  assert.equal(python.status, 201);
  assert.equal(pythonEnvelope.data?.type, "run_python");
  assert.equal(pythonResult.stdout, "http-python\n");
  assert.equal(pythonResult.exit_code, 0);

  const write = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_write_enabled"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "write_file",
        payload: { path: "http.txt", content: "http-file", mode: "overwrite" },
      }),
    }),
  );
  const writeEnvelope = await readEnvelope<CommandData>(write);
  const writeResult = writeEnvelope.data?.result_payload as {
    path: string;
    bytes_written: number;
    mode: string;
  };
  assert.equal(write.status, 201);
  assert.equal(writeEnvelope.data?.type, "write_file");
  assert.deepEqual(writeResult, {
    path: "http.txt",
    bytes_written: 9,
    mode: "overwrite",
  });
  assert.equal(await readFile(join(runner.projectRoot, "http.txt"), "utf8"), "http-file");

  const start = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "dangerous_start_enabled"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "start_job", payload: { command: "printf http-job" } }),
    }),
  );
  const startEnvelope = await readEnvelope<CommandData>(start);
  const startResult = startEnvelope.data?.result_payload as {
    job_id: string;
    status: string;
    started_at: string;
  };
  assert.equal(start.status, 201);
  assert.equal(startEnvelope.data?.type, "start_job");
  assert.equal(startResult.status, "running");
  assert.equal(startResult.job_id.startsWith("job_"), true);
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
    active_job_id: null,
  });
});

test("gpu_status command type is accepted through command route", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
  });

  const response = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "create_gpu_status_command"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "gpu_status" }),
    }),
  );
  const envelope = await readEnvelope<CommandData>(response);

  assert.equal(response.status, 201);
  assert.equal(envelope.data?.type, "gpu_status");
  assert.equal(envelope.data?.state, "succeeded");
  assert.deepEqual(envelope.data?.result_payload, {
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

test("read_file command type is accepted through HTTP without dangerous enablement", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "colab-mcp-http-read-"));
  try {
    await writeFile(join(projectRoot, "readme.txt"), "abcdef", "utf8");
    const { broker, handler } = createHarness();
    const session = await createSession(handler);
    attachFakeRunnerForTest({
      broker,
      sessionId: session.session_id,
      runnerToken: session.runner_token,
      options: { projectRoot },
    });

    const response = await handler(
      new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
        method: "POST",
        headers: {
          ...controllerHeaders(session.controller_token, "read_file_default"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "read_file", payload: { path: "readme.txt", max_bytes: 3 } }),
      }),
    );
    const envelope = await readEnvelope<CommandData>(response);
    const result = envelope.data?.result_payload as {
      path: string;
      content: string;
      bytes_read: number;
      truncated: boolean;
    };

    assert.equal(response.status, 201);
    assert.equal(envelope.data?.type, "read_file");
    assert.deepEqual(result, {
      path: "readme.txt",
      content: "abc",
      bytes_read: 3,
      truncated: true,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("tail_job command type is accepted through HTTP without dangerous enablement", async () => {
  const { broker, handler } = createHarness({ enableDangerousTools: true });
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
  });

  const start = await handler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "tail_setup_start"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "start_job", payload: { command: "printf http-tail" } }),
    }),
  );
  const startEnvelope = await readEnvelope<CommandData>(start);
  const startResult = startEnvelope.data?.result_payload as { job_id: string };

  const readOnlyHandler = createBridgeHttpHandler({ broker, adminSecret });
  const tail = await readOnlyHandler(
    new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
      method: "POST",
      headers: {
        ...controllerHeaders(session.controller_token, "tail_default"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "tail_job", payload: { job_id: startResult.job_id } }),
    }),
  );
  const tailEnvelope = await readEnvelope<CommandData>(tail);

  assert.equal(tail.status, 201);
  assert.equal(tailEnvelope.data?.type, "tail_job");
  assert.equal(tailEnvelope.data?.state, "succeeded");
});

test("list_jobs and job_status command types are accepted through HTTP without dangerous enablement", async () => {
  const { broker, handler } = createHarness({ enableDangerousTools: true });
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
  });
  let jobId: string | null = null;

  try {
    const start = await handler(
      new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
        method: "POST",
        headers: {
          ...controllerHeaders(session.controller_token, "summary_setup_start"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "start_job",
          payload: {
            command: nodeCommand("console.log('http-secret-log'); setInterval(() => {}, 1000);"),
            name: "http-summary-job",
          },
        }),
      }),
    );
    const startEnvelope = await readEnvelope<CommandData>(start);
    const startResult = startEnvelope.data?.result_payload as { job_id: string };
    jobId = startResult.job_id;

    const readOnlyHandler = createBridgeHttpHandler({ broker, adminSecret });
    const list = await readOnlyHandler(
      new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
        method: "POST",
        headers: {
          ...controllerHeaders(session.controller_token, "summary_list"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "list_jobs" }),
      }),
    );
    const listEnvelope = await readEnvelope<CommandData>(list);
    const listPayload = listEnvelope.data?.result_payload as { jobs: JobSummary[] };

    assert.equal(list.status, 201);
    assert.equal(listEnvelope.data?.type, "list_jobs");
    assert.equal(listPayload.jobs.length, 1);
    assertHttpJobSummary(listPayload.jobs[0], jobId);

    const status = await readOnlyHandler(
      new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
        method: "POST",
        headers: {
          ...controllerHeaders(session.controller_token, "summary_status"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "job_status", payload: { job_id: jobId } }),
      }),
    );
    const statusEnvelope = await readEnvelope<CommandData>(status);

    assert.equal(status.status, 201);
    assert.equal(statusEnvelope.data?.type, "job_status");
    assertHttpJobSummary(statusEnvelope.data?.result_payload as JobSummary, jobId);
    assert.equal(JSON.stringify(listPayload).includes("http-secret-log"), false);
    assert.equal(JSON.stringify(statusEnvelope.data?.result_payload).includes("http-secret-log"), false);

    const invalid = await readOnlyHandler(
      new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
        method: "POST",
        headers: {
          ...controllerHeaders(session.controller_token, "summary_status_invalid"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "job_status", payload: {} }),
      }),
    );
    const invalidEnvelope = await readEnvelope(invalid);
    assert.equal(invalid.status, 400);
    assert.equal(invalidEnvelope.error?.code, "INVALID_ARGUMENT");
  } finally {
    if (jobId) {
      await handler(
        new Request(`${baseUrl}/v1/sessions/${session.session_id}/commands`, {
          method: "POST",
          headers: {
            ...controllerHeaders(session.controller_token, "summary_cleanup"),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "interrupt_job",
            payload: { job_id: jobId, signal: "SIGKILL", kill_after_sec: 0 },
          }),
        }),
      );
    }
  }
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
