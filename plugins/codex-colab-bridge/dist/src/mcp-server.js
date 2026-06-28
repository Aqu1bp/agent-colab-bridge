import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { pathToFileURL } from "node:url";
import { bridgeError, normalizeForegroundRunPayload, normalizeInterruptJobPayload, normalizeReadFilePayload, normalizeStartJobPayload, normalizeTailJobPayload, normalizeWriteFilePayload, } from "./protocol.js";
import { callToolError, callToolSuccess, disabledToolResult, isEnabledDangerousExecutionTool, toolByName, toolDefinitions, } from "./mcp.js";
import { BridgeHttpClient } from "./mcp-client.js";
import { BridgeConfigError, loadLocalBridgeConfig, } from "./mcp-config.js";
export class ColabMcpServer {
    options;
    config;
    constructor(options = {}) {
        this.options = options;
        this.config = options.config;
    }
    async handleJsonRpcMessage(message) {
        if (Array.isArray(message)) {
            if (message.length === 0) {
                return jsonRpcError(null, -32600, "Invalid Request");
            }
            const responses = await Promise.all(message.map((item) => this.handleSingleMessage(item)));
            const filtered = responses.filter((response) => response !== undefined);
            return filtered.length > 0 ? filtered : undefined;
        }
        return this.handleSingleMessage(message);
    }
    async handleSingleMessage(message) {
        if (!isJsonRpcRequest(message)) {
            return jsonRpcError(null, -32600, "Invalid Request");
        }
        const id = message.id ?? null;
        const isNotification = !("id" in message);
        try {
            const result = await this.dispatch(message.method, message.params);
            return isNotification ? undefined : jsonRpcSuccess(id, result);
        }
        catch (error) {
            const rpcError = toJsonRpcDispatchError(error);
            return isNotification ? undefined : jsonRpcError(id, rpcError.code, rpcError.message);
        }
    }
    async dispatch(method, params) {
        if (method === "initialize") {
            return {
                protocolVersion: "2025-11-25",
                capabilities: {
                    tools: {},
                },
                serverInfo: {
                    name: "codex-colab-bridge",
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
    async callTool(params) {
        try {
            const tool = toolByName(params.name);
            if (!tool) {
                return callToolError(bridgeError("INVALID_ARGUMENT", `Unknown MCP tool: ${params.name}.`, false));
            }
            if (!tool.enabledByDefault && !this.isToolEnabledByLocalPolicy(tool.name)) {
                return disabledToolResult(params.name);
            }
            if (tool.name === "colab_status") {
                const response = await this.clientRequest((client) => client.getStatus());
                if (!response.ok) {
                    return callToolError(response.error ?? bridgeError("INTERNAL_ERROR", "Bridge status failed.", false));
                }
                const runnerConnected = response.data &&
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
                    return callToolError(response.error ?? bridgeError("INTERNAL_ERROR", "Bridge GPU status failed.", false));
                }
                const command = response.data;
                if (command?.error) {
                    return callToolError(command.error);
                }
                return callToolSuccess("GPU status command succeeded.", command);
            }
            if (tool.name === "colab_run_shell" || tool.name === "colab_run_python") {
                let payload;
                try {
                    payload = normalizeForegroundRunPayload(tool.name === "colab_run_shell" ? "run_shell" : "run_python", params.arguments);
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const response = await this.clientRequest((client) => tool.name === "colab_run_shell"
                    ? client.createRunShellCommand(payload)
                    : client.createRunPythonCommand(payload));
                if (!response.ok) {
                    return callToolError(response.error ?? bridgeError("INTERNAL_ERROR", "Bridge foreground command failed.", false));
                }
                const command = response.data;
                if (command?.error) {
                    return callToolError(command.error);
                }
                return callToolSuccess("Foreground command completed.", command);
            }
            if (tool.name === "colab_write_file" || tool.name === "colab_read_file") {
                let payload;
                try {
                    payload =
                        tool.name === "colab_write_file"
                            ? normalizeWriteFilePayload(params.arguments)
                            : normalizeReadFilePayload(params.arguments);
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const response = await this.clientRequest((client) => tool.name === "colab_write_file"
                    ? client.createWriteFileCommand(payload)
                    : client.createReadFileCommand(payload));
                if (!response.ok) {
                    return callToolError(response.error ?? bridgeError("INTERNAL_ERROR", "Bridge file command failed.", false));
                }
                const command = response.data;
                if (command?.error) {
                    return callToolError(command.error);
                }
                return callToolSuccess("File command completed.", command);
            }
            if (tool.name === "colab_start_job" ||
                tool.name === "colab_tail_job" ||
                tool.name === "colab_interrupt_job") {
                let payload;
                try {
                    if (tool.name === "colab_start_job") {
                        payload = normalizeStartJobPayload(params.arguments);
                    }
                    else if (tool.name === "colab_tail_job") {
                        payload = normalizeTailJobPayload(params.arguments);
                    }
                    else {
                        payload = normalizeInterruptJobPayload(params.arguments);
                    }
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const response = await this.clientRequest((client) => {
                    if (tool.name === "colab_start_job") {
                        return client.createStartJobCommand(payload);
                    }
                    if (tool.name === "colab_tail_job") {
                        return client.createTailJobCommand(payload);
                    }
                    return client.createInterruptJobCommand(payload);
                });
                if (!response.ok) {
                    return callToolError(response.error ?? bridgeError("INTERNAL_ERROR", "Bridge background job command failed.", false));
                }
                const command = response.data;
                if (command?.error) {
                    return callToolError(command.error);
                }
                const text = tool.name === "colab_start_job"
                    ? "Background job started."
                    : tool.name === "colab_tail_job"
                        ? "Background job tail returned."
                        : "Background job interrupt completed.";
                return callToolSuccess(text, command);
            }
            return disabledToolResult(params.name);
        }
        catch (error) {
            if (error instanceof BridgeConfigError) {
                return callToolError(bridgeError("UNAUTHORIZED", error.message, false));
            }
            return callToolError(bridgeError("INTERNAL_ERROR", "MCP tool call failed.", false));
        }
    }
    async clientRequest(request) {
        const config = this.resolveConfig();
        const client = new BridgeHttpClient(config, {
            ...this.options.httpClientOptions,
            handler: this.options.httpHandler,
        });
        return request(client);
    }
    resolveConfig() {
        if (this.config) {
            return this.config;
        }
        if (!this.options.configLoader) {
            throw new BridgeConfigError("Missing MCP bridge config. Provide base_url, session_id, and controller_token.");
        }
        this.config = this.options.configLoader();
        return this.config;
    }
    isToolEnabledByLocalPolicy(toolName) {
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
    server;
    constructor(server) {
        this.server = server;
    }
    async send(message) {
        return this.server.handleJsonRpcMessage(message);
    }
}
export async function runStdioMcpServer(options = {}) {
    const server = new ColabMcpServer({
        configLoader: loadLocalBridgeConfig,
        ...options,
    });
    const lines = createInterface({ input: processStdin });
    for await (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            processStdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
            continue;
        }
        const response = await server.handleJsonRpcMessage(parsed);
        if (response !== undefined) {
            processStdout.write(`${JSON.stringify(response)}\n`);
        }
    }
}
function parseToolCallParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new JsonRpcDispatchError(-32602, "Invalid params");
    }
    const record = params;
    if (typeof record.name !== "string" || !record.name.trim()) {
        throw new JsonRpcDispatchError(-32602, "Invalid params");
    }
    const toolArguments = record.arguments ?? record._meta ?? {};
    if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {
        throw new JsonRpcDispatchError(-32602, "Invalid params");
    }
    return {
        name: record.name,
        arguments: toolArguments,
    };
}
function isJsonRpcRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    const id = record.id;
    return (record.jsonrpc === "2.0" &&
        typeof record.method === "string" &&
        (id === undefined || id === null || typeof id === "string" || typeof id === "number"));
}
function jsonRpcSuccess(id, result) {
    return {
        jsonrpc: "2.0",
        id,
        result,
    };
}
function jsonRpcError(id, code, message) {
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
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function toJsonRpcDispatchError(error) {
    if (error instanceof JsonRpcDispatchError) {
        return error;
    }
    if (error instanceof BridgeConfigError) {
        return new JsonRpcDispatchError(-32603, error.message);
    }
    return new JsonRpcDispatchError(-32603, "Internal error");
}
function isBridgeErrorLike(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (typeof record.code === "string" &&
        typeof record.message === "string" &&
        typeof record.retryable === "boolean");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runStdioMcpServer();
}
