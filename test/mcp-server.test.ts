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
import {
  loadLocalBridgeConfig,
  parseLocalBridgeConfig,
  type LocalBridgeConfig,
} from "../src/mcp-config.js";
import {
  ColabMcpServer,
  InMemoryMcpTransport,
  type JsonRpcSuccessResponse,
  type JsonRpcResponse,
} from "../src/mcp-server.js";

const baseUrl = "https://bridge.test";
const adminSecret = "admin_secret_for_mcp_server_tests";

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

interface JobSummary {
  job_id: string;
  status: string;
  started_at: string;
  exit_code: number | null;
  interrupted_at: string | null;
  active: boolean;
  name?: string;
}

type RpcSuccess = JsonRpcSuccessResponse;

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

async function createSession(handler: BridgeHttpHandler): Promise<CreatedSession> {
  const response = await handler(
    new Request(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminSecret}` },
    }),
  );
  const envelope = (await response.json()) as Envelope<CreatedSession>;
  assert.equal(response.status, 201);
  assert.ok(envelope.data);
  return envelope.data;
}

function serverConfig(session: CreatedSession, options: { enableDangerousTools?: boolean } = {}): LocalBridgeConfig {
  return {
    baseUrl,
    sessionId: session.session_id,
    controllerToken: session.controller_token,
    enableDangerousTools: options.enableDangerousTools === true,
  };
}

async function send(
  transport: InMemoryMcpTransport,
  method: string,
  params?: unknown,
): Promise<RpcSuccess> {
  const response = await transport.send({ jsonrpc: "2.0", id: 1, method, params });
  assert.ok(response);
  assert.equal(Array.isArray(response), false);
  assert.equal("result" in response, true);
  return response as RpcSuccess;
}

function callToolResult(response: RpcSuccess): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    ok: boolean;
    data: unknown;
    error: { code: string; message: string; retryable: boolean } | null;
  };
  isError: boolean;
} {
  return response.result as {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: {
      ok: boolean;
      data: unknown;
      error: { code: string; message: string; retryable: boolean } | null;
    };
    isError: boolean;
  };
}

function assertPingCommandResult(result: ReturnType<typeof callToolResult>): void {
  const data = result.structuredContent.data as {
    type: string;
    state: string;
    result_payload: unknown;
  };

  assert.equal(result.isError, false);
  assert.equal(data.type, "ping");
  assert.equal(data.state, "succeeded");
  assert.deepEqual(data.result_payload, { ok: true, pong: true });
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function assertMcpJobSummary(summary: JobSummary | undefined, jobId: string, active: boolean): void {
  assert.ok(summary);
  assert.equal(summary.job_id, jobId);
  assert.equal(summary.status, "running");
  assert.equal(typeof summary.started_at, "string");
  assert.equal(summary.exit_code, null);
  assert.equal(summary.interrupted_at, null);
  assert.equal(summary.active, active);
  assert.equal(summary.name, "mcp-summary-job");
  assert.equal("events" in summary, false);
  assert.equal("stdout" in summary, false);
  assert.equal("stderr" in summary, false);
  assert.equal("text" in summary, false);
}

test("initialize returns MCP server capabilities", async () => {
  const transport = new InMemoryMcpTransport(new ColabMcpServer());

  const response = await send(transport, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });

  const result = response.result as {
    protocolVersion: string;
    capabilities: { tools: Record<string, unknown> };
    serverInfo: { name: string };
  };
  assert.equal(result.protocolVersion, "2025-11-25");
  assert.deepEqual(result.capabilities.tools, {});
  assert.equal(result.serverInfo.name, "codex-colab-bridge");
});

test("tools/list includes disabled dangerous tools with schemas and annotations", async () => {
  const transport = new InMemoryMcpTransport(new ColabMcpServer());

  const response = await send(transport, "tools/list");
  const result = response.result as { tools: Array<Record<string, unknown>> };
  const runnerPing = result.tools.find((tool) => tool.name === "colab_runner_ping");
  const legacyPing = result.tools.find((tool) => tool.name === "colab_ping");
  const runShell = result.tools.find((tool) => tool.name === "colab_run_shell");
  const writeTool = result.tools.find((tool) => tool.name === "colab_write_file");
  const readTool = result.tools.find((tool) => tool.name === "colab_read_file");
  const startJob = result.tools.find((tool) => tool.name === "colab_start_job");
  const listJobs = result.tools.find((tool) => tool.name === "colab_list_jobs");
  const jobStatus = result.tools.find((tool) => tool.name === "colab_job_status");
  const tailJob = result.tools.find((tool) => tool.name === "colab_tail_job");
  const interruptJob = result.tools.find((tool) => tool.name === "colab_interrupt_job");
  const doctor = result.tools.find((tool) => tool.name === "colab_doctor");
  const listSessions = result.tools.find((tool) => tool.name === "colab_list_sessions");
  const runtimeStatus = result.tools.find((tool) => tool.name === "colab_runtime_status");
  const runtimeUrl = result.tools.find((tool) => tool.name === "colab_runtime_url");
  const uploadFile = result.tools.find((tool) => tool.name === "colab_upload_file");
  const downloadFile = result.tools.find((tool) => tool.name === "colab_download_file");
  const reconnectRunner = result.tools.find((tool) => tool.name === "colab_reconnect_runner");
  const setupBridge = result.tools.find((tool) => tool.name === "colab_setup_bridge");
  const runtimeOptions = result.tools.find((tool) => tool.name === "colab_runtime_options");
  const stopRuntime = result.tools.find((tool) => tool.name === "colab_stop_runtime");
  const recreateRuntime = result.tools.find((tool) => tool.name === "colab_recreate_runtime");

  assert.ok(runnerPing);
  assert.equal(legacyPing, undefined);
  assert.deepEqual(runnerPing.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in runnerPing, false);

  assert.ok(runShell);
  assert.equal(typeof runShell.description, "string");
  assert.equal(typeof runShell.inputSchema, "object");
  assert.equal(typeof runShell.outputSchema, "object");
  assert.deepEqual(runShell.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in runShell, false);

  assert.ok(writeTool);
  const writeSchema = writeTool.inputSchema as {
    required: string[];
    properties: Record<string, { enum?: string[]; maximum?: number }>;
  };
  assert.deepEqual(writeSchema.required, ["path", "content", "mode"]);
  assert.deepEqual(writeSchema.properties.mode?.enum, ["overwrite", "append", "create_new"]);
  assert.deepEqual(writeTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in writeTool, false);

  assert.ok(readTool);
  const readSchema = readTool.inputSchema as {
    required: string[];
    properties: Record<string, { default?: number; maximum?: number }>;
  };
  assert.deepEqual(readSchema.required, ["path"]);
  assert.equal(readSchema.properties.max_bytes?.default, 20 * 1024);
  assert.equal(readSchema.properties.max_bytes?.maximum, 1024 * 1024);
  assert.deepEqual(readTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in readTool, false);

  assert.ok(startJob);
  const startJobSchema = startJob.inputSchema as {
    required: string[];
    properties: Record<string, { default?: number; maximum?: number }>;
  };
  assert.deepEqual(startJobSchema.required, ["command"]);
  assert.equal(startJobSchema.properties.max_log_bytes?.default, 200 * 1024);
  assert.equal(startJobSchema.properties.max_log_bytes?.maximum, 200 * 1024);
  assert.deepEqual(startJob.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in startJob, false);

  assert.ok(listJobs);
  assert.deepEqual(listJobs.inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.deepEqual(listJobs.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in listJobs, false);

  assert.ok(jobStatus);
  assert.deepEqual((jobStatus.inputSchema as { required: string[] }).required, ["job_id"]);
  assert.deepEqual(jobStatus.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in jobStatus, false);

  assert.ok(tailJob);
  const tailJobSchema = tailJob.inputSchema as {
    required: string[];
    properties: Record<string, { default?: number; maximum?: number }>;
  };
  assert.deepEqual(tailJobSchema.required, ["job_id"]);
  assert.equal(tailJobSchema.properties.max_bytes?.default, 20 * 1024);
  assert.equal(tailJobSchema.properties.max_bytes?.maximum, 200 * 1024);
  assert.deepEqual(tailJob.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in tailJob, false);

  assert.ok(interruptJob);
  const interruptSchema = interruptJob.inputSchema as {
    required: string[];
    properties: Record<string, { default?: number; maximum?: number }>;
  };
  assert.deepEqual(interruptSchema.required, ["job_id"]);
  assert.equal(interruptSchema.properties.kill_after_sec?.default, 5);
  assert.equal(interruptSchema.properties.kill_after_sec?.maximum, 30);
  assert.deepEqual(interruptJob.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in interruptJob, false);

  assert.ok(doctor);
  const doctorSchema = doctor.inputSchema as {
    properties: Record<string, { default?: unknown; maximum?: number }>;
  };
  assert.equal(doctorSchema.properties.skip_network?.default, false);
  assert.equal(doctorSchema.properties.require_network?.default, false);
  assert.equal(doctorSchema.properties.timeout_sec?.default, 120);
  assert.equal(doctorSchema.properties.timeout_sec?.maximum, 300);
  assert.deepEqual(doctor.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in doctor, false);

  assert.ok(listSessions);
  assert.deepEqual(listSessions.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in listSessions, false);

  assert.ok(runtimeStatus);
  assert.equal(
    (runtimeStatus.inputSchema as { properties: Record<string, { default?: unknown }> }).properties.colab_session
      ?.default,
    "codex-colab-bridge",
  );
  assert.deepEqual(runtimeStatus.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in runtimeStatus, false);

  assert.ok(runtimeUrl);
  assert.deepEqual(runtimeUrl.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in runtimeUrl, false);

  assert.ok(uploadFile);
  assert.deepEqual((uploadFile.inputSchema as { required: string[] }).required, ["local_path", "remote_path"]);
  assert.deepEqual(uploadFile.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in uploadFile, false);

  assert.ok(downloadFile);
  assert.deepEqual((downloadFile.inputSchema as { required: string[] }).required, ["remote_path", "local_path"]);
  assert.deepEqual(downloadFile.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in downloadFile, false);

  assert.ok(reconnectRunner);
  const reconnectSchema = reconnectRunner.inputSchema as {
    properties: Record<string, { default?: unknown; maximum?: number }>;
  };
  assert.equal(reconnectSchema.properties.timeout_sec?.default, 60);
  assert.equal(reconnectSchema.properties.timeout_sec?.maximum, 300);
  assert.deepEqual(reconnectRunner.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in reconnectRunner, false);

  assert.ok(setupBridge);
  const setupSchema = setupBridge.inputSchema as {
    properties: Record<string, { default?: unknown; maximum?: number }>;
  };
  assert.equal(setupSchema.properties.bootstrap?.default, true);
  assert.equal(setupSchema.properties.smoke?.default, true);
  assert.equal(setupSchema.properties.timeout_sec?.maximum, 1800);
  assert.deepEqual(setupBridge.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in setupBridge, false);

  assert.ok(runtimeOptions);
  assert.deepEqual(runtimeOptions.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in runtimeOptions, false);

  assert.ok(stopRuntime);
  const stopSchema = stopRuntime.inputSchema as {
    properties: Record<string, { default?: unknown; maximum?: number }>;
  };
  assert.equal(stopSchema.properties.timeout_sec?.default, 120);
  assert.equal(stopSchema.properties.timeout_sec?.maximum, 300);
  assert.deepEqual(stopRuntime.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in stopRuntime, false);

  assert.ok(recreateRuntime);
  assert.deepEqual((recreateRuntime.inputSchema as { required: string[] }).required, ["gpu"]);
  assert.deepEqual(recreateRuntime.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal("enabledByDefault" in recreateRuntime, false);
});

test("colab_status calls the local HTTP handler and returns MCP CallToolResult shape", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({
    broker,
    sessionId: session.session_id,
    runnerToken: session.runner_token,
    options: { runnerInstanceId: "runner_mcp_status" },
  });
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
  );

  const response = await send(transport, "tools/call", { name: "colab_status", arguments: {} });
  const result = callToolResult(response);
  const data = result.structuredContent.data as { runner_connected: boolean; runner_instance_id: string };

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(data.runner_connected, true);
  assert.equal(data.runner_instance_id, "runner_mcp_status");
});

test("colab_runner_ping is public and colab_ping remains a callable alias", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
  );

  const runnerPing = callToolResult(
    await send(transport, "tools/call", { name: "colab_runner_ping", arguments: {} }),
  );
  const legacyPing = callToolResult(
    await send(transport, "tools/call", { name: "colab_ping", arguments: {} }),
  );

  assertPingCommandResult(runnerPing);
  assertPingCommandResult(legacyPing);
});

test("colab_gpu_status creates a gpu_status command and returns the serialized command result", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
  );

  const response = await send(transport, "tools/call", {
    name: "colab_gpu_status",
    arguments: {},
  });
  const result = callToolResult(response);
  const data = result.structuredContent.data as {
    type: string;
    state: string;
    result_payload: {
      available: boolean;
      source: string;
      gpus: Array<{ name: string }>;
    };
  };

  assert.equal(result.isError, false);
  assert.equal(data.type, "gpu_status");
  assert.equal(data.state, "succeeded");
  assert.equal(data.result_payload.available, true);
  assert.equal(data.result_payload.source, "fake");
  assert.equal(data.result_payload.gpus[0]?.name, "Fake Colab GPU");
});

test("colab_doctor runs locally without bridge config and returns parsed checks", async () => {
  const payloads: unknown[] = [];
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      doctor: async (payload) => {
        payloads.push(payload);
        return {
          command: ["node", "scripts/doctor.mjs", "--json", "--skip-network"],
          stdout: JSON.stringify({
            ok: true,
            summary: { pass: 1, warn: 0, fail: 0 },
            checks: [{ status: "pass", name: "node", message: "Node is supported." }],
          }),
          stderr: "",
          exit_code: 0,
          duration_ms: 4,
          timed_out: false,
          truncated: false,
          dry_run: false,
          ok: true,
          summary: { pass: 1, warn: 0, fail: 0 },
          checks: [{ status: "pass", name: "node", message: "Node is supported." }],
        };
      },
    }),
  );

  const response = await send(transport, "tools/call", {
    name: "colab_doctor",
    arguments: {
      config: "/tmp/bridge.json",
      base_url: "https://bridge.test",
      skip_network: true,
      require_network: false,
      timeout_sec: 45,
    },
  });
  const result = callToolResult(response);
  const data = result.structuredContent.data as {
    command: string[];
    ok: boolean;
    checks: Array<{ status: string; name: string; message: string }>;
  };

  assert.equal(result.isError, false);
  assert.deepEqual(data.command, ["node", "scripts/doctor.mjs", "--json", "--skip-network"]);
  assert.equal(data.ok, true);
  assert.equal(data.checks[0]?.name, "node");
  assert.deepEqual(payloads, [
    {
      configPath: "/tmp/bridge.json",
      baseUrl: "https://bridge.test",
      skipNetwork: true,
      requireNetwork: false,
      timeoutSec: 45,
    },
  ]);
});

test("colab_doctor includes command data when local checks fail", async () => {
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      doctor: async () => ({
        command: ["node", "scripts/doctor.mjs", "--json"],
        stdout: JSON.stringify({
          ok: false,
          summary: { pass: 0, warn: 0, fail: 1 },
          checks: [{ status: "fail", name: "node", message: "Node is too old." }],
        }),
        stderr: "",
        exit_code: 1,
        duration_ms: 4,
        timed_out: false,
        truncated: false,
        dry_run: false,
        ok: false,
        summary: { pass: 0, warn: 0, fail: 1 },
        checks: [{ status: "fail", name: "node", message: "Node is too old." }],
      }),
    }),
  );

  const response = await send(transport, "tools/call", {
    name: "colab_doctor",
    arguments: {},
  });
  const result = callToolResult(response);
  const data = result.structuredContent.data as {
    command: string[];
    checks: Array<{ status: string }>;
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, "INTERNAL_ERROR");
  assert.deepEqual(data.command, ["node", "scripts/doctor.mjs", "--json"]);
  assert.equal(data.checks[0]?.status, "fail");
});

test("Colab CLI state tools run locally without bridge config", async () => {
  const payloads: Record<string, unknown[]> = {
    listSessions: [],
    runtimeStatus: [],
    runtimeUrl: [],
  };
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      listSessions: async (payload) => {
        payloads.listSessions.push(payload);
        return {
          command: ["uvx", "--from", "google-colab-cli", "colab", "--config", "/tmp/colab.json", "sessions"],
          stdout: "session-a\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 5,
          timed_out: false,
          truncated: false,
          dry_run: false,
        };
      },
      runtimeStatus: async (payload) => {
        payloads.runtimeStatus.push(payload);
        return {
          command: ["uvx", "--from", "google-colab-cli", "colab", "status", "-s", "named"],
          stdout: "running\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 5,
          timed_out: false,
          truncated: false,
          dry_run: false,
        };
      },
      runtimeUrl: async (payload) => {
        payloads.runtimeUrl.push(payload);
        return {
          command: ["uvx", "--from", "google-colab-cli", "colab", "url", "-s", "codex-colab-bridge"],
          stdout: "https://colab.research.google.com/drive/test\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 5,
          timed_out: false,
          truncated: false,
          dry_run: false,
        };
      },
    }),
  );

  const list = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_list_sessions",
      arguments: { colab_config: "/tmp/colab.json", timeout_sec: 20 },
    }),
  );
  const status = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_runtime_status",
      arguments: { colab_session: "named", timeout_sec: 21 },
    }),
  );
  const url = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_runtime_url",
      arguments: {},
    }),
  );

  assert.equal(list.isError, false);
  assert.equal(status.isError, false);
  assert.equal(url.isError, false);
  assert.deepEqual(payloads, {
    listSessions: [{ colabConfig: "/tmp/colab.json", timeoutSec: 20 }],
    runtimeStatus: [{ colabSession: "named", colabConfig: undefined, timeoutSec: 21 }],
    runtimeUrl: [{ colabSession: "codex-colab-bridge", colabConfig: undefined, timeoutSec: 120 }],
  });
});

test("Colab CLI transfer tools run locally without bridge config", async () => {
  const payloads: Record<string, unknown[]> = {
    uploadFile: [],
    downloadFile: [],
  };
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      uploadFile: async (payload) => {
        payloads.uploadFile.push(payload);
        return {
          command: ["uvx", "--from", "google-colab-cli", "colab", "upload", "-s", "named", "local.txt", "/content/remote.txt"],
          stdout: "Dry run only. No file was uploaded through google-colab-cli.\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 0,
          timed_out: false,
          truncated: false,
          dry_run: payload.dryRun,
        };
      },
      downloadFile: async (payload) => {
        payloads.downloadFile.push(payload);
        return {
          command: ["uvx", "--from", "google-colab-cli", "colab", "download", "-s", "codex-colab-bridge", "/content/out.txt", "out.txt"],
          stdout: "downloaded\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 7,
          timed_out: false,
          truncated: false,
          dry_run: payload.dryRun,
        };
      },
    }),
  );

  const upload = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_upload_file",
      arguments: {
        local_path: "local.txt",
        remote_path: "/content/remote.txt",
        colab_session: "named",
        dry_run: true,
        timeout_sec: 300,
      },
    }),
  );
  const download = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_download_file",
      arguments: {
        remote_path: "/content/out.txt",
        local_path: "out.txt",
        timeout_sec: 301,
      },
    }),
  );

  assert.equal(upload.isError, false);
  assert.equal(download.isError, false);
  assert.deepEqual(payloads, {
    uploadFile: [
      {
        localPath: "local.txt",
        remotePath: "/content/remote.txt",
        colabSession: "named",
        colabConfig: undefined,
        timeoutSec: 300,
        dryRun: true,
      },
    ],
    downloadFile: [
      {
        localPath: "out.txt",
        remotePath: "/content/out.txt",
        colabSession: "codex-colab-bridge",
        colabConfig: undefined,
        timeoutSec: 301,
        dryRun: false,
      },
    ],
  });
});

test("new local Colab tools validate arguments before running", async () => {
  let runs = 0;
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      doctor: async () => {
        runs += 1;
        throw new Error("should not run");
      },
      runtimeStatus: async () => {
        runs += 1;
        throw new Error("should not run");
      },
      uploadFile: async () => {
        runs += 1;
        throw new Error("should not run");
      },
      downloadFile: async () => {
        runs += 1;
        throw new Error("should not run");
      },
    }),
  );

  const doctor = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_doctor",
      arguments: { timeout_sec: 0 },
    }),
  );
  const status = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_runtime_status",
      arguments: { colab_session: "" },
    }),
  );
  const upload = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_upload_file",
      arguments: { local_path: "local.txt" },
    }),
  );
  const download = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_download_file",
      arguments: { remote_path: "/content/out.txt", local_path: "out.txt", timeout_sec: 1801 },
    }),
  );

  assert.equal(doctor.structuredContent.error?.code, "INVALID_ARGUMENT");
  assert.equal(status.structuredContent.error?.code, "INVALID_ARGUMENT");
  assert.equal(upload.structuredContent.error?.code, "INVALID_ARGUMENT");
  assert.equal(download.structuredContent.error?.code, "INVALID_ARGUMENT");
  assert.equal(runs, 0);
});

test("colab_reconnect_runner runs locally without bridge config", async () => {
  const payloads: unknown[] = [];
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      reconnectRunner: async (payload) => {
        payloads.push(payload);
        return {
          command: ["node", "scripts/reconnect-runner.mjs", "--dry-run"],
          stdout: "Runner reconnect dry run completed.",
          stderr: "",
          exit_code: 0,
          duration_ms: 5,
          timed_out: false,
          truncated: false,
          dry_run: payload.dryRun,
        };
      },
    }),
  );

  const response = await send(transport, "tools/call", {
    name: "colab_reconnect_runner",
    arguments: {
      colab_session: "named",
      colab_config: "/tmp/colab.json",
      project_root: "/content/custom",
      timeout_sec: 90,
      dry_run: true,
    },
  });
  const result = callToolResult(response);
  const data = result.structuredContent.data as {
    exit_code: number;
    dry_run: boolean;
  };

  assert.equal(result.isError, false);
  assert.equal(data.exit_code, 0);
  assert.equal(data.dry_run, true);
  assert.deepEqual(payloads, [
    {
      colabSession: "named",
      colabConfig: "/tmp/colab.json",
      projectRoot: "/content/custom",
      timeoutSec: 90,
      dryRun: true,
    },
  ]);
});

test("colab_reconnect_runner validates arguments before running locally", async () => {
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      reconnectRunner: async () => {
        throw new Error("should not run");
      },
    }),
  );

  const response = await send(transport, "tools/call", {
    name: "colab_reconnect_runner",
    arguments: { timeout_sec: 0 },
  });
  const result = callToolResult(response);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, "INVALID_ARGUMENT");
});

test("colab_setup_bridge runs packaged setup without bridge config and requires explicit confirmation", async () => {
  const payloads: unknown[] = [];
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      setupBridge: async (payload) => {
        payloads.push(payload);
        return {
          command: ["node", "scripts/setup-all.mjs", "--admin-secret", "<redacted>"],
          stdout: "Bridge setup completed.",
          stderr: "",
          exit_code: 0,
          duration_ms: 10,
          timed_out: false,
          truncated: false,
          dry_run: payload.dryRun,
        };
      },
    }),
  );

  const denied = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_setup_bridge",
      arguments: {},
    }),
  );
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error?.code, "INVALID_ARGUMENT");

  const response = await send(transport, "tools/call", {
    name: "colab_setup_bridge",
    arguments: {
      confirm_remote_code_execution: true,
      admin_secret: "secret-value",
      enable_dangerous_tools: true,
      gpu: "L4",
      colab_session: "agent-session",
      timeout_sec: 120,
    },
  });
  const result = callToolResult(response);

  assert.equal(result.isError, false);
  assert.deepEqual(payloads, [
    {
      dryRun: false,
      confirmRemoteCodeExecution: true,
      baseUrl: undefined,
      adminSecret: "secret-value",
      enableDangerousTools: true,
      bootstrap: true,
      smoke: true,
      gpu: "L4",
      colabSession: "agent-session",
      projectRoot: undefined,
      colabConfig: undefined,
      configPath: undefined,
      timeoutSec: 120,
    },
  ]);
});

test("colab_runtime_options runs locally without bridge config", async () => {
  const payloads: unknown[] = [];
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      runtimeOptions: async (payload) => {
        payloads.push(payload);
        return {
          source: "test",
          command: ["uvx", "--from", "google-colab-cli", "colab", "new", "--help"],
          availability: "test candidates",
          cpu: true,
          gpu: ["T4", "L4"],
          tpu: [],
          warnings: [],
          stdout: "{}",
          stderr: "",
          exit_code: 0,
          duration_ms: 3,
          timed_out: false,
          truncated: false,
        };
      },
    }),
  );

  const response = await send(transport, "tools/call", {
    name: "colab_runtime_options",
    arguments: { colab_config: "/tmp/colab.json", timeout_sec: 30 },
  });
  const result = callToolResult(response);
  const data = result.structuredContent.data as { gpu: string[] };

  assert.equal(result.isError, false);
  assert.deepEqual(data.gpu, ["T4", "L4"]);
  assert.deepEqual(payloads, [{ colabConfig: "/tmp/colab.json", timeoutSec: 30 }]);
});

test("colab_stop_runtime validates confirmation and runs locally without bridge config", async () => {
  const payloads: unknown[] = [];
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      stopRuntime: async (payload) => {
        payloads.push(payload);
        return {
          command: ["node", "scripts/stop-runtime.mjs", "--yes"],
          stdout: "Runtime stop completed.",
          stderr: "",
          exit_code: 0,
          duration_ms: 8,
          timed_out: false,
          truncated: false,
          dry_run: payload.dryRun,
        };
      },
    }),
  );

  const denied = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_stop_runtime",
      arguments: {},
    }),
  );
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error?.code, "INVALID_ARGUMENT");

  const response = await send(transport, "tools/call", {
    name: "colab_stop_runtime",
    arguments: {
      confirm_runtime_stop: true,
      colab_session: "named",
      colab_config: "/tmp/colab.json",
      timeout_sec: 45,
    },
  });
  const result = callToolResult(response);

  assert.equal(result.isError, false);
  assert.deepEqual(payloads, [
    {
      dryRun: false,
      confirmRuntimeStop: true,
      colabSession: "named",
      colabConfig: "/tmp/colab.json",
      timeoutSec: 45,
    },
  ]);
});

test("colab_recreate_runtime validates confirmation and runs locally without bridge config", async () => {
  const payloads: unknown[] = [];
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      recreateRuntime: async (payload) => {
        payloads.push(payload);
        return {
          command: ["node", "scripts/recreate-runtime.mjs", "--gpu", payload.gpu],
          stdout: "Runtime recreation completed.",
          stderr: "",
          exit_code: 0,
          duration_ms: 12,
          timed_out: false,
          truncated: false,
          dry_run: payload.dryRun,
        };
      },
    }),
  );

  const denied = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_recreate_runtime",
      arguments: { gpu: "T4" },
    }),
  );
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error?.code, "INVALID_ARGUMENT");

  const response = await send(transport, "tools/call", {
    name: "colab_recreate_runtime",
    arguments: {
      gpu: "none",
      confirm_runtime_recreation: true,
      skip_stop: true,
      enable_dangerous_tools: false,
      timeout_sec: 240,
    },
  });
  const result = callToolResult(response);

  assert.equal(result.isError, false);
  assert.deepEqual(payloads, [
    {
      gpu: "none",
      dryRun: false,
      confirmRuntimeRecreation: true,
      skipStop: true,
      smoke: true,
      enableDangerousTools: false,
      colabSession: undefined,
      projectRoot: undefined,
      colabConfig: undefined,
      configPath: undefined,
      baseUrl: undefined,
      adminSecret: undefined,
      timeoutSec: 240,
    },
  ]);
});

test("duplicate MCP calls generate fresh HTTP nonce values", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const nonces: string[] = [];
  const recordingHandler: BridgeHttpHandler = async (request) => {
    nonces.push(request.headers.get("x-bridge-nonce") ?? "");
    return handler(request);
  };
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({ config: serverConfig(session), httpHandler: recordingHandler }),
  );

  const first = callToolResult(await send(transport, "tools/call", { name: "colab_status", arguments: {} }));
  const second = callToolResult(await send(transport, "tools/call", { name: "colab_status", arguments: {} }));

  assert.equal(first.isError, false);
  assert.equal(second.isError, false);
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
});

test("disabled dangerous tool returns TOOL_DISABLED MCP error result", async () => {
  const transport = new InMemoryMcpTransport(new ColabMcpServer());

  const shellResponse = await send(transport, "tools/call", {
    name: "colab_run_shell",
    arguments: { command: "echo no" },
  });
  const shellResult = callToolResult(shellResponse);

  assert.equal(shellResult.isError, true);
  assert.equal(shellResult.structuredContent.error?.code, "TOOL_DISABLED");

  const writeResponse = await send(transport, "tools/call", {
    name: "colab_write_file",
    arguments: { path: "blocked.txt", content: "no", mode: "overwrite" },
  });
  const writeResult = callToolResult(writeResponse);

  assert.equal(writeResult.isError, true);
  assert.equal(writeResult.structuredContent.error?.code, "TOOL_DISABLED");

  const startResponse = await send(transport, "tools/call", {
    name: "colab_start_job",
    arguments: { command: "echo no" },
  });
  const startResult = callToolResult(startResponse);

  assert.equal(startResult.isError, true);
  assert.equal(startResult.structuredContent.error?.code, "TOOL_DISABLED");

  const interruptResponse = await send(transport, "tools/call", {
    name: "colab_interrupt_job",
    arguments: { job_id: "job_missing" },
  });
  const interruptResult = callToolResult(interruptResponse);

  assert.equal(interruptResult.isError, true);
  assert.equal(interruptResult.structuredContent.error?.code, "TOOL_DISABLED");
});

test("enabled dangerous MCP tools execute through the HTTP command path", async () => {
  const { broker, handler } = createHarness({ enableDangerousTools: true });
  const session = await createSession(handler);
  const runner = attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({
      config: serverConfig(session, { enableDangerousTools: true }),
      httpHandler: handler,
    }),
  );

  const shell = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_run_shell",
      arguments: { command: "printf mcp-shell" },
    }),
  );
  const shellData = shell.structuredContent.data as {
    type: string;
    result_payload: { stdout: string; exit_code: number };
  };
  assert.equal(shell.isError, false);
  assert.equal(shellData.type, "run_shell");
  assert.equal(shellData.result_payload.stdout, "mcp-shell");
  assert.equal(shellData.result_payload.exit_code, 0);

  const python = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_run_python",
      arguments: { code: "print('mcp-python')" },
    }),
  );
  const pythonData = python.structuredContent.data as {
    type: string;
    result_payload: { stdout: string; exit_code: number };
  };
  assert.equal(python.isError, false);
  assert.equal(pythonData.type, "run_python");
  assert.equal(pythonData.result_payload.stdout, "mcp-python\n");
  assert.equal(pythonData.result_payload.exit_code, 0);

  const write = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_write_file",
      arguments: { path: "mcp.txt", content: "mcp-file", mode: "overwrite" },
    }),
  );
  const writeData = write.structuredContent.data as {
    type: string;
    result_payload: { path: string; bytes_written: number; mode: string };
  };
  assert.equal(write.isError, false);
  assert.equal(writeData.type, "write_file");
  assert.deepEqual(writeData.result_payload, {
    path: "mcp.txt",
    bytes_written: 8,
    mode: "overwrite",
  });
  assert.equal(await readFile(join(runner.projectRoot, "mcp.txt"), "utf8"), "mcp-file");

  const start = callToolResult(
    await send(transport, "tools/call", {
      name: "colab_start_job",
      arguments: { command: "printf mcp-job" },
    }),
  );
  const startData = start.structuredContent.data as {
    type: string;
    result_payload: { job_id: string; status: string; started_at: string };
  };
  assert.equal(start.isError, false);
  assert.equal(startData.type, "start_job");
  assert.equal(startData.result_payload.status, "running");
  assert.equal(startData.result_payload.job_id.startsWith("job_"), true);
});

test("MCP dangerous tool stays disabled when HTTP is enabled but local config is not", async () => {
  const { broker, handler } = createHarness({ enableDangerousTools: true });
  const session = await createSession(handler);
  attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
  );

  const response = await send(transport, "tools/call", {
    name: "colab_run_shell",
    arguments: { command: "printf no" },
  });
  const result = callToolResult(response);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, "TOOL_DISABLED");
});

test("colab_read_file works through MCP without dangerous enablement", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "colab-mcp-read-"));
  try {
    await writeFile(join(projectRoot, "logs.txt"), "abcdef", "utf8");
    const { broker, handler } = createHarness();
    const session = await createSession(handler);
    attachFakeRunnerForTest({
      broker,
      sessionId: session.session_id,
      runnerToken: session.runner_token,
      options: { projectRoot },
    });
    const transport = new InMemoryMcpTransport(
      new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
    );

    const read = callToolResult(
      await send(transport, "tools/call", {
        name: "colab_read_file",
        arguments: { path: "logs.txt", max_bytes: 4 },
      }),
    );
    const data = read.structuredContent.data as {
      type: string;
      result_payload: { path: string; content: string; bytes_read: number; truncated: boolean };
    };

    assert.equal(read.isError, false);
    assert.equal(data.type, "read_file");
    assert.deepEqual(data.result_payload, {
      path: "logs.txt",
      content: "abcd",
      bytes_read: 4,
      truncated: true,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("colab_tail_job works through MCP without dangerous enablement", async () => {
  const { broker, handler } = createHarness({ enableDangerousTools: true });
  const session = await createSession(handler);
  attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const setupTransport = new InMemoryMcpTransport(
    new ColabMcpServer({
      config: serverConfig(session, { enableDangerousTools: true }),
      httpHandler: handler,
    }),
  );

  const start = callToolResult(
    await send(setupTransport, "tools/call", {
      name: "colab_start_job",
      arguments: { command: "printf tail-mcp" },
    }),
  );
  const startData = start.structuredContent.data as {
    result_payload: { job_id: string };
  };

  const tailTransport = new InMemoryMcpTransport(
    new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
  );
  const tail = callToolResult(
    await send(tailTransport, "tools/call", {
      name: "colab_tail_job",
      arguments: { job_id: startData.result_payload.job_id },
    }),
  );
  const tailData = tail.structuredContent.data as {
    type: string;
    result_payload: { job_id: string; events: unknown[] };
  };

  assert.equal(tail.isError, false);
  assert.equal(tailData.type, "tail_job");
  assert.equal(tailData.result_payload.job_id, startData.result_payload.job_id);
});

test("colab_list_jobs and colab_job_status work through MCP without dangerous enablement", async () => {
  const { broker, handler } = createHarness({ enableDangerousTools: true });
  const session = await createSession(handler);
  attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const setupTransport = new InMemoryMcpTransport(
    new ColabMcpServer({
      config: serverConfig(session, { enableDangerousTools: true }),
      httpHandler: handler,
    }),
  );
  let jobId: string | null = null;

  try {
    const start = callToolResult(
      await send(setupTransport, "tools/call", {
        name: "colab_start_job",
        arguments: {
          command: nodeCommand("console.log('mcp-secret-log'); setInterval(() => {}, 1000);"),
          name: "mcp-summary-job",
        },
      }),
    );
    const startData = start.structuredContent.data as {
      result_payload: { job_id: string };
    };
    jobId = startData.result_payload.job_id;

    const readOnlyTransport = new InMemoryMcpTransport(
      new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
    );
    const list = callToolResult(
      await send(readOnlyTransport, "tools/call", {
        name: "colab_list_jobs",
        arguments: {},
      }),
    );
    const listData = list.structuredContent.data as {
      type: string;
      result_payload: { jobs: JobSummary[] };
    };

    assert.equal(list.isError, false);
    assert.equal(listData.type, "list_jobs");
    assert.equal(listData.result_payload.jobs.length, 1);
    assertMcpJobSummary(listData.result_payload.jobs[0], jobId, true);

    const status = callToolResult(
      await send(readOnlyTransport, "tools/call", {
        name: "colab_job_status",
        arguments: { job_id: jobId },
      }),
    );
    const statusData = status.structuredContent.data as {
      type: string;
      result_payload: JobSummary;
    };

    assert.equal(status.isError, false);
    assert.equal(statusData.type, "job_status");
    assertMcpJobSummary(statusData.result_payload, jobId, true);
    assert.equal(JSON.stringify(listData.result_payload).includes("mcp-secret-log"), false);
    assert.equal(JSON.stringify(statusData.result_payload).includes("mcp-secret-log"), false);
  } finally {
    if (jobId) {
      await send(setupTransport, "tools/call", {
        name: "colab_interrupt_job",
        arguments: { job_id: jobId, signal: "SIGKILL", kill_after_sec: 0 },
      });
    }
  }
});

test("tools/call accepts MCP _meta object as argument carrier", async () => {
  const transport = new InMemoryMcpTransport(new ColabMcpServer());

  const response = await send(transport, "tools/call", {
    name: "colab_run_shell",
    _meta: { command: "echo no" },
  });
  const result = callToolResult(response);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, "TOOL_DISABLED");
});

test("unknown tool returns a consistent MCP tool error result", async () => {
  const transport = new InMemoryMcpTransport(new ColabMcpServer());

  const response = await send(transport, "tools/call", { name: "colab_missing", arguments: {} });
  const result = callToolResult(response);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, "INVALID_ARGUMENT");
});

test("missing config and invalid controller auth return sanitized MCP error results", async () => {
  const missingConfig = new InMemoryMcpTransport(new ColabMcpServer());
  const missingConfigResult = callToolResult(
    await send(missingConfig, "tools/call", { name: "colab_status", arguments: {} }),
  );
  assert.equal(missingConfigResult.isError, true);
  assert.equal(missingConfigResult.structuredContent.error?.code, "UNAUTHORIZED");

  const { handler } = createHarness();
  const session = await createSession(handler);
  const invalidAuth = new InMemoryMcpTransport(
    new ColabMcpServer({
      config: { ...serverConfig(session), controllerToken: "wrong_token_value" },
      httpHandler: handler,
    }),
  );
  const invalidAuthResult = callToolResult(
    await send(invalidAuth, "tools/call", { name: "colab_status", arguments: {} }),
  );

  assert.equal(invalidAuthResult.isError, true);
  assert.equal(invalidAuthResult.structuredContent.error?.code, "UNAUTHORIZED");
  assert.equal(invalidAuthResult.content[0]?.text.includes("wrong_token_value"), false);
});

test("local config parser accepts worker_url as the base URL alias", () => {
  assert.deepEqual(
    parseLocalBridgeConfig({
      worker_url: "https://worker.example",
      session_id: "sess_test",
      controller_token: "br_test",
    }),
    {
      baseUrl: "https://worker.example",
      sessionId: "sess_test",
      controllerToken: "br_test",
      enableDangerousTools: false,
    },
  );
});

test("local config parser accepts explicit dangerous tool enablement flags", () => {
  assert.equal(
    parseLocalBridgeConfig({
      worker_url: "https://worker.example",
      session_id: "sess_test",
      controller_token: "br_test",
      enable_dangerous_tools: "1",
    }).enableDangerousTools,
    true,
  );
});

test("local config loader applies env dangerous flag over JSON config file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "colab-mcp-config-"));
  const configPath = join(directory, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        worker_url: "https://worker.example",
        session_id: "sess_test",
        controller_token: "br_test",
      }),
      "utf8",
    );

    assert.deepEqual(
      loadLocalBridgeConfig({
        configPath,
        env: {
          COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS: "1",
        },
      }),
      {
        baseUrl: "https://worker.example",
        sessionId: "sess_test",
        controllerToken: "br_test",
        enableDangerousTools: true,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
