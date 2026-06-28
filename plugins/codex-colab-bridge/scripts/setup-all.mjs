#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve as resolveFs } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultConfigPath,
  firstString,
  mergeBridgeConfig,
  normalizeBaseUrl,
  readExistingConfig,
  redactSecret,
  resolvePath,
  shellQuote,
  writeBridgeConfig,
} from "./local-bridge-common.mjs";
import {
  bootstrapCommandArgs,
  bootstrapEnv,
  createBridgeSession,
  setupSummaryLines,
} from "./setup-bridge.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SUPPORTED_PACKAGE_NAME = "codex-colab-bridge";

export function parseSetupAllArgs(argv) {
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
    if (arg === "--bootstrap") {
      flags.bootstrap = true;
      continue;
    }
    if (arg === "--no-bootstrap") {
      flags.bootstrap = false;
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

export async function loadSetupAllOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  exists = existsSync,
  readTextFile = readFile,
  generateSecret = generateAdminSecret,
} = {}) {
  const flags = parseSetupAllArgs(argv);
  if (flags.help) {
    return { help: true };
  }

  const configPath = resolvePath(
    firstString(flags.config, env.COLAB_MCP_BRIDGE_CONFIG, defaultConfigPath()),
    cwd,
  );
  const existingConfig = await readExistingConfig(configPath, {
    exists,
    readTextFile,
  });
  const adminSecretInput = firstString(
    flags.adminSecret,
    env.COLAB_MCP_BRIDGE_ADMIN_SECRET,
    env.ADMIN_SECRET,
  );
  const enableDangerousTools =
    parseBoolean(flags.enableDangerousTools, "enable_dangerous_tools") ??
    parseBoolean(env.COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS, "COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS") ??
    false;

  const explicitBaseUrl = firstString(
    flags.baseUrl,
    env.COLAB_MCP_BRIDGE_BASE_URL,
    env.COLAB_MCP_BRIDGE_WORKER_URL,
  );
  const configuredBaseUrl =
    flags.dryRun === true && !flags.config && !env.COLAB_MCP_BRIDGE_CONFIG
      ? undefined
      : firstString(
          existingConfig.base_url,
          existingConfig.worker_url,
          existingConfig.baseUrl,
          existingConfig.workerUrl,
        );

  return {
    help: false,
    cwd,
    dryRun: flags.dryRun === true,
    baseUrl: normalizeBaseUrl(firstString(explicitBaseUrl, configuredBaseUrl)),
    adminSecret: adminSecretInput ?? generateSecret(),
    adminSecretGenerated: !adminSecretInput,
    bootstrap: flags.bootstrap !== false,
    smoke: flags.smoke === true,
    enableDangerousTools,
    configPath,
    existingConfig,
    colabSession: firstString(flags.colabSession, env.COLAB_MCP_BRIDGE_COLAB_SESSION),
    gpu: firstString(flags.gpu, env.COLAB_MCP_BRIDGE_GPU),
    projectRoot: firstString(flags.projectRoot, env.COLAB_MCP_BRIDGE_PROJECT_ROOT),
    colabConfig: firstString(flags.colabConfig, env.COLAB_MCP_BRIDGE_COLAB_CONFIG),
  };
}

export function generateAdminSecret() {
  return randomBytes(32).toString("base64url");
}

export function createSetupAllPlan(options) {
  const plan = [
    { label: "Check Node/package prerequisites", command: ["node", "--version"] },
    { label: "Check Wrangler availability", command: wranglerCommand("--version") },
  ];
  if (options.bootstrap) {
    plan.push(
      { label: "Check uvx availability", command: ["uvx", "--version"] },
      {
        label: "Check google-colab-cli availability",
        command: ["uvx", "--from", "google-colab-cli", "colab", "--help"],
      },
    );
  }
  plan.push(
    {
      label: "Set Cloudflare ADMIN_SECRET",
      command: wranglerCommand("secret", "put", "ADMIN_SECRET"),
      stdin: "<admin-secret-redacted>",
    },
    {
      label: "Set Cloudflare dangerous-tools policy",
      command: wranglerCommand("secret", "put", "COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS"),
      stdin: options.enableDangerousTools ? "1" : "0",
    },
  );
  plan.push(
    { label: "Deploy Worker", command: wranglerCommand("deploy") },
    {
      label: "Create bridge session",
      request: `${options.baseUrl ?? "<worker-url-from-deploy>"}/v1/sessions`,
      authorization: "<admin-secret-redacted>",
    },
    { label: "Write local MCP config", path: options.configPath },
  );
  if (options.bootstrap) {
    plan.push({
      label: "Bootstrap Colab",
      command: [process.execPath, ...bootstrapCommandArgs(options)],
      env: {
        COLAB_MCP_BRIDGE_RUNNER_TOKEN: "<runner-token-redacted>",
        COLAB_MCP_BRIDGE_CONTROLLER_TOKEN: "<controller-token-redacted>",
      },
    });
  }
  if (options.smoke) {
    plan.push({
      label: "Run MCP smoke",
      command: smokeCommand(options),
    });
  }
  return plan;
}

export function dryRunLines(options) {
  const lines = [
    "Dry run only. No Wrangler, Worker, Colab, smoke, or file-write actions will run.",
    `Admin secret: ${options.adminSecretGenerated ? "generated for real run (redacted)" : redactSecret(options.adminSecret)}`,
    `Worker URL: ${options.baseUrl ?? "derived from Wrangler deploy output; pass --base-url if needed"}`,
    `Local MCP config: ${options.configPath}`,
    `Colab bootstrap: ${options.bootstrap ? "enabled" : "disabled"}`,
    `MCP smoke: ${options.smoke ? "enabled" : "disabled"}`,
    `Dangerous tools: ${options.enableDangerousTools ? "enabled" : "disabled"}`,
    "",
    "Planned commands:",
  ];
  for (const item of createSetupAllPlan(options)) {
    lines.push(`- ${item.label}`);
    if (item.command) {
      lines.push(`  ${formatCommand(item.command)}`);
    }
    if (item.stdin) {
      lines.push(`  stdin: ${item.stdin}`);
    }
    if (item.request) {
      lines.push(`  POST ${item.request}`);
      lines.push(`  Authorization: Bearer ${item.authorization}`);
    }
    if (item.path) {
      lines.push(`  ${item.path}`);
    }
    if (item.env) {
      for (const [key, value] of Object.entries(item.env)) {
        lines.push(`  ${key}=${value}`);
      }
    }
  }
  lines.push("");
  lines.push(...codexNextStepLines(options));
  return lines;
}

export async function collectSetupAllPrerequisites(
  options,
  {
    exists = existsSync,
    readTextFile = readFile,
    runCommand = runCommandCapture,
    nodeVersion = process.version,
  } = {},
) {
  const checks = [nodeCheck(nodeVersion)];
  checks.push(await packageCheck(resolvePath("package.json", options.cwd), { exists, readTextFile }));
  checks.push(await commandCheck("wrangler", wranglerCommand("--version"), runCommand));
  if (options.bootstrap) {
    checks.push(await commandCheck("uvx", ["uvx", "--version"], runCommand));
    checks.push(
      await commandCheck(
        "google-colab-cli",
        ["uvx", "--from", "google-colab-cli", "colab", "--help"],
        runCommand,
      ),
    );
  }
  return checks;
}

export function formatSetupAllCheck(check) {
  return `${check.status.toUpperCase()} ${check.name}: ${check.message}`;
}

export function parseWorkerUrlFromWranglerOutput(output) {
  const matches = String(output ?? "").match(/https?:\/\/[^\s"'`<>]+/g) ?? [];
  const cleaned = matches.map(cleanWranglerUrl).filter(Boolean);
  return cleaned.find((url) => /\.workers\.dev(?:\/|$)/.test(url)) ?? cleaned[0];
}

export function resolveWorkerUrl(options, deployOutput) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? parseWorkerUrlFromWranglerOutput(deployOutput));
  if (!baseUrl) {
    throw new Error("Could not derive Worker URL from Wrangler deploy output. Re-run with --base-url https://<worker>.<subdomain>.workers.dev.");
  }
  return baseUrl;
}

export function codexNextStepLines(options) {
  return [
    "Codex app next steps:",
    `  Use local MCP config: ${options.configPath}`,
    `  Local checkout install: codex plugin marketplace add ${shellQuote(options.cwd)}`,
    "  Then install: codex plugin add codex-colab-bridge@codex-colab-bridge",
    "  Start a new Codex thread after installing so the plugin tools and skill are loaded.",
    "  No admin, controller, or runner token values are printed here.",
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

  console.log("Checking local prerequisites.");
  const checks = await collectSetupAllPrerequisites(options);
  for (const check of checks) {
    console.log(formatSetupAllCheck(check));
  }
  const failures = checks.filter((check) => check.status === "fail");
  if (failures.length > 0) {
    throw new Error("Setup prerequisites failed; fix the failing checks and re-run setup:all.");
  }

  console.log("\nSetting Cloudflare ADMIN_SECRET (value redacted).");
  await putWranglerSecret("ADMIN_SECRET", options.adminSecret, { cwd: options.cwd });
  console.log(`Setting Cloudflare dangerous-tools policy to ${options.enableDangerousTools ? "enabled" : "disabled"}.`);
  await putWranglerSecret("COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS", options.enableDangerousTools ? "1" : "0", {
    cwd: options.cwd,
  });

  console.log("\nDeploying Worker.");
  const deploy = await runCommandCapture(wranglerCommand("deploy"), { cwd: options.cwd });
  writeCapturedOutput(deploy);
  if (!deploy.ok) {
    throw new Error(`Wrangler deploy failed with exit code ${deploy.code}.`);
  }

  const baseUrl = resolveWorkerUrl(options, `${deploy.stdout}\n${deploy.stderr}`);
  console.log(`Worker URL: ${baseUrl}`);
  console.log("Creating bridge session. Token values will not be printed.");

  const session = await createBridgeSession({ ...options, baseUrl });
  const localConfig = mergeBridgeConfig(options.existingConfig, session, {
    ...options,
    baseUrl,
  });
  await writeBridgeConfig(options.configPath, localConfig);
  console.log(setupSummaryLines({ ...options, baseUrl }, session).join("\n"));

  if (options.bootstrap) {
    console.log("\nStarting Colab bootstrap with runner token in child environment only.");
    const result = await runNodeChild(bootstrapCommandArgs(options), {
      cwd: options.cwd,
      env: bootstrapEnv({ ...options, baseUrl }, session, process.env),
    });
    if (!result.ok) {
      throw new Error(`Colab bootstrap failed with exit code ${result.code}.`);
    }
  }

  if (options.smoke) {
    console.log("\nRunning MCP smoke.");
    const result = await runCommandInherit(smokeCommand(options), { cwd: options.cwd });
    if (!result.ok) {
      throw new Error(`MCP smoke failed with exit code ${result.code}.`);
    }
  }

  console.log("");
  console.log(codexNextStepLines({ ...options, baseUrl }).join("\n"));
}

async function packageCheck(packageJsonPath, { exists, readTextFile }) {
  if (!exists(packageJsonPath)) {
    return fail("package.json", "package.json was not found in this repository.");
  }
  try {
    const parsed = JSON.parse(await readTextFile(packageJsonPath, "utf8"));
    if (parsed?.name !== SUPPORTED_PACKAGE_NAME) {
      return fail(
        "package.json",
        `Unexpected package name ${JSON.stringify(parsed?.name)}; expected ${SUPPORTED_PACKAGE_NAME}.`,
      );
    }
    return pass("package.json", `${parsed.name} package is present.`);
  } catch (error) {
    return fail("package.json", `package.json could not be read as JSON: ${error.message}`);
  }
}

function nodeCheck(version) {
  const match = /^v?(\d+)\./.exec(version);
  if (!match) {
    return fail("node", `Could not parse Node version ${version}.`);
  }
  const major = Number(match[1]);
  if (major < 20) {
    return fail("node", `Node ${version} is too old; install Node 20 or newer.`);
  }
  return pass("node", `Node ${version} is supported.`);
}

async function commandCheck(name, command, runCommand) {
  const result = await runCommand(command, { timeoutMs: 15_000 });
  if (result.ok) {
    return pass(name, `${formatCommand(command)} is available.`);
  }
  if (result.timedOut) {
    return fail(name, `${formatCommand(command)} timed out.`);
  }
  return fail(name, `${formatCommand(command)} is not available.`);
}

function putWranglerSecret(name, value, { cwd = process.cwd() } = {}) {
  return runCommandCapture(wranglerCommand("secret", "put", name), {
    cwd,
    input: `${value}\n`,
  }).then((result) => {
    writeCapturedOutput(redactCapturedOutput(result, value));
    if (!result.ok) {
      throw new Error(`Wrangler secret put ${name} failed with exit code ${result.code}.`);
    }
  });
}

function runNodeChild(args, options) {
  return runCommandInherit([process.execPath, ...args], options);
}

function runCommandInherit(command, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
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

function runCommandCapture(command, { cwd = process.cwd(), env = process.env, input, timeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout;
    if (timeoutMs) {
      timeout = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        resolvePromise({ ok: false, code: null, stdout, stderr, timedOut: true });
      }, timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!settled) {
        settled = true;
        resolvePromise({ ok: false, code: 127, stdout, stderr, error, timedOut: false });
      }
    });
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!settled) {
        settled = true;
        resolvePromise({ ok: code === 0, code: code ?? 1, stdout, stderr, timedOut: false });
      }
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function writeCapturedOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function redactCapturedOutput(result, secret) {
  if (!secret) {
    return result;
  }
  return {
    ...result,
    stdout: result.stdout.replaceAll(secret, "<redacted>"),
    stderr: result.stderr.replaceAll(secret, "<redacted>"),
  };
}

function wranglerCommand(...args) {
  const localWrangler = resolveFs(
    dirname(SCRIPT_PATH),
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  if (existsSync(localWrangler)) {
    return ["npx", "--no-install", "wrangler", ...args];
  }
  return ["npx", "--yes", "wrangler", ...args];
}

function smokeCommand(options) {
  const command = ["npm", "run", "smoke:mcp"];
  if (options.enableDangerousTools) {
    command.push("--", "--dangerous");
  }
  return command;
}

function cleanWranglerUrl(value) {
  let url = value.trim().replace(/[),.;]+$/g, "");
  url = url.replace(/\/\*$/, "");
  return normalizeBaseUrl(url);
}

function parseBoolean(value, label = "value") {
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

function pass(name, message) {
  return { status: "pass", name, message };
}

function fail(name, message) {
  return { status: "fail", name, message };
}

function formatCommand(command) {
  return command.map((part) => shellQuote(String(part))).join(" ");
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/setup-all.mjs [flags]

Guided first-time setup for deploying the Worker, creating a bridge session,
writing local MCP config, and bootstrapping Colab.

Common flags:
  --base-url URL                 fallback if Wrangler deploy output has no URL
  --admin-secret SECRET          generated when omitted; prefer env with npm run
  --enable-dangerous-tools       opt in to dangerous Worker/local tools
  --bootstrap                    bootstrap Colab; default
  --no-bootstrap                 skip Colab bootstrap
  --colab-session NAME           passed to bootstrap
  --gpu T4                       passed to bootstrap
  --project-root /content/path   passed to bootstrap
  --colab-config PATH            passed to google-colab-cli by bootstrap
  --smoke                        run MCP smoke after bootstrap
  --config PATH                  local MCP config path; default: ${defaultConfigPath()}
  --dry-run                      print redacted plan without running commands or writing files
  --help`;
}

if (process.argv[1] === SCRIPT_PATH) {
  loadSetupAllOptions()
    .then(run)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
