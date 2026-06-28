#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstString, shellQuote } from "./local-bridge-common.mjs";

const DEFAULT_COLAB_SESSION_NAME = "codex-colab-bridge";
const DEFAULT_RECONNECT_HELPER = "scripts/colab-reconnect-runner.py";
const DEFAULT_TIMEOUT_SEC = 60;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseReconnectRunnerArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    const key = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const value = equalsIndex === -1 ? argv[++index] : arg.slice(equalsIndex + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[toCamelCase(key)] = value;
  }
  return flags;
}

export function loadReconnectRunnerOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const flags = parseReconnectRunnerArgs(argv);
  if (flags.help) {
    return { help: true };
  }

  return {
    help: false,
    cwd,
    dryRun: flags.dryRun === true,
    colabSession: firstString(
      flags.colabSession,
      flags.colabSessionName,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION_NAME,
      DEFAULT_COLAB_SESSION_NAME,
    ),
    colabConfig: firstString(flags.colabConfig, env.COLAB_MCP_BRIDGE_COLAB_CONFIG),
    projectRoot: firstString(flags.projectRoot, env.COLAB_MCP_BRIDGE_PROJECT_ROOT),
    helperPath: firstString(flags.helper, flags.helperPath, DEFAULT_RECONNECT_HELPER),
    timeoutSec: parseTimeoutSec(firstString(flags.timeout, flags.timeoutSec) ?? String(DEFAULT_TIMEOUT_SEC)),
  };
}

export function createReconnectRunnerCommand(options, helperPath) {
  return [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    ...(options.colabConfig ? ["--config", options.colabConfig] : []),
    "exec",
    "-s",
    options.colabSession,
    "-f",
    helperPath,
    "--timeout",
    String(options.timeoutSec),
  ];
}

export function renderReconnectHelper(source, projectRoot) {
  if (!projectRoot) {
    return source;
  }

  const marker = "from __future__ import annotations\n";
  if (!source.includes(marker)) {
    throw new Error("Reconnect helper does not contain the expected future import marker.");
  }

  return source.replace(
    marker,
    `${marker}\nimport os as _colab_bridge_reconnect_os\n_colab_bridge_reconnect_os.environ["COLAB_BRIDGE_PROJECT_ROOT"] = ${JSON.stringify(projectRoot)}\n`,
  );
}

export function dryRunLines(options) {
  const helperPath = options.projectRoot
    ? "<generated-reconnect-runner.py>"
    : resolve(options.cwd, options.helperPath);
  return [
    "Dry run only. No Colab commands were executed.",
    `Colab session: ${options.colabSession}`,
    `Project root: ${options.projectRoot ?? "/content/project"}`,
    "",
    "Planned command:",
    `  ${formatCommand(createReconnectRunnerCommand(options, helperPath))}`,
    "",
    "This reconnects only when the existing Colab VM still has the previous runner process environment available.",
    "If the runner process or VM is gone, recreate/bootstrap the runtime instead.",
  ];
}

async function run(options) {
  if (options.help) {
    console.log(helpText());
    return;
  }

  if (options.dryRun) {
    console.log(dryRunLines(options).join("\n"));
    return;
  }

  const prepared = await prepareHelper(options);
  try {
    console.log(`Reconnecting Colab runner in session ${options.colabSession}.`);
    console.log("Runner token values will not be printed.");
    console.log(formatCommand(createReconnectRunnerCommand(options, prepared.path)));
    const result = await runCommand(createReconnectRunnerCommand(options, prepared.path), { cwd: options.cwd });
    if (!result.ok) {
      throw new Error(
        `Runner reconnect failed with exit code ${result.code}. If the old runner process or VM is gone, run setup/bootstrap or runtime:recreate instead.`,
      );
    }
    console.log("Runner reconnect command completed. Run colab_status or npm run smoke:mcp to verify runner_connected=true.");
  } finally {
    await prepared.cleanup();
  }
}

async function prepareHelper(options) {
  const sourcePath = resolve(options.cwd, options.helperPath);
  if (!options.projectRoot) {
    if (!existsSync(sourcePath)) {
      throw new Error(`Reconnect helper is missing: ${sourcePath}`);
    }
    return {
      path: sourcePath,
      cleanup: async () => {},
    };
  }

  const source = await readFile(sourcePath, "utf8");
  const tempDir = await mkdtemp(resolve(tmpdir(), "colab-runner-reconnect-"));
  const tempPath = resolve(tempDir, "colab-reconnect-runner.py");
  await writeFile(tempPath, renderReconnectHelper(source, options.projectRoot), { mode: 0o600 });
  return {
    path: tempPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function runCommand(command, { cwd = process.cwd() } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolvePromise({ ok: false, code: 127 });
    });
    child.on("close", (code) => {
      resolvePromise({ ok: code === 0, code: code ?? 1 });
    });
  });
}

function parseTimeoutSec(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--timeout must be a positive number of seconds.");
  }
  return parsed;
}

function formatCommand(command) {
  return command.map((item) => shellQuote(String(item))).join(" ");
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/reconnect-runner.mjs [flags]

Runs the Colab-side reconnect helper through google-colab-cli. This is a
non-destructive first recovery step for runner_connected=false when the Colab VM
and previous runner process still exist. It does not create a new bridge session
and does not require a runner token locally.

Common flags:
  --dry-run
  --colab-session NAME           default: ${DEFAULT_COLAB_SESSION_NAME}
  --colab-config PATH            google-colab-cli session state file
  --project-root /content/path   default: /content/project
  --timeout SECONDS              default: ${DEFAULT_TIMEOUT_SEC}
  --helper PATH                  default: ${DEFAULT_RECONNECT_HELPER}`;
}

if (process.argv[1] === SCRIPT_PATH) {
  run(loadReconnectRunnerOptions()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
