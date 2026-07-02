#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstString, shellQuote } from "./local-bridge-common.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FALLBACK_GPU_OPTIONS = ["T4", "L4", "G4", "H100", "A100"];
const FALLBACK_TPU_OPTIONS = ["v5e1", "v6e1"];

export function parseRuntimeOptionsArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
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

export function loadRuntimeOptions({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const flags = parseRuntimeOptionsArgs(argv);
  if (flags.help) {
    return { help: true };
  }
  return {
    help: false,
    json: flags.json === true,
    colabConfig: firstString(flags.colabConfig, env.COLAB_MCP_BRIDGE_COLAB_CONFIG),
  };
}

export function createRuntimeOptionsCommand(options = {}) {
  return [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    ...(options.colabConfig ? ["--config", options.colabConfig] : []),
    "new",
    "--help",
  ];
}

export function parseAcceleratorOptions(helpText) {
  const normalized = stripAnsi(helpText).replace(/\s+/g, " ");
  const gpu = parseSupportedList(
    normalized.match(/--gpu\s+TEXT\s+GPU accelerator variant\.\s+Supported:\s*([A-Za-z0-9,\s]+?)\.\s+If omitted/i)?.[1],
  );
  const tpu = parseSupportedList(
    normalized.match(/--tpu\s+TEXT\s+TPU accelerator variant\.\s+Supported:\s*([A-Za-z0-9,\s]+?)\./i)?.[1],
  );
  return {
    cpu: true,
    gpu,
    tpu,
  };
}

export async function collectRuntimeOptions({
  options = {},
  runCommand = runCommandCapture,
} = {}) {
  const command = createRuntimeOptionsCommand(options);
  const result = await runCommand(command);
  const parsed = result.ok ? parseAcceleratorOptions(`${result.stdout}\n${result.stderr}`) : emptyOptions();
  const warnings = [];
  let source = "google-colab-cli colab new --help";
  let acceleratorOptions = parsed;

  if (!result.ok) {
    source = "built-in fallback";
    acceleratorOptions = fallbackOptions();
    warnings.push(
      `Could not read google-colab-cli runtime options; using built-in fallback. Exit code: ${result.code}.`,
    );
  } else if (parsed.gpu.length === 0 && parsed.tpu.length === 0) {
    source = "built-in fallback";
    acceleratorOptions = fallbackOptions();
    warnings.push("Could not parse accelerator options from google-colab-cli help; using built-in fallback.");
  }

  return {
    source,
    command,
    availability: "Supported candidates only. Colab confirms real account/runtime availability only during allocation.",
    ...acceleratorOptions,
    warnings,
  };
}

export function formatRuntimeOptionsLines(result) {
  const lines = [
    "Colab runtime accelerator candidates",
    `Source: ${result.source}`,
    "Availability: supported candidates only; real allocation depends on Colab tier, quota, region, and current capacity.",
    "",
    "CPU:",
    "  none",
    "GPU:",
    `  ${result.gpu.length > 0 ? result.gpu.join(", ") : "(none reported)"}`,
    "TPU:",
    `  ${result.tpu.length > 0 ? result.tpu.join(", ") : "(none reported)"}`,
    "",
    "Use examples:",
    "  npm run runtime:recreate -- --gpu T4 --yes --smoke",
    "  npm run runtime:recreate -- --gpu none --yes --smoke",
  ];
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `  ${warning}`));
  }
  return lines;
}

async function run(options) {
  if (options.help) {
    console.log(helpText());
    return;
  }

  const result = await collectRuntimeOptions({ options });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatRuntimeOptionsLines(result).join("\n"));
}

function runCommandCapture(command) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ ok: false, code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      resolvePromise({ ok: code === 0, code: code ?? 1, stdout, stderr });
    });
  });
}

function parseSupportedList(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function fallbackOptions() {
  return {
    cpu: true,
    gpu: FALLBACK_GPU_OPTIONS,
    tpu: FALLBACK_TPU_OPTIONS,
  };
}

function emptyOptions() {
  return {
    cpu: true,
    gpu: [],
    tpu: [],
  };
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "").replace(/[\u2500-\u257F]/g, " ");
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/runtime-options.mjs [flags]

Print Colab runtime accelerator candidates from the installed google-colab-cli.
This is not a live capacity or account-quota check; Colab confirms real
availability only when it creates or recreates a runtime.

Common flags:
  --json                 print machine-readable output
  --colab-config PATH    google-colab-cli session state file

Probe command:
  ${createRuntimeOptionsCommand({}).map(shellQuote).join(" ")}`;
}

if (process.argv[1] === SCRIPT_PATH) {
  run(loadRuntimeOptions()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
