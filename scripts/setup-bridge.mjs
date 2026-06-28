#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  defaultConfigPath,
  firstString,
  mergeBridgeConfig,
  normalizeBaseUrl,
  parseBoolean,
  readExistingConfig,
  redactObject,
  redactSecret,
  resolvePath,
  shellQuote,
  unwrapSessionResponse,
  writeBridgeConfig,
} from "./local-bridge-common.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseSetupArgs(argv) {
  const flags = {};
  const passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--bootstrap") {
      flags.bootstrap = true;
      continue;
    }
    if (arg === "--no-bootstrap") {
      flags.bootstrap = false;
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
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
    const value =
      equalsIndex === -1 ? argv[++index] : arg.slice(equalsIndex + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[toCamelCase(key)] = value;
  }

  return { flags, passthrough };
}

export async function loadSetupOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  readTextFile,
  exists,
} = {}) {
  const { flags, passthrough } = parseSetupArgs(argv);
  if (flags.help) {
    return { help: true };
  }

  const configPath = resolvePath(
    firstString(flags.config, env.COLAB_MCP_BRIDGE_CONFIG, defaultConfigPath()),
    cwd,
  );
  const existingConfig = await readExistingConfig(configPath, {
    readTextFile,
    exists,
  });
  const baseUrl = normalizeBaseUrl(
    firstString(
      flags.baseUrl,
      flags.workerUrl,
      env.COLAB_MCP_BRIDGE_BASE_URL,
      env.COLAB_MCP_BRIDGE_WORKER_URL,
      existingConfig.base_url,
      existingConfig.worker_url,
      existingConfig.baseUrl,
      existingConfig.workerUrl,
    ),
  );
  const adminSecret = firstString(
    flags.adminSecret,
    env.COLAB_MCP_BRIDGE_ADMIN_SECRET,
    env.ADMIN_SECRET,
  );
  const enableDangerousTools =
    parseBoolean(flags.enableDangerousTools, "enable_dangerous_tools") ??
    parseBoolean(env.COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS, "COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS") ??
    parseBoolean(existingConfig.enable_dangerous_tools, "enable_dangerous_tools") ??
    parseBoolean(existingConfig.enableDangerousTools, "enableDangerousTools") ??
    false;

  const missing = [
    !baseUrl ? "--base-url or COLAB_MCP_BRIDGE_BASE_URL" : null,
    !adminSecret ? "--admin-secret or COLAB_MCP_BRIDGE_ADMIN_SECRET" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required setup value(s): ${missing.join(", ")}.`);
  }

  return {
    help: false,
    dryRun: flags.dryRun === true,
    bootstrap: flags.bootstrap === true,
    baseUrl,
    adminSecret,
    configPath,
    existingConfig,
    enableDangerousTools,
    colabSession: firstString(flags.colabSession, flags.colabSessionName),
    gpu: firstString(flags.gpu),
    projectRoot: firstString(flags.projectRoot),
    colabConfig: firstString(flags.colabConfig),
    passthrough,
  };
}

export async function createBridgeSession(options, { fetchFn = fetch } = {}) {
  const response = await fetchFn(`${options.baseUrl}/v1/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.adminSecret}`,
    },
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const detail = json ? ` ${JSON.stringify(redactObject(json))}` : "";
    throw new Error(`Worker session creation failed with HTTP ${response.status}.${detail}`);
  }
  return unwrapSessionResponse(json);
}

export function bootstrapCommandArgs(options) {
  const args = ["scripts/bootstrap-colab.mjs"];
  if (options.colabSession) {
    args.push("--colab-session", options.colabSession);
  }
  if (options.gpu) {
    args.push("--gpu", options.gpu);
  }
  if (options.projectRoot) {
    args.push("--project-root", options.projectRoot);
  }
  if (options.colabConfig) {
    args.push("--colab-config", options.colabConfig);
  }
  if (options.passthrough?.length) {
    args.push("--", ...options.passthrough);
  }
  return args;
}

export function bootstrapEnv(options, session, env = process.env) {
  return {
    ...env,
    COLAB_MCP_BRIDGE_BASE_URL: options.baseUrl,
    COLAB_MCP_BRIDGE_SESSION_ID: session.sessionId,
    COLAB_MCP_BRIDGE_CONTROLLER_TOKEN: session.controllerToken,
    COLAB_MCP_BRIDGE_RUNNER_TOKEN: session.runnerToken,
    ...(options.projectRoot ? { COLAB_MCP_BRIDGE_PROJECT_ROOT: options.projectRoot } : {}),
    ...(options.gpu ? { COLAB_MCP_BRIDGE_GPU: options.gpu } : {}),
    ...(options.colabSession ? { COLAB_MCP_BRIDGE_COLAB_SESSION: options.colabSession } : {}),
    ...(options.colabConfig ? { COLAB_MCP_BRIDGE_COLAB_CONFIG: options.colabConfig } : {}),
  };
}

export function bootstrapGuidanceLines(options, session) {
  const envParts = [
    `COLAB_MCP_BRIDGE_BASE_URL=${shellQuote(options.baseUrl)}`,
    `COLAB_MCP_BRIDGE_SESSION_ID=${shellQuote(session.sessionId)}`,
    "COLAB_MCP_BRIDGE_RUNNER_TOKEN='<runner-token-redacted>'",
    "COLAB_MCP_BRIDGE_CONTROLLER_TOKEN='<controller-token-redacted>'",
  ];
  const command = ["npm", "run", "bootstrap:colab", "--", ...bootstrapCommandArgs(options).slice(1)];
  return [
    "Bootstrap command shape:",
    `  ${envParts.join(" \\\n  ")} \\\n  ${command.map(shellQuote).join(" ")}`,
    "Runner token: set (redacted, not written to local config).",
    "Use --bootstrap to pass the runner token directly to the Colab bootstrap process.",
  ];
}

export function setupSummaryLines(options, session) {
  return [
    `Bridge session: ${session.sessionId}`,
    `Expires at: ${session.expiresAt}`,
    `Admin secret: ${redactSecret(options.adminSecret)}`,
    `Controller token: ${redactSecret(session.controllerToken)}`,
    `Runner token: ${redactSecret(session.runnerToken)}; not persisted`,
    `Local MCP config: ${options.configPath}`,
    `Dangerous tools local policy: ${options.enableDangerousTools ? "enabled" : "disabled"}`,
  ];
}

async function run(options) {
  if (options.help) {
    console.log(helpText());
    return;
  }

  if (options.dryRun) {
    console.log("Dry run only. No Worker session was created and no config was written.");
    console.log(`Worker URL: ${options.baseUrl}`);
    console.log(`Admin secret: ${redactSecret(options.adminSecret)}`);
    console.log(`Local MCP config: ${options.configPath}`);
    return;
  }

  console.log(`Creating bridge session at ${options.baseUrl}.`);
  console.log("Admin, controller, and runner token values will not be printed.");

  const session = await createBridgeSession(options);
  const localConfig = mergeBridgeConfig(options.existingConfig, session, options);
  await writeBridgeConfig(options.configPath, localConfig);

  console.log(setupSummaryLines(options, session).join("\n"));

  if (options.bootstrap) {
    console.log("\nStarting Colab bootstrap with runner token in environment only.");
    const result = await runBootstrap(options, session);
    if (!result.ok) {
      throw new Error(`Colab bootstrap failed with exit code ${result.code}.`);
    }
    return;
  }

  console.log("");
  console.log(bootstrapGuidanceLines(options, session).join("\n"));
}

function runBootstrap(options, session) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, bootstrapCommandArgs(options), {
      stdio: "inherit",
      env: bootstrapEnv(options, session),
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

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/setup-bridge.mjs [flags]

Creates a Worker bridge session, writes the local MCP config, and optionally
starts the existing Colab bootstrap flow without printing token values.

Required values:
  --base-url URL                       or COLAB_MCP_BRIDGE_BASE_URL
  --admin-secret SECRET                or COLAB_MCP_BRIDGE_ADMIN_SECRET

Common flags:
  --config PATH                        default: ${defaultConfigPath()}
  --enable-dangerous-tools[=true|false]
  --bootstrap                          invoke scripts/bootstrap-colab.mjs
  --colab-session NAME                 passed to bootstrap
  --gpu T4                             passed to bootstrap
  --project-root /content/project      passed to bootstrap
  --colab-config PATH                  passed to bootstrap
  --dry-run

Extra args after "--" are passed through to google-colab-cli by bootstrap.`;
}

if (process.argv[1] === SCRIPT_PATH) {
  loadSetupOptions()
    .then(run)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
