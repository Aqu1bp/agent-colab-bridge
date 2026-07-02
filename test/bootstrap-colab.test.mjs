import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createCommandPlan,
  dryRunLines,
  isUsableColabStatusResult,
  loadBootstrapOptions,
  renderRunnerEnvConfig,
  renderRunnerStartScript,
  statusHintLines,
} from "../scripts/bootstrap-colab.mjs";

const requiredEnv = {
  COLAB_MCP_BRIDGE_BASE_URL: "https://bridge.test",
  COLAB_MCP_BRIDGE_SESSION_ID: "sess_test",
  COLAB_MCP_BRIDGE_RUNNER_TOKEN: "runner_secret",
};

test("bootstrap options require bridge URL, session id, and runner token", async () => {
  await assert.rejects(
    () => loadBootstrapOptions({ argv: [], env: {}, readTextFile: neverRead }),
    /Missing required bootstrap value\(s\):/,
  );
});

test("bootstrap command plan uses google-colab-cli through uvx", async () => {
  const options = await loadBootstrapOptions({
    argv: ["--dry-run", "--colab-session", "named-session", "--gpu", "T4"],
    env: requiredEnv,
    readTextFile: neverRead,
  });

  assert.equal(options.colabSessionName, "named-session");
  const plan = createCommandPlan(options);
  assert.deepEqual(plan[1].command.slice(0, 5), [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    "new",
  ]);
  assert.deepEqual(plan[1].command.slice(-4), ["-s", "named-session", "--gpu", "T4"]);
  assert.ok(plan.some((step) => step.command.includes("upload")));
  assert.ok(plan.some((step) => step.command.includes("install")));
});

test("bootstrap does not request a GPU unless explicitly configured", async () => {
  const options = await loadBootstrapOptions({
    argv: ["--dry-run", "--colab-session", "named-session"],
    env: requiredEnv,
    readTextFile: neverRead,
  });

  const plan = createCommandPlan(options);
  assert.deepEqual(plan[1].command.slice(-3), ["new", "-s", "named-session"]);
  assert.equal(plan[1].command.includes("--gpu"), false);
});

test("dry run output does not expose token values", async () => {
  const options = await loadBootstrapOptions({
    argv: ["--dry-run"],
    env: {
      ...requiredEnv,
      COLAB_MCP_BRIDGE_CONTROLLER_TOKEN: "controller_secret",
    },
    readTextFile: neverRead,
  });

  const text = dryRunLines(options).join("\n");
  assert.match(text, /Runner token: set \(redacted\)/);
  assert.doesNotMatch(text, /runner_secret/);
  assert.doesNotMatch(text, /controller_secret/);
  assert.match(text, /Upload the runner bootstrap config/);
});

test("generated runner start code reads token config without embedding or printing token", async () => {
  const options = await loadBootstrapOptions({
    argv: [],
    env: requiredEnv,
    readTextFile: neverRead,
  });

  const source = renderRunnerStartScript(options);
  assert.match(source, /env\['COLAB_BRIDGE_URL'\] = config\['base_url'\]/);
  assert.match(source, /env\['COLAB_BRIDGE_SESSION_ID'\] = config\['session_id'\]/);
  assert.match(source, /env\['COLAB_BRIDGE_RUNNER_TOKEN'\] = config\['runner_token'\]/);
  assert.match(source, /env\['COLAB_BRIDGE_PROJECT_ROOT'\] = config\['project_root'\]/);
  assert.match(source, /env\.setdefault\('PYTHONUNBUFFERED', '1'\)/);
  assert.match(source, /RUNNER_TOKEN=set/);
  assert.match(source, /config_path\.unlink/);
  assert.doesNotMatch(source, /runner_secret/);
});

test("generated runner env config carries the runner token for upload only", async () => {
  const options = await loadBootstrapOptions({
    argv: [],
    env: requiredEnv,
    readTextFile: neverRead,
  });

  const config = JSON.parse(renderRunnerEnvConfig(options));
  assert.deepEqual(config, {
    base_url: "https://bridge.test",
    session_id: "sess_test",
    runner_token: "runner_secret",
    project_root: "/content/project",
  });
});

test("status hints use env references instead of token values", async () => {
  const options = await loadBootstrapOptions({
    argv: [],
    env: {
      ...requiredEnv,
      COLAB_MCP_BRIDGE_CONTROLLER_TOKEN: "controller_secret",
    },
    readTextFile: neverRead,
  });

  const text = statusHintLines(options).join("\n");
  assert.match(text, /\$COLAB_MCP_BRIDGE_CONTROLLER_TOKEN/);
  assert.doesNotMatch(text, /controller_secret/);
});

test("bootstrap treats google-colab-cli not-found status output as missing session", () => {
  assert.equal(
    isUsableColabStatusResult({
      ok: true,
      code: 0,
      stdout: "[colab] Session 'agent-colab-bridge' not found.\n",
      stderr: "",
    }),
    false,
  );
  assert.equal(
    isUsableColabStatusResult({
      ok: true,
      code: 0,
      stdout: "[agent-colab-bridge] gpu-t4 | Hardware: T4 | Variant: GPU\n",
      stderr: "",
    }),
    true,
  );
});

test("bootstrap continues when Colab new reports an error but creates the session", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "colab-bootstrap-test-"));
  try {
    const createdFlag = resolve(tempDir, "created");
    const uvx = resolve(tempDir, "uvx");
    await writeFile(
      uvx,
      [
        "#!/bin/sh",
        `created=${JSON.stringify(createdFlag)}`,
        "case \"$*\" in",
        "  *' colab status '*)",
        "    if [ -f \"$created\" ]; then",
        "      printf '%s\\n' '[agent-colab-bridge] gpu-l4 | Hardware: L4 | Variant: GPU | Status: IDLE'",
        "    else",
        "      printf '%s\\n' \"[colab] Session 'agent-colab-bridge' not found.\"",
        "    fi",
        "    exit 0",
        "    ;;",
        "  *' colab new '*)",
        "    touch \"$created\"",
        "    printf '%s\\n' 'INTERNAL_ERROR: runtime creation failed after allocation' >&2",
        "    exit 1",
        "    ;;",
        "  *' colab url '*)",
        "    printf '%s\\n' 'https://colab.research.google.com/notebooks/empty.ipynb'",
        "    exit 0",
        "    ;;",
        "  *)",
        "    exit 0",
        "    ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = await runNodeScript(["scripts/bootstrap-colab.mjs", "--gpu", "L4"], {
      ...requiredEnv,
      PATH: `${tempDir}:${process.env.PATH ?? ""}`,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Colab session became available after the create command failed/);
    assert.match(result.stdout, /Start the runner in the Colab runtime/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function neverRead() {
  throw new Error("config file should not be read");
}

function runNodeScript(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
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
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}
