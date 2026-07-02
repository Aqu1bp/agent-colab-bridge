#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstString, shellQuote } from "./local-bridge-common.mjs";

const DEFAULT_COLAB_SESSION_NAME = "agent-colab-bridge";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseStopRuntimeArgs(argv) {
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
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
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

export function loadStopRuntimeOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const flags = parseStopRuntimeArgs(argv);
  if (flags.help) {
    return { help: true };
  }

  return {
    help: false,
    cwd,
    dryRun: flags.dryRun === true,
    yes: flags.yes === true,
    colabSession: firstString(
      flags.colabSession,
      flags.colabSessionName,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION_NAME,
      DEFAULT_COLAB_SESSION_NAME,
    ),
    colabConfig: firstString(flags.colabConfig, env.COLAB_MCP_BRIDGE_COLAB_CONFIG),
  };
}

export function createStopRuntimeCommand(options) {
  return [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    ...(options.colabConfig ? ["--config", options.colabConfig] : []),
    "stop",
    "-s",
    options.colabSession,
  ];
}

export function dryRunLines(options) {
  return [
    "Dry run only. No Colab runtime was stopped.",
    `Colab session: ${options.colabSession}`,
    "",
    "Planned command:",
    `  ${formatCommand(createStopRuntimeCommand(options))}`,
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

  if (!options.yes) {
    throw new Error("Refusing to stop runtime without --yes. This loses active Colab processes and runner-owned job state.");
  }

  console.log(`Stopping Colab runtime ${options.colabSession}.`);
  console.log("Active Colab processes and runner-owned job state will be lost.");
  const command = createStopRuntimeCommand(options);
  console.log(formatCommand(command));
  const result = await runCommand(command, { cwd: options.cwd });
  if (!result.ok) {
    throw new Error(`Command failed with exit code ${result.code}: ${formatCommand(command)}`);
  }
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

function formatCommand(command) {
  return command.map((item) => shellQuote(String(item))).join(" ");
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/stop-runtime.mjs --yes [flags]

Stops the named Colab session through google-colab-cli. Active Colab processes
and runner-owned job state are lost.

Common flags:
  --dry-run
  --yes, -y
  --colab-session NAME           default: ${DEFAULT_COLAB_SESSION_NAME}
  --colab-config PATH            google-colab-cli session state file`;
}

if (process.argv[1] === SCRIPT_PATH) {
  run(loadStopRuntimeOptions()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
