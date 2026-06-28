import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { pathToFileURL } from "node:url";
import {
  bridgeError,
  normalizeForegroundRunPayload,
  type BridgeError,
  type RunPythonPayload,
  type RunShellPayload,
} from "./protocol.js";
import { type BridgeHttpHandler } from "./http.js";
import {
  callToolError,
  callToolSuccess,
  disabledToolResult,
  isEnabledDangerousExecutionTool,
  toolByName,
  toolDefinitions,
  type CallToolResult,
} from "./mcp.js";
import { BridgeHttpClient, type BridgeHttpClientOptions } from "./mcp-client.js";
import {
  BridgeConfigError,
  loadLocalBridgeConfig,
  type LocalBridgeConfig,
} from "./mcp-config.js";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface ColabMcpServerOptions {
  config?: LocalBridgeConfig;
  configLoader?: () => LocalBridgeConfig;
  enableDangerousTools?: boolean;
  httpHandler?: BridgeHttpHandler;
  httpClientOptions?: Omit<BridgeHttpClientOptions, "handler">;
}

export class ColabMcpServer {
  private config?: LocalBridgeConfig;

  constructor(private readonly options: ColabMcpServerOptions = {}) {
    this.config = options.config;
  }

  async handleJsonRpcMessage(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return jsonRpcError(null, -32600, "Invalid Request");
      }

      const responses = await Promise.all(message.map((item) => this.handleSingleMessage(item)));
      const filtered = responses.filter((response): response is JsonRpcResponse => response !== undefined);
      return filtered.length > 0 ? filtered : undefined;
    }

    return this.handleSingleMessage(message);
  }

  private async handleSingleMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isJsonRpcRequest(message)) {
      return jsonRpcError(null, -32600, "Invalid Request");
    }

    const id = message.id ?? null;
    const isNotification = !("id" in message);

    try {
      const result = await this.dispatch(message.method, message.params);
      return isNotification ? undefined : jsonRpcSuccess(id, result);
    } catch (error) {
      const rpcError = toJsonRpcDispatchError(error);
      return isNotification ? undefined : jsonRpcError(id, rpcError.code, rpcError.message);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "colab-mcp-bridge",
          version: "0.1.0",
        },
      };
    }

    if (method === "tools/list") {
      return {
        tools: toolDefinitions.map(({ enabledByDefault: _enabledByDefault, ...tool }) => tool),
      };
    }

    if (method === "tools/call") {
      return this.callTool(parseToolCallParams(params));
    }

    throw new JsonRpcDispatchError(-32601, "Method not found");
  }

  private async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult> {
    try {
      const tool = toolByName(params.name);
      if (!tool) {
        return callToolError(
          bridgeError("INVALID_ARGUMENT", `Unknown MCP tool: ${params.name}.`, false),
        );
      }

      if (!tool.enabledByDefault && !this.isToolEnabledByLocalPolicy(tool.name)) {
        return disabledToolResult(params.name);
      }

      if (tool.name === "colab_status") {
        const response = await this.clientRequest((client) => client.getStatus());
        if (!response.ok) {
          return callToolError(response.error ?? bridgeError("INTERNAL_ERROR", "Bridge status failed.", false));
        }

        const runnerConnected =
          response.data &&
          typeof response.data === "object" &&
          "runner_connected" in response.data &&
          response.data.runner_connected === true;
        return callToolSuccess(runnerConnected ? "Runner connected." : "Runner offline.", response.data);
      }

      if (tool.name === "colab_ping") {
        const response = await this.clientRequest((client) => client.createPingCommand());
        if (!response.ok) {
          return callToolError(response.error ?? bridgeError("INTERNAL_ERROR", "Bridge ping failed.", false));
        }

        const command = response.data;
        if (command?.error) {
          return callToolError(command.error);
        }

        return callToolSuccess("Ping command succeeded.", command);
      }

      if (tool.name === "colab_gpu_status") {
        const response = await this.clientRequest((client) => client.createGpuStatusCommand());
        if (!response.ok) {
          return callToolError(
            response.error ?? bridgeError("INTERNAL_ERROR", "Bridge GPU status failed.", false),
          );
        }

        const command = response.data;
        if (command?.error) {
          return callToolError(command.error);
        }

        return callToolSuccess("GPU status command succeeded.", command);
      }

      if (tool.name === "colab_run_shell" || tool.name === "colab_run_python") {
        let payload: RunShellPayload | RunPythonPayload;
        try {
          payload = normalizeForegroundRunPayload(
            tool.name === "colab_run_shell" ? "run_shell" : "run_python",
            params.arguments,
          );
        } catch (error) {
          if (isBridgeErrorLike(error)) {
            return callToolError(error);
          }
          throw error;
        }

        const response = await this.clientRequest((client) =>
          tool.name === "colab_run_shell"
            ? client.createRunShellCommand(payload as RunShellPayload)
            : client.createRunPythonCommand(payload as RunPythonPayload),
        );
        if (!response.ok) {
          return callToolError(
            response.error ?? bridgeError("INTERNAL_ERROR", "Bridge foreground command failed.", false),
          );
        }

        const command = response.data;
        if (command?.error) {
          return callToolError(command.error);
        }

        return callToolSuccess("Foreground command completed.", command);
      }

      return disabledToolResult(params.name);
    } catch (error) {
      if (error instanceof BridgeConfigError) {
        return callToolError(bridgeError("UNAUTHORIZED", error.message, false));
      }

      return callToolError(bridgeError("INTERNAL_ERROR", "MCP tool call failed.", false));
    }
  }

  private async clientRequest<TData>(
    request: (client: BridgeHttpClient) => Promise<{ ok: boolean; data: TData | null; error: BridgeError | null }>,
  ): Promise<{ ok: boolean; data: TData | null; error: BridgeError | null }> {
    const config = this.resolveConfig();
    const client = new BridgeHttpClient(config, {
      ...this.options.httpClientOptions,
      handler: this.options.httpHandler,
    });
    return request(client);
  }

  private resolveConfig(): LocalBridgeConfig {
    if (this.config) {
      return this.config;
    }

    if (!this.options.configLoader) {
      throw new BridgeConfigError(
        "Missing MCP bridge config. Provide base_url, session_id, and controller_token.",
      );
    }

    this.config = this.options.configLoader();
    return this.config;
  }

  private isToolEnabledByLocalPolicy(toolName: string): boolean {
    if (!isEnabledDangerousExecutionTool(toolName)) {
      return false;
    }

    if (this.options.enableDangerousTools !== undefined) {
      return this.options.enableDangerousTools;
    }

    if (this.config) {
      return this.config.enableDangerousTools;
    }

    if (!this.options.configLoader) {
      return false;
    }

    this.config = this.options.configLoader();
    return this.config.enableDangerousTools;
  }
}

export class InMemoryMcpTransport {
  constructor(private readonly server: ColabMcpServer) {}

  async send(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    return this.server.handleJsonRpcMessage(message);
  }
}

export async function runStdioMcpServer(options: ColabMcpServerOptions = {}): Promise<void> {
  const server = new ColabMcpServer({
    configLoader: loadLocalBridgeConfig,
    ...options,
  });
  const lines = createInterface({ input: processStdin });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      processStdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }

    const response = await server.handleJsonRpcMessage(parsed);
    if (response !== undefined) {
      processStdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

function parseToolCallParams(params: unknown): { name: string; arguments: Record<string, unknown> } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new JsonRpcDispatchError(-32602, "Invalid params");
  }

  const record = params as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new JsonRpcDispatchError(-32602, "Invalid params");
  }

  const toolArguments = record.arguments ?? record._meta ?? {};
  if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {
    throw new JsonRpcDispatchError(-32602, "Invalid params");
  }

  return {
    name: record.name,
    arguments: toolArguments as Record<string, unknown>,
  };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  return (
    record.jsonrpc === "2.0" &&
    typeof record.method === "string" &&
    (id === undefined || id === null || typeof id === "string" || typeof id === "number")
  );
}

function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

class JsonRpcDispatchError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function toJsonRpcDispatchError(error: unknown): JsonRpcDispatchError {
  if (error instanceof JsonRpcDispatchError) {
    return error;
  }

  if (error instanceof BridgeConfigError) {
    return new JsonRpcDispatchError(-32603, error.message);
  }

  return new JsonRpcDispatchError(-32603, "Internal error");
}

function isBridgeErrorLike(value: unknown): value is BridgeError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStdioMcpServer();
}
