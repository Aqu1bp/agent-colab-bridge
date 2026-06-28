import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const DEFAULT_CONFIG_PATH = "~/.config/colab-mcp-bridge/config.json";

export function defaultConfigPath() {
  return resolvePath(DEFAULT_CONFIG_PATH);
}

export function resolvePath(path, cwd = process.cwd()) {
  if (!path || typeof path !== "string") {
    throw new Error("Path must be a non-empty string.");
  }
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim().replace(/\/+$/, "");
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseBoolean(value, label = "value") {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a boolean value.`);
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", ""].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be one of true/false, yes/no, on/off, or 1/0.`);
}

export function redactSecret(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "unset";
  }
  return "set (redacted)";
}

export function redactObject(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactObject);
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/_?token$/i.test(key) || /secret/i.test(key) || /authorization/i.test(key)) {
      output[key] = redactSecret(String(item ?? ""));
    } else {
      output[key] = redactObject(item);
    }
  }
  return output;
}

export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

export async function readJsonFile(path, { readTextFile = readFile } = {}) {
  const text = await readTextFile(path, "utf8");
  return JSON.parse(text);
}

export async function readExistingConfig(path, options = {}) {
  const pathExists = options.exists ?? existsSync;
  if (!pathExists(path)) {
    return {};
  }
  const parsed = await readJsonFile(path, options);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Local bridge config must be a JSON object.");
  }
  return parsed;
}

export function parseLocalConfigShape(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Local bridge config must be a JSON object.");
  }
  const baseUrl = firstString(raw.base_url, raw.worker_url, raw.baseUrl, raw.workerUrl);
  const sessionId = firstString(raw.session_id, raw.sessionId);
  const controllerToken = firstString(raw.controller_token, raw.controllerToken);
  const enableDangerousTools =
    parseBoolean(raw.enable_dangerous_tools, "enable_dangerous_tools") ??
    parseBoolean(raw.enableDangerousTools, "enableDangerousTools") ??
    false;

  const missing = [
    !baseUrl ? "base_url or worker_url" : null,
    !sessionId ? "session_id" : null,
    !controllerToken ? "controller_token" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing local bridge config field(s): ${missing.join(", ")}.`);
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    sessionId,
    controllerToken,
    enableDangerousTools,
  };
}

export function mergeBridgeConfig(existing, session, options) {
  const enableDangerousTools =
    options.enableDangerousTools ??
    parseBoolean(existing.enable_dangerous_tools, "enable_dangerous_tools") ??
    parseBoolean(existing.enableDangerousTools, "enableDangerousTools") ??
    false;
  const merged = {
    ...existing,
    base_url: normalizeBaseUrl(options.baseUrl),
    session_id: session.sessionId,
    controller_token: session.controllerToken,
    enable_dangerous_tools: enableDangerousTools,
  };
  delete merged.admin_secret;
  delete merged.adminSecret;
  delete merged.baseUrl;
  delete merged.worker_url;
  delete merged.workerUrl;
  delete merged.controllerToken;
  delete merged.runner_token;
  delete merged.runnerToken;
  return merged;
}

export async function writeBridgeConfig(
  path,
  config,
  { chmodFile = chmod, makeDir = mkdir, writeTextFile = writeFile } = {},
) {
  await makeDir(dirname(path), { recursive: true, mode: 0o700 });
  await writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmodFile(path, 0o600);
}

export function unwrapSessionResponse(json) {
  const data = json && typeof json === "object" && "data" in json ? json.data : json;
  if (!data || typeof data !== "object") {
    throw new Error("Session response did not contain an object payload.");
  }
  const sessionId = firstString(data.session_id, data.sessionId);
  const controllerToken = firstString(data.controller_token, data.controllerToken);
  const runnerToken = firstString(data.runner_token, data.runnerToken);
  const expiresAt = firstString(data.expires_at, data.expiresAt);
  const missing = [
    !sessionId ? "session_id" : null,
    !controllerToken ? "controller_token" : null,
    !runnerToken ? "runner_token" : null,
    !expiresAt ? "expires_at" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Session response missing field(s): ${missing.join(", ")}.`);
  }
  return { sessionId, controllerToken, runnerToken, expiresAt };
}

export function controllerAuthHeaders(controllerToken, noncePrefix = "doctor") {
  return {
    Authorization: `Bearer ${controllerToken}`,
    "X-Bridge-Timestamp": new Date().toISOString(),
    "X-Bridge-Nonce": `${noncePrefix}_${randomUUID().replaceAll("-", "")}`,
  };
}
