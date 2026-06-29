import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "codex-colab-bridge", "config.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".config", "colab-mcp-bridge", "config.json");

export interface LocalBridgeConfig {
  baseUrl: string;
  sessionId: string;
  controllerToken: string;
  enableDangerousTools: boolean;
}

export interface LocalBridgeConfigSummary {
  configured: boolean;
  config_source: string;
  config_path?: string;
  legacy_config_used: boolean;
  base_url?: string;
  session_id?: string;
  enable_dangerous_tools?: boolean;
  controller_token_set: boolean;
  runner_token_set: boolean;
  admin_secret_set: boolean;
  error?: string;
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
  const enableDangerousTools =
    booleanField(record, "enableDangerousTools") ??
    booleanField(record, "enable_dangerous_tools") ??
    false;
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
    enableDangerousTools,
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
    enable_dangerous_tools: env.COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS,
  };

  const hasCompleteEnvConfig =
    (envConfig.base_url !== undefined || envConfig.worker_url !== undefined) &&
    envConfig.session_id !== undefined &&
    envConfig.controller_token !== undefined;
  if (hasCompleteEnvConfig) {
    return parseLocalBridgeConfig(envConfig);
  }

  const explicitConfigPath = options.configPath ?? env.COLAB_MCP_BRIDGE_CONFIG;
  const configPath =
    explicitConfigPath ??
    (existsSync(DEFAULT_CONFIG_PATH) || !existsSync(LEGACY_CONFIG_PATH)
      ? DEFAULT_CONFIG_PATH
      : LEGACY_CONFIG_PATH);

  if (!existsSync(configPath)) {
    throw new BridgeConfigError(
      `Missing MCP bridge config. Set COLAB_MCP_BRIDGE_BASE_URL, COLAB_MCP_BRIDGE_SESSION_ID, and COLAB_MCP_BRIDGE_CONTROLLER_TOKEN or create ${DEFAULT_CONFIG_PATH}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
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

export function getLocalBridgeConfigSummary(
  options: LoadLocalBridgeConfigOptions = {},
): LocalBridgeConfigSummary {
  const env = options.env ?? process.env;
  const envConfig = {
    base_url: env.COLAB_MCP_BRIDGE_BASE_URL,
    worker_url: env.COLAB_MCP_BRIDGE_WORKER_URL,
    session_id: env.COLAB_MCP_BRIDGE_SESSION_ID,
    controller_token: env.COLAB_MCP_BRIDGE_CONTROLLER_TOKEN,
    enable_dangerous_tools: env.COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS,
  };
  const envSecretFlags = {
    controller_token_set: hasStringValue(env.COLAB_MCP_BRIDGE_CONTROLLER_TOKEN),
    runner_token_set: hasStringValue(env.COLAB_MCP_BRIDGE_RUNNER_TOKEN),
    admin_secret_set: hasStringValue(env.COLAB_MCP_BRIDGE_ADMIN_SECRET),
  };

  const hasCompleteEnvConfig =
    (envConfig.base_url !== undefined || envConfig.worker_url !== undefined) &&
    envConfig.session_id !== undefined &&
    envConfig.controller_token !== undefined;
  if (hasCompleteEnvConfig) {
    try {
      return configuredSummary(parseLocalBridgeConfig(envConfig), {
        configSource: "env",
        legacyConfigUsed: false,
        secretFlags: envSecretFlags,
      });
    } catch (error) {
      return unconfiguredSummary({
        configSource: "env",
        legacyConfigUsed: false,
        secretFlags: envSecretFlags,
        error,
      });
    }
  }

  const explicitConfigPath = options.configPath ?? env.COLAB_MCP_BRIDGE_CONFIG;
  const defaultExists = existsSync(DEFAULT_CONFIG_PATH);
  const legacyExists = existsSync(LEGACY_CONFIG_PATH);
  const configPath =
    explicitConfigPath ??
    (defaultExists || !legacyExists ? DEFAULT_CONFIG_PATH : LEGACY_CONFIG_PATH);
  const legacyConfigUsed = !explicitConfigPath && configPath === LEGACY_CONFIG_PATH;
  const configSource = explicitConfigPath
    ? "explicit_file"
    : legacyConfigUsed
      ? "legacy_file"
      : "default_file";

  if (!existsSync(configPath)) {
    return unconfiguredSummary({
      configSource,
      configPath,
      legacyConfigUsed,
      secretFlags: envSecretFlags,
      error: new BridgeConfigError(
        `Missing MCP bridge config. Set COLAB_MCP_BRIDGE_BASE_URL, COLAB_MCP_BRIDGE_SESSION_ID, and COLAB_MCP_BRIDGE_CONTROLLER_TOKEN or create ${DEFAULT_CONFIG_PATH}.`,
      ),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return unconfiguredSummary({
      configSource,
      configPath,
      legacyConfigUsed,
      secretFlags: envSecretFlags,
      error: new BridgeConfigError("MCP bridge config file must contain valid JSON."),
    });
  }

  const fileSecretFlags = secretFlagsFromRecord(parsed);
  const secretFlags = {
    controller_token_set: envSecretFlags.controller_token_set || fileSecretFlags.controller_token_set,
    runner_token_set: envSecretFlags.runner_token_set || fileSecretFlags.runner_token_set,
    admin_secret_set: envSecretFlags.admin_secret_set || fileSecretFlags.admin_secret_set,
  };

  let fileConfig: LocalBridgeConfig;
  try {
    fileConfig = parseLocalBridgeConfig(parsed);
  } catch (error) {
    return unconfiguredSummary({
      configSource,
      configPath,
      legacyConfigUsed,
      secretFlags,
      error,
    });
  }

  try {
    return configuredSummary(
      parseLocalBridgeConfig({
        base_url: envConfig.base_url ?? (envConfig.worker_url ? undefined : fileConfig.baseUrl),
        worker_url: envConfig.worker_url,
        session_id: envConfig.session_id ?? fileConfig.sessionId,
        controller_token: envConfig.controller_token ?? fileConfig.controllerToken,
        enable_dangerous_tools: envConfig.enable_dangerous_tools ?? fileConfig.enableDangerousTools,
      }),
      {
        configSource,
        configPath,
        legacyConfigUsed,
        secretFlags,
      },
    );
  } catch (error) {
    return unconfiguredSummary({
      configSource,
      configPath,
      legacyConfigUsed,
      secretFlags,
      error,
    });
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
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

function configuredSummary(
  config: LocalBridgeConfig,
  options: {
    configSource: string;
    configPath?: string;
    legacyConfigUsed: boolean;
    secretFlags: Pick<
      LocalBridgeConfigSummary,
      "controller_token_set" | "runner_token_set" | "admin_secret_set"
    >;
  },
): LocalBridgeConfigSummary {
  return {
    configured: true,
    config_source: options.configSource,
    ...(options.configPath ? { config_path: options.configPath } : {}),
    legacy_config_used: options.legacyConfigUsed,
    base_url: config.baseUrl,
    session_id: config.sessionId,
    enable_dangerous_tools: config.enableDangerousTools,
    controller_token_set: true,
    runner_token_set: options.secretFlags.runner_token_set,
    admin_secret_set: options.secretFlags.admin_secret_set,
  };
}

function unconfiguredSummary(options: {
  configSource: string;
  configPath?: string;
  legacyConfigUsed: boolean;
  secretFlags: Pick<
    LocalBridgeConfigSummary,
    "controller_token_set" | "runner_token_set" | "admin_secret_set"
  >;
  error: unknown;
}): LocalBridgeConfigSummary {
  return {
    configured: false,
    config_source: options.configSource,
    ...(options.configPath ? { config_path: options.configPath } : {}),
    legacy_config_used: options.legacyConfigUsed,
    controller_token_set: options.secretFlags.controller_token_set,
    runner_token_set: options.secretFlags.runner_token_set,
    admin_secret_set: options.secretFlags.admin_secret_set,
    error: sanitizeConfigError(options.error),
  };
}

function secretFlagsFromRecord(
  value: unknown,
): Pick<LocalBridgeConfigSummary, "controller_token_set" | "runner_token_set" | "admin_secret_set"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      controller_token_set: false,
      runner_token_set: false,
      admin_secret_set: false,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    controller_token_set: hasStringValue(record.controller_token) || hasStringValue(record.controllerToken),
    runner_token_set: hasStringValue(record.runner_token) || hasStringValue(record.runnerToken),
    admin_secret_set: hasStringValue(record.admin_secret) || hasStringValue(record.adminSecret),
  };
}

function hasStringValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeConfigError(error: unknown): string {
  if (error instanceof BridgeConfigError) {
    return error.message;
  }
  return "MCP bridge config could not be summarized.";
}
