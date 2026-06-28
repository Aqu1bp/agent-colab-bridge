import test from "node:test";
import assert from "node:assert/strict";
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
      stdout: "[colab] Session 'codex-colab-bridge' not found.\n",
      stderr: "",
    }),
    false,
  );
  assert.equal(
    isUsableColabStatusResult({
      ok: true,
      code: 0,
      stdout: "[codex-colab-bridge] gpu-t4 | Hardware: T4 | Variant: GPU\n",
      stderr: "",
    }),
    true,
  );
});

async function neverRead() {
  throw new Error("config file should not be read");
}
