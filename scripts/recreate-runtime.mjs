#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstString, shellQuote } from "./local-bridge-common.mjs";

const DEFAULT_COLAB_SESSION_NAME = "codex-colab-bridge";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseRecreateRuntimeArgs(argv) {
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
    if (arg === "--skip-stop" || arg === "--no-stop") {
      flags.skipStop = true;
      continue;
    }
    if (arg === "--smoke") {
      flags.smoke = true;
      continue;
    }
    if (arg === "--enable-dangerous-tools") {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.enableDangerousTools = next;
        index += 1;
      } else {
        flags.enableDangerousTools = true;
      }
      continue;
    }
    if (arg === "--disable-dangerous-tools" || arg === "--no-enable-dangerous-tools") {
      flags.enableDangerousTools = false;
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

export function loadRecreateRuntimeOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const flags = parseRecreateRuntimeArgs(argv);
  if (flags.help) {
    return { help: true };
  }

  const gpu = firstString(flags.gpu);
  if (!gpu) {
    throw new Error("Missing required runtime setting: --gpu. Use --gpu none for a CPU runtime.");
  }

  return {
    help: false,
    cwd,
    dryRun: flags.dryRun === true,
    yes: flags.yes === true,
    skipStop: flags.skipStop === true,
    smoke: flags.smoke === true,
    gpu,
    colabSession: firstString(
      flags.colabSession,
      flags.colabSessionName,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION_NAME,
      DEFAULT_COLAB_SESSION_NAME,
    ),
    projectRoot: firstString(flags.projectRoot, env.COLAB_MCP_BRIDGE_PROJECT_ROOT),
    configPath: firstString(flags.config, env.COLAB_MCP_BRIDGE_CONFIG),
    baseUrl: firstString(flags.baseUrl, flags.workerUrl, env.COLAB_MCP_BRIDGE_BASE_URL, env.COLAB_MCP_BRIDGE_WORKER_URL),
    adminSecret: firstString(flags.adminSecret, env.COLAB_MCP_BRIDGE_ADMIN_SECRET, env.ADMIN_SECRET),
    colabConfig: firstString(flags.colabConfig, env.COLAB_MCP_BRIDGE_COLAB_CONFIG),
    enableDangerousTools: flags.enableDangerousTools,
  };
}

export function createRecreateRuntimePlan(options) {
  const plan = [];
  if (!options.skipStop) {
    plan.push({
      label: "Stop existing Colab session",
      command: colabCommand(options, ["stop", "-s", options.colabSession]),
      optional: true,
    });
  }

  plan.push({
    label: "Create fresh bridge session and bootstrap Colab runtime",
    command: setupAllCommand(options),
  });
  return plan;
}

export function dryRunLines(options) {
  const lines = [
    "Dry run only. No Colab, Cloudflare, config, or smoke actions will run.",
    `Colab session: ${options.colabSession}`,
    `Requested GPU: ${options.gpu}`,
    `Stop existing session first: ${options.skipStop ? "no" : "yes"}`,
    `MCP smoke: ${options.smoke ? "enabled" : "disabled"}`,
    "",
    "Planned commands:",
  ];

  for (const step of createRecreateRuntimePlan(options)) {
    lines.push(`- ${step.label}`);
    lines.push(`  ${formatCommand(step.command, { redactAdminSecret: true })}`);
    if (step.optional) {
      lines.push("  optional: failure is allowed so a missing old session does not block recreation");
    }
  }

  return lines;
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
    throw new Error("Refusing to recreate runtime without --yes. This stops the current Colab session and loses active jobs.");
  }

  console.log(`Recreating Colab runtime ${options.colabSession} with GPU setting ${options.gpu}.`);
  console.log("Active Colab processes and runner-owned job state will be lost.");

  for (const step of createRecreateRuntimePlan(options)) {
    console.log(`\n${step.label}`);
    console.log(formatCommand(step.command, { redactAdminSecret: true }));
    const result = await runCommand(step.command, { cwd: options.cwd });
    if (!result.ok && !step.optional) {
      throw new Error(`Command failed with exit code ${result.code}: ${formatCommand(step.command, { redactAdminSecret: true })}`);
    }
    if (!result.ok && step.optional) {
      console.log(`Optional step failed with exit code ${result.code}; continuing.`);
    }
  }
}

function setupAllCommand(options) {
  const args = [process.execPath, "scripts/setup-all.mjs", "--bootstrap", "--gpu", options.gpu, "--colab-session", options.colabSession];
  if (options.smoke) {
    args.push("--smoke");
  }
  if (options.configPath) {
    args.push("--config", options.configPath);
  }
  if (options.baseUrl) {
    args.push("--base-url", options.baseUrl);
  }
  if (options.adminSecret) {
    args.push("--admin-secret", options.adminSecret);
  }
  if (options.projectRoot) {
    args.push("--project-root", options.projectRoot);
  }
  if (options.colabConfig) {
    args.push("--colab-config", options.colabConfig);
  }
  if (options.enableDangerousTools === true) {
    args.push("--enable-dangerous-tools");
  } else if (options.enableDangerousTools === false) {
    args.push("--disable-dangerous-tools");
  } else if (typeof options.enableDangerousTools === "string") {
    args.push("--enable-dangerous-tools", options.enableDangerousTools);
  }
  return args;
}

function colabCommand(options, args) {
  return [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    ...(options.colabConfig ? ["--config", options.colabConfig] : []),
    ...args,
  ];
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

function formatCommand(command, { redactAdminSecret = false } = {}) {
  const output = [];
  for (let index = 0; index < command.length; index += 1) {
    output.push(shellQuote(command[index]));
    if (redactAdminSecret && command[index] === "--admin-secret" && index + 1 < command.length) {
      output.push("<admin-secret-redacted>");
      index += 1;
    }
  }
  return output.join(" ");
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/recreate-runtime.mjs --gpu GPU --yes [flags]

Stops the named Colab session, then creates a fresh bridge session and
bootstraps a Colab runtime with the requested accelerator. Active Colab
processes and runner-owned job state are lost.

Common flags:
  --dry-run
  --yes, -y
  --gpu T4|L4|G4|A100|H100|none  required; "none" requests CPU runtime
  --colab-session NAME           default: ${DEFAULT_COLAB_SESSION_NAME}
  --skip-stop                    do not call google-colab-cli stop first
  --smoke                        run MCP smoke after bootstrap
  --enable-dangerous-tools       pass through to setup:all
  --disable-dangerous-tools      pass through to setup:all
  --project-root /content/path   pass through to bootstrap
  --config PATH                  local bridge config path
  --base-url URL                 Worker URL override
  --admin-secret SECRET          prefer COLAB_MCP_BRIDGE_ADMIN_SECRET env
  --colab-config PATH            google-colab-cli session state file`;
}

if (process.argv[1] === SCRIPT_PATH) {
  loadAndRun().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

async function loadAndRun() {
  await run(loadRecreateRuntimeOptions());
}
