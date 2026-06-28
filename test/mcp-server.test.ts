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
  const runShell = result.tools.find((tool) => tool.name === "colab_run_shell");
  const writeTool = result.tools.find((tool) => tool.name === "colab_write_file");
  const readTool = result.tools.find((tool) => tool.name === "colab_read_file");
  const startJob = result.tools.find((tool) => tool.name === "colab_start_job");
  const tailJob = result.tools.find((tool) => tool.name === "colab_tail_job");
  const interruptJob = result.tools.find((tool) => tool.name === "colab_interrupt_job");
  const reconnectRunner = result.tools.find((tool) => tool.name === "colab_reconnect_runner");
  const setupBridge = result.tools.find((tool) => tool.name === "colab_setup_bridge");
  const runtimeOptions = result.tools.find((tool) => tool.name === "colab_runtime_options");
  const recreateRuntime = result.tools.find((tool) => tool.name === "colab_recreate_runtime");

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

test("colab_ping creates a ping command and returns the serialized command result", async () => {
  const { broker, handler } = createHarness();
  const session = await createSession(handler);
  attachFakeRunnerForTest({ broker, sessionId: session.session_id, runnerToken: session.runner_token });
  const transport = new InMemoryMcpTransport(
    new ColabMcpServer({ config: serverConfig(session), httpHandler: handler }),
  );

  const response = await send(transport, "tools/call", { name: "colab_ping", arguments: {} });
  const result = callToolResult(response);
  const data = result.structuredContent.data as {
    type: string;
    state: string;
    result_payload: unknown;
  };

  assert.equal(result.isError, false);
  assert.equal(data.type, "ping");
  assert.equal(data.state, "succeeded");
  assert.deepEqual(data.result_payload, { ok: true, pong: true });
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
