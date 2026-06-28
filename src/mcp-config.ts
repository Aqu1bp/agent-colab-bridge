import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalBridgeConfig {
  baseUrl: string;
  sessionId: string;
  controllerToken: string;
}

export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface LoadLocalBridgeConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export function parseLocalBridgeConfig(raw: unknown): LocalBridgeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BridgeConfigError("MCP bridge config must be a JSON object.");
  }

  const record = raw as Record<string, unknown>;
  const baseUrl = stringField(record, "base_url") ?? stringField(record, "worker_url");
  const sessionId = stringField(record, "session_id");
  const controllerToken = stringField(record, "controller_token");
  const missing = [
    !baseUrl ? "base_url or worker_url" : null,
    !sessionId ? "session_id" : null,
    !controllerToken ? "controller_token" : null,
  ].filter((item): item is string => item !== null);

  if (missing.length > 0) {
    throw new BridgeConfigError(`Missing MCP bridge config field(s): ${missing.join(", ")}.`);
  }

  return {
    baseUrl: baseUrl!,
    sessionId: sessionId!,
    controllerToken: controllerToken!,
  };
}

export function loadLocalBridgeConfig(
  options: LoadLocalBridgeConfigOptions = {},
): LocalBridgeConfig {
  const env = options.env ?? process.env;
  const envConfig = {
    base_url: env.COLAB_MCP_BRIDGE_BASE_URL,
    worker_url: env.COLAB_MCP_BRIDGE_WORKER_URL,
    session_id: env.COLAB_MCP_BRIDGE_SESSION_ID,
    controller_token: env.COLAB_MCP_BRIDGE_CONTROLLER_TOKEN,
  };

  if (Object.values(envConfig).some((value) => value !== undefined)) {
    return parseLocalBridgeConfig(envConfig);
  }

  const configPath =
    options.configPath ??
    env.COLAB_MCP_BRIDGE_CONFIG ??
    join(homedir(), ".config", "colab-mcp-bridge", "config.json");

  if (!existsSync(configPath)) {
    throw new BridgeConfigError(
      "Missing MCP bridge config. Set COLAB_MCP_BRIDGE_BASE_URL, COLAB_MCP_BRIDGE_SESSION_ID, and COLAB_MCP_BRIDGE_CONTROLLER_TOKEN or create a local config file.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new BridgeConfigError("MCP bridge config file must contain valid JSON.");
  }

  return parseLocalBridgeConfig(parsed);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
