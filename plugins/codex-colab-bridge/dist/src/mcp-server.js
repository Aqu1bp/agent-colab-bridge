import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bridgeError, normalizeForegroundRunPayload, normalizeInterruptJobPayload, normalizeReadFilePayload, normalizeStartJobPayload, normalizeTailJobPayload, normalizeWriteFilePayload, } from "./protocol.js";
import { callToolError, callToolSuccess, disabledToolResult, isEnabledDangerousExecutionTool, toolByName, toolDefinitions, } from "./mcp.js";
import { BridgeHttpClient } from "./mcp-client.js";
import { BridgeConfigError, loadLocalBridgeConfig, } from "./mcp-config.js";
const DEFAULT_RECONNECT_TIMEOUT_SEC = 60;
const MAX_RECONNECT_TIMEOUT_SEC = 300;
const DEFAULT_OPERATION_TIMEOUT_SEC = 900;
const MAX_OPERATION_TIMEOUT_SEC = 1800;
const DEFAULT_STOP_RUNTIME_TIMEOUT_SEC = 120;
const MAX_STOP_RUNTIME_TIMEOUT_SEC = 300;
const DEFAULT_RUNTIME_OPTIONS_TIMEOUT_SEC = 120;
const MAX_RUNTIME_OPTIONS_TIMEOUT_SEC = 300;
const LOCAL_COMMAND_OUTPUT_BYTES = 20 * 1024;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
            if (tool.name === "colab_reconnect_runner") {
                let payload;
                try {
                    payload = normalizeReconnectRunnerPayload(params.arguments);
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const result = await this.runReconnectRunner(payload);
                if (result.exit_code !== 0 || result.timed_out) {
                    return callToolError(bridgeError("INTERNAL_ERROR", `Colab runner reconnect failed${result.exit_code === null ? "" : ` with exit code ${result.exit_code}`}.`, true));
                }
                return callToolSuccess(payload.dryRun
                    ? "Runner reconnect dry run completed."
                    : "Runner reconnect command completed.", result);
            }
            if (tool.name === "colab_setup_bridge") {
                let payload;
                try {
                    payload = normalizeSetupBridgePayload(params.arguments);
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const result = await this.runSetupBridge(payload);
                if (result.exit_code !== 0 || result.timed_out) {
                    return callToolError(bridgeError("INTERNAL_ERROR", `Bridge setup failed${result.exit_code === null ? "" : ` with exit code ${result.exit_code}`}.`, true));
                }
                this.config = undefined;
                return callToolSuccess(payload.dryRun ? "Bridge setup dry run completed." : "Bridge setup completed.", result);
            }
            if (tool.name === "colab_runtime_options") {
                let payload;
                try {
                    payload = normalizeRuntimeOptionsPayload(params.arguments);
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const result = await this.runRuntimeOptions(payload);
                if (result.exit_code !== 0 || result.timed_out) {
                    return callToolError(bridgeError("INTERNAL_ERROR", `Colab runtime options check failed${result.exit_code === null ? "" : ` with exit code ${result.exit_code}`}.`, true));
                }
                return callToolSuccess("Runtime options returned.", result);
            }
            if (tool.name === "colab_stop_runtime") {
                let payload;
                try {
                    payload = normalizeStopRuntimePayload(params.arguments);
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const result = await this.runStopRuntime(payload);
                if (result.exit_code !== 0 || result.timed_out) {
                    return callToolError(bridgeError("INTERNAL_ERROR", `Colab runtime stop failed${result.exit_code === null ? "" : ` with exit code ${result.exit_code}`}.`, true));
                }
                this.config = undefined;
                return callToolSuccess(payload.dryRun ? "Runtime stop dry run completed." : "Runtime stop completed.", result);
            }
            if (tool.name === "colab_recreate_runtime") {
                let payload;
                try {
                    payload = normalizeRecreateRuntimePayload(params.arguments);
                }
                catch (error) {
                    if (isBridgeErrorLike(error)) {
                        return callToolError(error);
                    }
                    throw error;
                }
                const result = await this.runRecreateRuntime(payload);
                if (result.exit_code !== 0 || result.timed_out) {
                    return callToolError(bridgeError("INTERNAL_ERROR", `Colab runtime recreation failed${result.exit_code === null ? "" : ` with exit code ${result.exit_code}`}.`, true));
                }
                this.config = undefined;
                return callToolSuccess(payload.dryRun ? "Runtime recreation dry run completed." : "Runtime recreation completed.", result);
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
    async runReconnectRunner(payload) {
        if (this.options.reconnectRunner) {
            return this.options.reconnectRunner(payload);
        }
        return runReconnectRunnerScript(payload, this.options.packageRoot ?? PACKAGE_ROOT);
    }
    async runSetupBridge(payload) {
        if (this.options.setupBridge) {
            return this.options.setupBridge(payload);
        }
        return runSetupBridgeScript(payload, this.options.packageRoot ?? PACKAGE_ROOT);
    }
    async runRuntimeOptions(payload) {
        if (this.options.runtimeOptions) {
            return this.options.runtimeOptions(payload);
        }
        return runRuntimeOptionsScript(payload, this.options.packageRoot ?? PACKAGE_ROOT);
    }
    async runStopRuntime(payload) {
        if (this.options.stopRuntime) {
            return this.options.stopRuntime(payload);
        }
        return runStopRuntimeScript(payload, this.options.packageRoot ?? PACKAGE_ROOT);
    }
    async runRecreateRuntime(payload) {
        if (this.options.recreateRuntime) {
            return this.options.recreateRuntime(payload);
        }
        return runRecreateRuntimeScript(payload, this.options.packageRoot ?? PACKAGE_ROOT);
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
function normalizeReconnectRunnerPayload(args) {
    const colabSession = optionalString(args.colab_session, "colab_session");
    const colabConfig = optionalString(args.colab_config, "colab_config");
    const projectRoot = optionalString(args.project_root, "project_root");
    const timeoutSec = optionalNumber(args.timeout_sec, "timeout_sec") ?? DEFAULT_RECONNECT_TIMEOUT_SEC;
    const dryRun = optionalBoolean(args.dry_run, "dry_run") ?? false;
    if (timeoutSec <= 0 || timeoutSec > MAX_RECONNECT_TIMEOUT_SEC) {
        throw bridgeError("INVALID_ARGUMENT", `timeout_sec must be between 1 and ${MAX_RECONNECT_TIMEOUT_SEC}.`, false);
    }
    return {
        colabSession,
        colabConfig,
        projectRoot,
        timeoutSec,
        dryRun,
    };
}
function normalizeSetupBridgePayload(args) {
    const dryRun = optionalBoolean(args.dry_run, "dry_run") ?? false;
    const confirmRemoteCodeExecution = optionalBoolean(args.confirm_remote_code_execution, "confirm_remote_code_execution") ?? false;
    if (!dryRun && !confirmRemoteCodeExecution) {
        throw bridgeError("INVALID_ARGUMENT", "confirm_remote_code_execution must be true for live setup because this enables remote code execution inside Colab.", false);
    }
    const timeoutSec = normalizeOperationTimeout(args.timeout_sec, MAX_OPERATION_TIMEOUT_SEC);
    return {
        dryRun,
        confirmRemoteCodeExecution,
        baseUrl: optionalString(args.base_url, "base_url"),
        adminSecret: optionalString(args.admin_secret, "admin_secret"),
        enableDangerousTools: optionalBoolean(args.enable_dangerous_tools, "enable_dangerous_tools") ?? false,
        bootstrap: optionalBoolean(args.bootstrap, "bootstrap") ?? true,
        smoke: optionalBoolean(args.smoke, "smoke") ?? true,
        gpu: optionalString(args.gpu, "gpu"),
        colabSession: optionalString(args.colab_session, "colab_session"),
        projectRoot: optionalString(args.project_root, "project_root"),
        colabConfig: optionalString(args.colab_config, "colab_config"),
        configPath: optionalString(args.config, "config"),
        timeoutSec,
    };
}
function normalizeRuntimeOptionsPayload(args) {
    const timeoutSec = optionalNumber(args.timeout_sec, "timeout_sec") ?? DEFAULT_RUNTIME_OPTIONS_TIMEOUT_SEC;
    if (timeoutSec <= 0 || timeoutSec > MAX_RUNTIME_OPTIONS_TIMEOUT_SEC) {
        throw bridgeError("INVALID_ARGUMENT", `timeout_sec must be between 1 and ${MAX_RUNTIME_OPTIONS_TIMEOUT_SEC}.`, false);
    }
    return {
        colabConfig: optionalString(args.colab_config, "colab_config"),
        timeoutSec,
    };
}
function normalizeStopRuntimePayload(args) {
    const dryRun = optionalBoolean(args.dry_run, "dry_run") ?? false;
    const confirmRuntimeStop = optionalBoolean(args.confirm_runtime_stop, "confirm_runtime_stop") ?? false;
    if (!dryRun && !confirmRuntimeStop) {
        throw bridgeError("INVALID_ARGUMENT", "confirm_runtime_stop must be true because this stops the Colab runtime and loses active jobs.", false);
    }
    const timeoutSec = optionalNumber(args.timeout_sec, "timeout_sec") ?? DEFAULT_STOP_RUNTIME_TIMEOUT_SEC;
    if (timeoutSec <= 0 || timeoutSec > MAX_STOP_RUNTIME_TIMEOUT_SEC) {
        throw bridgeError("INVALID_ARGUMENT", `timeout_sec must be between 1 and ${MAX_STOP_RUNTIME_TIMEOUT_SEC}.`, false);
    }
    return {
        dryRun,
        confirmRuntimeStop,
        colabSession: optionalString(args.colab_session, "colab_session"),
        colabConfig: optionalString(args.colab_config, "colab_config"),
        timeoutSec,
    };
}
function normalizeRecreateRuntimePayload(args) {
    const gpu = optionalString(args.gpu, "gpu");
    if (!gpu) {
        throw bridgeError("INVALID_ARGUMENT", "gpu is required. Use \"none\" for a CPU runtime.", false);
    }
    const dryRun = optionalBoolean(args.dry_run, "dry_run") ?? false;
    const confirmRuntimeRecreation = optionalBoolean(args.confirm_runtime_recreation, "confirm_runtime_recreation") ?? false;
    if (!dryRun && !confirmRuntimeRecreation) {
        throw bridgeError("INVALID_ARGUMENT", "confirm_runtime_recreation must be true because this stops the Colab runtime and loses active jobs.", false);
    }
    return {
        gpu,
        dryRun,
        confirmRuntimeRecreation,
        skipStop: optionalBoolean(args.skip_stop, "skip_stop") ?? false,
        smoke: optionalBoolean(args.smoke, "smoke") ?? true,
        enableDangerousTools: optionalBoolean(args.enable_dangerous_tools, "enable_dangerous_tools"),
        colabSession: optionalString(args.colab_session, "colab_session"),
        projectRoot: optionalString(args.project_root, "project_root"),
        colabConfig: optionalString(args.colab_config, "colab_config"),
        configPath: optionalString(args.config, "config"),
        baseUrl: optionalString(args.base_url, "base_url"),
        adminSecret: optionalString(args.admin_secret, "admin_secret"),
        timeoutSec: normalizeOperationTimeout(args.timeout_sec, MAX_OPERATION_TIMEOUT_SEC),
    };
}
function normalizeOperationTimeout(value, maxTimeoutSec) {
    const timeoutSec = optionalNumber(value, "timeout_sec") ?? DEFAULT_OPERATION_TIMEOUT_SEC;
    if (timeoutSec <= 0 || timeoutSec > maxTimeoutSec) {
        throw bridgeError("INVALID_ARGUMENT", `timeout_sec must be between 1 and ${maxTimeoutSec}.`, false);
    }
    return timeoutSec;
}
function optionalString(value, label) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || !value.trim()) {
        throw bridgeError("INVALID_ARGUMENT", `${label} must be a non-empty string.`, false);
    }
    return value.trim();
}
function optionalNumber(value, label) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw bridgeError("INVALID_ARGUMENT", `${label} must be a number.`, false);
    }
    return value;
}
function optionalBoolean(value, label) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throw bridgeError("INVALID_ARGUMENT", `${label} must be a boolean.`, false);
    }
    return value;
}
function runReconnectRunnerScript(payload, packageRoot) {
    const command = [
        process.execPath,
        "scripts/reconnect-runner.mjs",
        ...(payload.dryRun ? ["--dry-run"] : []),
        ...(payload.colabSession ? ["--colab-session", payload.colabSession] : []),
        ...(payload.colabConfig ? ["--colab-config", payload.colabConfig] : []),
        ...(payload.projectRoot ? ["--project-root", payload.projectRoot] : []),
        "--timeout",
        String(payload.timeoutSec),
    ];
    const startedAt = Date.now();
    const processTimeoutMs = Math.ceil((payload.timeoutSec + 30) * 1000);
    return new Promise((resolvePromise) => {
        const child = spawn(command[0], command.slice(1), {
            cwd: packageRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, processTimeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            const appended = appendBounded(stdout, chunk, LOCAL_COMMAND_OUTPUT_BYTES);
            stdout = appended.text;
            truncated = truncated || appended.truncated;
        });
        child.stderr.on("data", (chunk) => {
            const appended = appendBounded(stderr, chunk, LOCAL_COMMAND_OUTPUT_BYTES);
            stderr = appended.text;
            truncated = truncated || appended.truncated;
        });
        child.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            const appended = appendBounded(stderr, error.message, LOCAL_COMMAND_OUTPUT_BYTES);
            resolvePromise({
                command,
                stdout,
                stderr: appended.text,
                exit_code: 127,
                duration_ms: Date.now() - startedAt,
                timed_out: false,
                truncated: truncated || appended.truncated,
                dry_run: payload.dryRun,
            });
        });
        child.on("close", (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolvePromise({
                command,
                stdout,
                stderr,
                exit_code: timedOut ? null : code ?? 1,
                duration_ms: Date.now() - startedAt,
                timed_out: timedOut,
                truncated,
                dry_run: payload.dryRun,
            });
        });
    });
}
function runSetupBridgeScript(payload, packageRoot) {
    const command = [
        process.execPath,
        "scripts/setup-all.mjs",
        ...(payload.dryRun ? ["--dry-run"] : []),
        ...(payload.bootstrap ? ["--bootstrap"] : ["--no-bootstrap"]),
        ...(payload.smoke ? ["--smoke"] : []),
        ...(payload.enableDangerousTools ? ["--enable-dangerous-tools"] : []),
        ...(payload.baseUrl ? ["--base-url", payload.baseUrl] : []),
        ...(payload.adminSecret ? ["--admin-secret", payload.adminSecret] : []),
        ...(payload.gpu ? ["--gpu", payload.gpu] : []),
        ...(payload.colabSession ? ["--colab-session", payload.colabSession] : []),
        ...(payload.projectRoot ? ["--project-root", payload.projectRoot] : []),
        ...(payload.colabConfig ? ["--colab-config", payload.colabConfig] : []),
        ...(payload.configPath ? ["--config", payload.configPath] : []),
    ];
    return runLocalCommand(command, {
        packageRoot,
        timeoutSec: payload.timeoutSec,
        dryRun: payload.dryRun,
        redactions: [payload.adminSecret],
    });
}
async function runRuntimeOptionsScript(payload, packageRoot) {
    const command = [
        process.execPath,
        "scripts/runtime-options.mjs",
        "--json",
        ...(payload.colabConfig ? ["--colab-config", payload.colabConfig] : []),
    ];
    const result = await runLocalCommand(command, {
        packageRoot,
        timeoutSec: payload.timeoutSec,
        dryRun: false,
    });
    let parsed = {};
    if (result.exit_code === 0 && !result.timed_out) {
        try {
            const value = JSON.parse(result.stdout);
            if (value && typeof value === "object" && !Array.isArray(value)) {
                parsed = value;
            }
        }
        catch {
            parsed = {};
        }
    }
    return {
        ...parsed,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        truncated: result.truncated,
    };
}
function runStopRuntimeScript(payload, packageRoot) {
    const command = [
        process.execPath,
        "scripts/stop-runtime.mjs",
        ...(payload.dryRun ? ["--dry-run"] : ["--yes"]),
        ...(payload.colabSession ? ["--colab-session", payload.colabSession] : []),
        ...(payload.colabConfig ? ["--colab-config", payload.colabConfig] : []),
    ];
    return runLocalCommand(command, {
        packageRoot,
        timeoutSec: payload.timeoutSec,
        dryRun: payload.dryRun,
    });
}
function runRecreateRuntimeScript(payload, packageRoot) {
    const command = [
        process.execPath,
        "scripts/recreate-runtime.mjs",
        "--gpu",
        payload.gpu,
        ...(payload.dryRun ? ["--dry-run"] : ["--yes"]),
        ...(payload.skipStop ? ["--skip-stop"] : []),
        ...(payload.smoke ? ["--smoke"] : []),
        ...(payload.enableDangerousTools === true ? ["--enable-dangerous-tools"] : []),
        ...(payload.enableDangerousTools === false ? ["--disable-dangerous-tools"] : []),
        ...(payload.colabSession ? ["--colab-session", payload.colabSession] : []),
        ...(payload.projectRoot ? ["--project-root", payload.projectRoot] : []),
        ...(payload.colabConfig ? ["--colab-config", payload.colabConfig] : []),
        ...(payload.configPath ? ["--config", payload.configPath] : []),
        ...(payload.baseUrl ? ["--base-url", payload.baseUrl] : []),
        ...(payload.adminSecret ? ["--admin-secret", payload.adminSecret] : []),
    ];
    return runLocalCommand(command, {
        packageRoot,
        timeoutSec: payload.timeoutSec,
        dryRun: payload.dryRun,
        redactions: [payload.adminSecret],
    });
}
function runLocalCommand(command, { packageRoot, timeoutSec, dryRun, redactions = [], }) {
    const startedAt = Date.now();
    const processTimeoutMs = Math.ceil((timeoutSec + 30) * 1000);
    const redactedCommand = redactCommand(command, redactions);
    return new Promise((resolvePromise) => {
        const child = spawn(command[0], command.slice(1), {
            cwd: packageRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, processTimeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            const appended = appendBounded(stdout, redactText(chunk, redactions), LOCAL_COMMAND_OUTPUT_BYTES);
            stdout = appended.text;
            truncated = truncated || appended.truncated;
        });
        child.stderr.on("data", (chunk) => {
            const appended = appendBounded(stderr, redactText(chunk, redactions), LOCAL_COMMAND_OUTPUT_BYTES);
            stderr = appended.text;
            truncated = truncated || appended.truncated;
        });
        child.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            const appended = appendBounded(stderr, redactText(error.message, redactions), LOCAL_COMMAND_OUTPUT_BYTES);
            resolvePromise({
                command: redactedCommand,
                stdout,
                stderr: appended.text,
                exit_code: 127,
                duration_ms: Date.now() - startedAt,
                timed_out: false,
                truncated: truncated || appended.truncated,
                dry_run: dryRun,
            });
        });
        child.on("close", (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolvePromise({
                command: redactedCommand,
                stdout,
                stderr,
                exit_code: timedOut ? null : code ?? 1,
                duration_ms: Date.now() - startedAt,
                timed_out: timedOut,
                truncated,
                dry_run: dryRun,
            });
        });
    });
}
function redactCommand(command, redactions) {
    return command.map((part) => redactText(part, redactions));
}
function redactText(value, redactions) {
    let output = value;
    for (const secret of redactions) {
        if (secret) {
            output = output.replaceAll(secret, "<redacted>");
        }
    }
    return output;
}
function appendBounded(existing, chunk, maxBytes) {
    if (Buffer.byteLength(existing, "utf8") >= maxBytes) {
        return { text: existing, truncated: true };
    }
    const combined = `${existing}${chunk}`;
    if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
        return { text: combined, truncated: false };
    }
    return { text: Buffer.from(combined, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runStdioMcpServer();
}
