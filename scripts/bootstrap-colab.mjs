#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_COLAB_SESSION_NAME = "colab-mcp-bridge";
const DEFAULT_PROJECT_ROOT = "/content/project";
const DEFAULT_RUNNER_PATH = "python/colab_runner.py";
const DEFAULT_REMOTE_RUNNER_NAME = "colab_runner.py";
const DEFAULT_REMOTE_CONFIG_NAME = ".colab_mcp_runner_env.json";
const DEFAULT_GPU = "T4";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const flags = {};
  const passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
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

  return { flags, passthrough };
}

export async function loadBootstrapOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  readTextFile = readFile,
} = {}) {
  const { flags, passthrough } = parseArgs(argv);
  if (flags.help) {
    return { help: true };
  }

  const configPath =
    flags.bridgeConfig ?? env.COLAB_MCP_BRIDGE_BOOTSTRAP_CONFIG;
  const config = configPath
    ? JSON.parse(await readTextFile(resolve(cwd, configPath), "utf8"))
    : {};

  const baseUrl = firstString(
    flags.baseUrl,
    flags.workerUrl,
    env.COLAB_MCP_BRIDGE_BASE_URL,
    env.COLAB_MCP_BRIDGE_WORKER_URL,
    config.base_url,
    config.worker_url,
    config.baseUrl,
    config.workerUrl,
  );
  const sessionId = firstString(
    flags.sessionId,
    env.COLAB_MCP_BRIDGE_SESSION_ID,
    config.session_id,
    config.sessionId,
  );
  const runnerToken = firstString(
    flags.runnerToken,
    env.COLAB_MCP_BRIDGE_RUNNER_TOKEN,
    config.runner_token,
    config.runnerToken,
  );
  const controllerToken = firstString(
    flags.controllerToken,
    env.COLAB_MCP_BRIDGE_CONTROLLER_TOKEN,
    config.controller_token,
    config.controllerToken,
  );

  const missing = [
    !baseUrl ? "COLAB_MCP_BRIDGE_BASE_URL or COLAB_MCP_BRIDGE_WORKER_URL" : null,
    !sessionId ? "COLAB_MCP_BRIDGE_SESSION_ID" : null,
    !runnerToken ? "COLAB_MCP_BRIDGE_RUNNER_TOKEN" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required bootstrap value(s): ${missing.join(", ")}.`);
  }

  const projectRoot = firstString(
    flags.projectRoot,
    env.COLAB_MCP_BRIDGE_PROJECT_ROOT,
    config.project_root,
    config.projectRoot,
    DEFAULT_PROJECT_ROOT,
  );
  const localRunnerPath = resolve(
    cwd,
    firstString(
      flags.runnerPath,
      env.COLAB_MCP_BRIDGE_RUNNER_PATH,
      config.runner_path,
      config.runnerPath,
      DEFAULT_RUNNER_PATH,
    ),
  );
  const remoteRunnerPath = firstString(
    flags.remoteRunnerPath,
    env.COLAB_MCP_BRIDGE_REMOTE_RUNNER_PATH,
    config.remote_runner_path,
    config.remoteRunnerPath,
    `${projectRoot.replace(/\/+$/, "")}/${DEFAULT_REMOTE_RUNNER_NAME}`,
  );
  const remoteConfigPath = firstString(
    flags.remoteConfigPath,
    env.COLAB_MCP_BRIDGE_REMOTE_CONFIG_PATH,
    config.remote_config_path,
    config.remoteConfigPath,
    `${projectRoot.replace(/\/+$/, "")}/${DEFAULT_REMOTE_CONFIG_NAME}`,
  );

  return {
    help: false,
    dryRun: flags.dryRun === true,
    baseUrl,
    sessionId,
    runnerToken,
    controllerToken,
    colabSessionName: firstString(
      flags.colabSession,
      flags.colabSessionName,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION,
      env.COLAB_MCP_BRIDGE_COLAB_SESSION_NAME,
      config.colab_session,
      config.colabSession,
      config.colabSessionName,
      DEFAULT_COLAB_SESSION_NAME,
    ),
    projectRoot,
    localRunnerPath,
    remoteRunnerPath,
    remoteConfigPath,
    gpu: firstString(flags.gpu, env.COLAB_MCP_BRIDGE_GPU, config.gpu, DEFAULT_GPU),
    colabConfig: firstString(
      flags.colabConfig,
      env.COLAB_MCP_BRIDGE_COLAB_CONFIG,
      config.colab_config,
      config.colabConfig,
    ),
    passthrough,
  };
}

export function createCommandPlan(options) {
  return [
    {
      label: "Check for an existing named Colab session",
      command: colabCommand(options, ["status", "-s", options.colabSessionName]),
      optional: true,
    },
    {
      label: `Create a named Colab session${gpuLabel(options.gpu)}`,
      command: colabCommand(options, [
        "new",
        "-s",
        options.colabSessionName,
        ...gpuArgs(options.gpu),
      ]),
      runIfStatusMissing: true,
    },
    {
      label: "Install Python runtime dependency in Colab",
      command: colabCommand(options, [
        "install",
        "-s",
        options.colabSessionName,
        "websockets",
      ]),
    },
    {
      label: "Create the project root in Colab",
      command: colabCommand(options, [
        "exec",
        "-s",
        options.colabSessionName,
        "-f",
        "<generated-project-root-script.py>",
      ]),
      generatedFile: "project-root",
    },
    {
      label: "Upload the runner bootstrap config",
      command: colabCommand(options, [
        "upload",
        "-s",
        options.colabSessionName,
        "<generated-runner-env.json>",
        options.remoteConfigPath,
      ]),
      generatedFile: "runner-env",
    },
    {
      label: "Upload the Colab runner",
      command: colabCommand(options, [
        "upload",
        "-s",
        options.colabSessionName,
        options.localRunnerPath,
        options.remoteRunnerPath,
      ]),
    },
    {
      label: "Start the runner in the Colab runtime",
      command: colabCommand(options, [
        "exec",
        "-s",
        options.colabSessionName,
        "-f",
        "<generated-runner-start-script.py>",
      ]),
      generatedFile: "runner-start",
    },
    {
      label: "Show Colab session status",
      command: colabCommand(options, ["status", "-s", options.colabSessionName]),
    },
    {
      label: "Show Colab notebook URL",
      command: colabCommand(options, ["url", "-s", options.colabSessionName]),
    },
  ];
}

export function colabCommand(options, args) {
  return [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    ...(options.colabConfig ? ["--config", options.colabConfig] : []),
    ...(options.passthrough ?? []),
    ...args,
  ];
}

export function renderProjectRootScript(options) {
  return [
    "from pathlib import Path",
    `project_root = Path(${JSON.stringify(options.projectRoot)})`,
    "project_root.mkdir(parents=True, exist_ok=True)",
    "print(f'PROJECT_ROOT_READY={project_root}')",
    "",
  ].join("\n");
}

export function renderRunnerStartScript(options) {
  return [
    "from pathlib import Path",
    "import json",
    "import os",
    "import subprocess",
    "import sys",
    "",
    `project_root = Path(${JSON.stringify(options.projectRoot)})`,
    `runner_path = Path(${JSON.stringify(options.remoteRunnerPath)})`,
    `config_path = Path(${JSON.stringify(options.remoteConfigPath)})`,
    "config = json.loads(config_path.read_text(encoding='utf-8'))",
    "try:",
    "    config_path.unlink()",
    "except FileNotFoundError:",
    "    pass",
    "project_root.mkdir(parents=True, exist_ok=True)",
    "log_path = project_root / 'colab_mcp_runner.log'",
    "pid_path = project_root / '.colab_mcp_runner.pid'",
    "env = os.environ.copy()",
    "env['COLAB_BRIDGE_URL'] = config['base_url']",
    "env['COLAB_BRIDGE_SESSION_ID'] = config['session_id']",
    "env['COLAB_BRIDGE_RUNNER_TOKEN'] = config['runner_token']",
    "env['COLAB_BRIDGE_PROJECT_ROOT'] = config['project_root']",
    "log_handle = open(log_path, 'ab', buffering=0)",
    "process = subprocess.Popen(",
    "    [sys.executable, str(runner_path)],",
    "    cwd=str(project_root),",
    "    env=env,",
    "    stdin=subprocess.DEVNULL,",
    "    stdout=log_handle,",
    "    stderr=subprocess.STDOUT,",
    "    start_new_session=True,",
    ")",
    "pid_path.write_text(str(process.pid), encoding='utf-8')",
    "print(f\"SESSION_ID={config['session_id']}\")",
    "print(f\"BRIDGE_URL={config['base_url']}\")",
    'print("RUNNER_STATUS=start_requested")',
    'print("RUNNER_TOKEN=set")',
    "print(f'RUNNER_PID={process.pid}')",
    "print(f'RUNNER_LOG={log_path}')",
    "",
  ].join("\n");
}

export function renderRunnerEnvConfig(options) {
  return `${JSON.stringify(
    {
      base_url: options.baseUrl,
      session_id: options.sessionId,
      runner_token: options.runnerToken,
      project_root: options.projectRoot,
    },
    null,
    2,
  )}\n`;
}

export function formatCommand(command) {
  return command.map(shellQuote).join(" ");
}

export function dryRunLines(options) {
  const lines = [
    "Dry run only. No Colab commands were executed.",
    `Colab session: ${options.colabSessionName}`,
    `Bridge URL: ${options.baseUrl}`,
    `Bridge session: ${options.sessionId}`,
    "Runner token: set (redacted)",
    "",
  ];
  for (const step of createCommandPlan(options)) {
    lines.push(`${step.label}:`);
    lines.push(`  ${formatCommand(step.command)}`);
  }
  lines.push("");
  lines.push(...statusHintLines(options));
  return lines;
}

export function statusHintLines(options) {
  const statusUrl = `${options.baseUrl.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(
    options.sessionId,
  )}/status`;
  return [
    "Next status checks:",
    `  npm run build && COLAB_MCP_BRIDGE_BASE_URL=${shellQuote(
      options.baseUrl,
    )} COLAB_MCP_BRIDGE_SESSION_ID=${shellQuote(
      options.sessionId,
    )} COLAB_MCP_BRIDGE_CONTROLLER_TOKEN='<controller-token>' node dist/src/mcp-server.js`,
    `  curl -fsS ${shellQuote(statusUrl)} -H 'Authorization: Bearer $COLAB_MCP_BRIDGE_CONTROLLER_TOKEN' -H "X-Bridge-Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" -H "X-Bridge-Nonce: bootstrap_$(uuidgen)"`,
    "Use google-colab-cli upload/download or external storage for large artifacts; do not route checkpoints or datasets through Cloudflare.",
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

  console.log(`Bootstrapping Colab session ${options.colabSessionName}.`);
  console.log("Runner/controller token values will not be printed.");

  const statusStep = createCommandPlan(options)[0];
  const hasSession = await runCommand(statusStep.command, { quiet: true });
  if (hasSession.ok) {
    console.log(`Reusing existing Colab session ${options.colabSessionName}.`);
  } else {
    const createStep = createCommandPlan(options)[1];
    await runRequiredStep(createStep);
  }

  const tempDir = await mkdtemp(resolve(tmpdir(), "colab-mcp-bootstrap-"));
  try {
    const projectRootScript = resolve(tempDir, "project-root.py");
    const runnerEnvConfig = resolve(tempDir, "runner-env.json");
    const runnerStartScript = resolve(tempDir, "runner-start.py");
    await writeFile(projectRootScript, renderProjectRootScript(options), { mode: 0o600 });
    await writeFile(runnerEnvConfig, renderRunnerEnvConfig(options), { mode: 0o600 });
    await writeFile(runnerStartScript, renderRunnerStartScript(options), { mode: 0o600 });

    const steps = createCommandPlan(options).slice(2).map((step) => {
      if (step.generatedFile === "project-root") {
        return { ...step, command: replaceGeneratedPath(step.command, projectRootScript) };
      }
      if (step.generatedFile === "runner-env") {
        return { ...step, command: replaceGeneratedPath(step.command, runnerEnvConfig) };
      }
      if (step.generatedFile === "runner-start") {
        return { ...step, command: replaceGeneratedPath(step.command, runnerStartScript) };
      }
      return step;
    });

    for (const step of steps) {
      await runRequiredStep(step);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  if (options.controllerToken) {
    await pollBridgeStatus(options);
  } else {
    console.log("No controller token was provided, so HTTP status polling was skipped.");
  }

  console.log(statusHintLines(options).join("\n"));
}

async function runRequiredStep(step) {
  console.log(`\n${step.label}`);
  console.log(formatCommand(step.command));
  const result = await runCommand(step.command);
  if (!result.ok) {
    throw new Error(`Command failed with exit code ${result.code}: ${formatCommand(step.command)}`);
  }
}

function runCommand(command, { quiet = false } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    child.on("error", (error) => {
      if (!quiet) {
        console.error(error.message);
      }
      resolvePromise({ ok: false, code: 127 });
    });
    child.on("close", (code) => {
      resolvePromise({ ok: code === 0, code: code ?? 1 });
    });
  });
}

async function pollBridgeStatus(options) {
  const statusUrl = `${options.baseUrl.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(
    options.sessionId,
  )}/status`;
  console.log("\nPolling bridge status with controller token (value redacted).");
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(statusUrl, {
        headers: {
          Authorization: `Bearer ${options.controllerToken}`,
          "X-Bridge-Timestamp": new Date().toISOString(),
          "X-Bridge-Nonce": `bootstrap_${randomUUID().replaceAll("-", "")}`,
        },
      });
      const envelope = await response.json();
      const data = envelope && typeof envelope === "object" ? envelope.data : null;
      if (response.ok && data?.runner_connected === true) {
        console.log("Bridge status: runner_connected=true");
        return;
      }
      console.log(`Bridge status attempt ${attempt}: runner not connected yet.`);
    } catch (error) {
      console.log(`Bridge status attempt ${attempt}: ${error.message}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
  }
}

function replaceGeneratedPath(command, path) {
  return command.map((item) =>
    item.startsWith("<generated-") && item.endsWith(">") ? path : item,
  );
}

function gpuArgs(gpu) {
  if (!gpu || ["none", "false", "0", "off"].includes(String(gpu).toLowerCase())) {
    return [];
  }
  return ["--gpu", String(gpu)];
}

function gpuLabel(gpu) {
  const args = gpuArgs(gpu);
  return args.length > 0 ? ` requesting ${args[1]}` : "";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function helpText() {
  return `Usage: node scripts/bootstrap-colab.mjs [flags]

Required values can come from env, --bridge-config JSON, or flags:
  COLAB_MCP_BRIDGE_BASE_URL or COLAB_MCP_BRIDGE_WORKER_URL
  COLAB_MCP_BRIDGE_SESSION_ID
  COLAB_MCP_BRIDGE_RUNNER_TOKEN

Common flags:
  --dry-run
  --base-url URL
  --session-id ID
  --runner-token TOKEN
  --controller-token TOKEN
  --colab-session NAME       default: ${DEFAULT_COLAB_SESSION_NAME}
  --gpu T4                   default: ${DEFAULT_GPU}; use "none" to skip
  --project-root PATH        default: ${DEFAULT_PROJECT_ROOT}
  --runner-path PATH         default: ${DEFAULT_RUNNER_PATH}
  --remote-runner-path PATH  default: <project-root>/${DEFAULT_REMOTE_RUNNER_NAME}
  --remote-config-path PATH  default: <project-root>/${DEFAULT_REMOTE_CONFIG_NAME}
  --bridge-config PATH       explicit JSON config for bridge/bootstrap values
  --colab-config PATH        passed to google-colab-cli as --config

Extra args after "--" are passed to google-colab-cli before each subcommand.
Use them only for global colab CLI flags.`;
}

if (process.argv[1] === SCRIPT_PATH) {
  loadBootstrapOptions()
    .then(run)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
