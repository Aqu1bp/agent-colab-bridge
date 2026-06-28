import test from "node:test";
import assert from "node:assert/strict";
import { SessionBroker } from "../src/broker.js";
import {
  attachFakeRunnerForTest,
  createBridgeHttpHandler,
  type BridgeHttpHandler,
} from "../src/http.js";
import { parseLocalBridgeConfig, type LocalBridgeConfig } from "../src/mcp-config.js";
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

function createHarness(): { broker: SessionBroker; handler: BridgeHttpHandler } {
  const broker = new SessionBroker();
  const handler = createBridgeHttpHandler({ broker, adminSecret });
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

function serverConfig(session: CreatedSession): LocalBridgeConfig {
  return {
    baseUrl,
    sessionId: session.session_id,
    controllerToken: session.controller_token,
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
  assert.equal(result.serverInfo.name, "colab-mcp-bridge");
});

test("tools/list includes disabled dangerous tools with schemas and annotations", async () => {
  const transport = new InMemoryMcpTransport(new ColabMcpServer());

  const response = await send(transport, "tools/list");
  const result = response.result as { tools: Array<Record<string, unknown>> };
  const runShell = result.tools.find((tool) => tool.name === "colab_run_shell");

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

  const response = await send(transport, "tools/call", {
    name: "colab_run_shell",
    arguments: { command: "echo no" },
  });
  const result = callToolResult(response);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, "TOOL_DISABLED");
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
    },
  );
});
