import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "codex-colab-bridge", "config.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".config", "colab-mcp-bridge", "config.json");
export class BridgeConfigError extends Error {
    constructor(message) {
        super(message);
    }
}
export function parseLocalBridgeConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new BridgeConfigError("MCP bridge config must be a JSON object.");
    }
    const record = raw;
    const baseUrl = stringField(record, "base_url") ?? stringField(record, "worker_url");
    const sessionId = stringField(record, "session_id");
    const controllerToken = stringField(record, "controller_token");
    const enableDangerousTools = booleanField(record, "enableDangerousTools") ??
        booleanField(record, "enable_dangerous_tools") ??
        false;
    const missing = [
        !baseUrl ? "base_url or worker_url" : null,
        !sessionId ? "session_id" : null,
        !controllerToken ? "controller_token" : null,
    ].filter((item) => item !== null);
    if (missing.length > 0) {
        throw new BridgeConfigError(`Missing MCP bridge config field(s): ${missing.join(", ")}.`);
    }
    return {
        baseUrl: baseUrl,
        sessionId: sessionId,
        controllerToken: controllerToken,
        enableDangerousTools,
    };
}
export function loadLocalBridgeConfig(options = {}) {
    const env = options.env ?? process.env;
    const envConfig = {
        base_url: env.COLAB_MCP_BRIDGE_BASE_URL,
        worker_url: env.COLAB_MCP_BRIDGE_WORKER_URL,
        session_id: env.COLAB_MCP_BRIDGE_SESSION_ID,
        controller_token: env.COLAB_MCP_BRIDGE_CONTROLLER_TOKEN,
        enable_dangerous_tools: env.COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS,
    };
    const hasCompleteEnvConfig = (envConfig.base_url !== undefined || envConfig.worker_url !== undefined) &&
        envConfig.session_id !== undefined &&
        envConfig.controller_token !== undefined;
    if (hasCompleteEnvConfig) {
        return parseLocalBridgeConfig(envConfig);
    }
    const explicitConfigPath = options.configPath ?? env.COLAB_MCP_BRIDGE_CONFIG;
    const configPath = explicitConfigPath ??
        (existsSync(DEFAULT_CONFIG_PATH) || !existsSync(LEGACY_CONFIG_PATH)
            ? DEFAULT_CONFIG_PATH
            : LEGACY_CONFIG_PATH);
    if (!existsSync(configPath)) {
        throw new BridgeConfigError(`Missing MCP bridge config. Set COLAB_MCP_BRIDGE_BASE_URL, COLAB_MCP_BRIDGE_SESSION_ID, and COLAB_MCP_BRIDGE_CONTROLLER_TOKEN or create ${DEFAULT_CONFIG_PATH}.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(configPath, "utf8"));
    }
    catch {
        throw new BridgeConfigError("MCP bridge config file must contain valid JSON.");
    }
    const fileConfig = parseLocalBridgeConfig(parsed);
    return parseLocalBridgeConfig({
        base_url: envConfig.base_url ?? (envConfig.worker_url ? undefined : fileConfig.baseUrl),
        worker_url: envConfig.worker_url,
        session_id: envConfig.session_id ?? fileConfig.sessionId,
        controller_token: envConfig.controller_token ?? fileConfig.controllerToken,
        enable_dangerous_tools: envConfig.enable_dangerous_tools ?? fileConfig.enableDangerousTools,
    });
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function booleanField(record, key) {
    const value = record[key];
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
        return false;
    }
    throw new BridgeConfigError(`${key} must be a boolean or 1/0-style flag.`);
}
