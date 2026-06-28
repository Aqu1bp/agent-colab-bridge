#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  controllerAuthHeaders,
  defaultConfigPath,
  firstString,
  normalizeBaseUrl,
  parseLocalConfigShape,
  readJsonFile,
  resolvePath,
} from "./local-bridge-common.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseDoctorArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--skip-network") {
      flags.skipNetwork = true;
      continue;
    }
    if (arg === "--require-network") {
      flags.requireNetwork = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    const key = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const value =
      equalsIndex === -1 ? argv[++index] : arg.slice(equalsIndex + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[toCamelCase(key)] = value;
  }
  return flags;
}

export function loadDoctorOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const flags = parseDoctorArgs(argv);
  if (flags.help) {
    return { help: true };
  }
  return {
    help: false,
    configPath: resolvePath(firstString(flags.config, env.COLAB_MCP_BRIDGE_CONFIG, defaultConfigPath()), cwd),
    baseUrl: normalizeBaseUrl(
      firstString(
        flags.baseUrl,
        flags.workerUrl,
        env.COLAB_MCP_BRIDGE_BASE_URL,
        env.COLAB_MCP_BRIDGE_WORKER_URL,
      ),
    ),
    skipNetwork: flags.skipNetwork === true,
    requireNetwork: flags.requireNetwork === true,
    cwd,
  };
}

export function nodeVersionCheck(version = process.version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return fail("node", `Could not parse Node version ${version}.`);
  }
  const major = Number(match[1]);
  if (major < 20) {
    return fail("node", `Node ${version} is too old; install Node 20 or newer.`);
  }
  return pass("node", `Node ${version} is supported.`);
}

export async function collectDoctorChecks(
  options,
  {
    exists = existsSync,
    readTextFile = readFile,
    runCommand = runCommandDefault,
    fetchFn = fetch,
  } = {},
) {
  const checks = [nodeVersionCheck()];
  const packageJsonPath = resolvePath("package.json", options.cwd);
  const nodeModulesPath = resolvePath("node_modules", options.cwd);

  checks.push(await packageCheck(packageJsonPath, { exists, readTextFile }));
  checks.push(
    exists(nodeModulesPath)
      ? pass("npm install", "node_modules is present.")
      : warn("npm install", "node_modules is missing; run npm install before build/test/bootstrap."),
  );

  const uvx = await commandAvailability("uvx", ["uvx", "--version"], runCommand);
  checks.push(uvx);
  if (uvx.status === "pass") {
    checks.push(
      await commandAvailability(
        "google-colab-cli",
        ["uvx", "--from", "google-colab-cli", "colab", "--help"],
        runCommand,
        "google-colab-cli help is available through uvx.",
      ),
    );
  } else {
    checks.push(warn("google-colab-cli", "Skipped because uvx is not available."));
  }
  checks.push(
    await commandAvailabilityAny(
      "wrangler",
      [
        ["wrangler", "--version"],
        ["npx", "--no-install", "wrangler", "--version"],
      ],
      runCommand,
      "Wrangler is available.",
    ),
  );

  const configCheck = await localConfigCheck(options.configPath, { exists, readTextFile });
  checks.push(configCheck.check);

  const config = configCheck.config;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? config?.baseUrl);
  if (options.skipNetwork) {
    checks.push(warn("worker health", "Skipped because --skip-network was provided."));
  } else if (baseUrl) {
    checks.push(await workerHealthCheck(baseUrl, { fetchFn, required: options.requireNetwork }));
    if (config?.sessionId && config?.controllerToken) {
      checks.push(await bridgeStatusCheck(config, { fetchFn, required: options.requireNetwork }));
    }
  } else {
    checks.push(warn("worker health", "Skipped because no Worker URL was provided or found in local config."));
  }

  return checks;
}

export function formatDoctorCheck(check) {
  return `${check.status.toUpperCase()} ${check.name}: ${check.message}`;
}

async function packageCheck(packageJsonPath, { exists, readTextFile }) {
  if (!exists(packageJsonPath)) {
    return fail("package.json", "package.json was not found in this repository.");
  }
  try {
    const parsed = JSON.parse(await readTextFile(packageJsonPath, "utf8"));
    if (parsed?.name !== "codex-colab-bridge") {
      return warn("package.json", `Unexpected package name ${JSON.stringify(parsed?.name)}.`);
    }
    return pass("package.json", "codex-colab-bridge package is present.");
  } catch (error) {
    return fail("package.json", `package.json could not be read as JSON: ${error.message}`);
  }
}

async function localConfigCheck(configPath, { exists, readTextFile }) {
  if (!exists(configPath)) {
    return {
      check: warn("local config", `No local MCP config found at ${configPath}; run npm run setup:bridge.`),
      config: undefined,
    };
  }
  try {
    const parsed = await readJsonFile(configPath, { readTextFile });
    const config = parseLocalConfigShape(parsed);
    return {
      check: pass(
        "local config",
        `Found session ${config.sessionId}; controller token is set (redacted). Dangerous tools are ${config.enableDangerousTools ? "enabled" : "disabled"}.`,
      ),
      config,
    };
  } catch (error) {
    return {
      check: fail("local config", `${configPath} is invalid: ${error.message}`),
      config: undefined,
    };
  }
}

async function workerHealthCheck(baseUrl, { fetchFn, required }) {
  try {
    const response = await fetchFn(`${baseUrl}/health`);
    const json = await safeJson(response);
    const status = json?.data?.status ?? json?.status;
    if (response.ok && status === "ok") {
      return pass("worker health", `${baseUrl}/health returned ok.`);
    }
    return networkProblem(
      required,
      "worker health",
      `${baseUrl}/health returned HTTP ${response.status}; check the Worker URL and deployment.`,
    );
  } catch (error) {
    return networkProblem(required, "worker health", `${baseUrl}/health failed: ${error.message}`);
  }
}

async function bridgeStatusCheck(config, { fetchFn, required }) {
  const url = `${config.baseUrl}/v1/sessions/${encodeURIComponent(config.sessionId)}/status`;
  try {
    const response = await fetchFn(url, {
      headers: controllerAuthHeaders(config.controllerToken, "doctor"),
    });
    const json = await safeJson(response);
    if (response.ok) {
      const connected = json?.data?.runner_connected === true;
      return pass(
        "bridge status",
        `Authenticated status succeeded; runner_connected=${connected ? "true" : "false"}.`,
      );
    }
    return networkProblem(
      required,
      "bridge status",
      `Authenticated status returned HTTP ${response.status}; check session expiry and local controller token.`,
    );
  } catch (error) {
    return networkProblem(required, "bridge status", `Authenticated status failed: ${error.message}`);
  }
}

async function commandAvailability(name, command, runCommand, successMessage) {
  const result = await runCommand(command, { timeoutMs: 15_000 });
  if (result.ok) {
    return pass(name, successMessage ?? `${command[0]} is available.`);
  }
  if (result.timedOut) {
    return warn(name, `${command.join(" ")} timed out; check local installation/network.`);
  }
  return warn(name, `${command[0]} is not available; install it if you need this workflow.`);
}

async function commandAvailabilityAny(name, commands, runCommand, successMessage) {
  const failures = [];
  for (const command of commands) {
    const result = await runCommand(command, { timeoutMs: 15_000 });
    if (result.ok) {
      return pass(name, successMessage ?? `${command[0]} is available.`);
    }
    failures.push({ command, result });
    if (result.timedOut) {
      return warn(name, `${command.join(" ")} timed out; check local installation/network.`);
    }
  }

  const attempted = failures.map(({ command }) => command.join(" ")).join(" or ");
  return warn(name, `${attempted} is not available; install Wrangler if you need deployment.`);
}

function networkProblem(required, name, message) {
  return required ? fail(name, message) : warn(name, message);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pass(name, message) {
  return { status: "pass", name, message };
}

function warn(name, message) {
  return { status: "warn", name, message };
}

function fail(name, message) {
  return { status: "fail", name, message };
}

function runCommandDefault(command, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolvePromise({ ok: false, code: null, timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolvePromise({ ok: false, code: 127, error });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ ok: code === 0, code: code ?? 1, timedOut: false });
    });
  });
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/doctor.mjs [flags]

Checks local prerequisites, local MCP config shape, optional Worker health, and
optional authenticated bridge status when local controller config exists.

Common flags:
  --config PATH             default: ${defaultConfigPath()}
  --base-url URL            override Worker URL for health check
  --skip-network            skip Worker /health and status checks
  --require-network         make network check failures hard failures`;
}

if (process.argv[1] === SCRIPT_PATH) {
  Promise.resolve(loadDoctorOptions())
    .then(async (options) => {
      if (options.help) {
        console.log(helpText());
        return [];
      }
      const checks = await collectDoctorChecks(options);
      for (const check of checks) {
        console.log(formatDoctorCheck(check));
      }
      if (checks.some((check) => check.status === "fail")) {
        process.exitCode = 1;
      }
      return checks;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
