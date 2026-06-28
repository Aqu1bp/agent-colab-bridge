import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecreateRuntimePlan,
  dryRunLines,
  loadRecreateRuntimeOptions,
  parseRecreateRuntimeArgs,
} from "../scripts/recreate-runtime.mjs";

test("runtime recreate requires an explicit GPU setting", () => {
  assert.throws(
    () => loadRecreateRuntimeOptions({ argv: [], env: {} }),
    /Missing required runtime setting: --gpu/,
  );
});

test("runtime recreate dry run plans stop and setup without exposing admin secret", () => {
  const options = loadRecreateRuntimeOptions({
    argv: [
      "--dry-run",
      "--gpu",
      "L4",
      "--colab-session",
      "named",
      "--admin-secret",
      "admin_secret",
      "--base-url",
      "https://bridge.test",
      "--smoke",
    ],
    env: {},
    cwd: "/tmp/repo",
  });

  const plan = createRecreateRuntimePlan(options);
  const text = dryRunLines(options).join("\n");

  assert.deepEqual(plan[0].command, [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    "stop",
    "-s",
    "named",
  ]);
  assert.deepEqual(plan[1].command.slice(0, 7), [
    process.execPath,
    "scripts/setup-all.mjs",
    "--bootstrap",
    "--gpu",
    "L4",
    "--colab-session",
    "named",
  ]);
  assert.match(text, /Requested GPU: L4/);
  assert.match(text, /--admin-secret <admin-secret-redacted>/);
  assert.doesNotMatch(text, /admin_secret/);
});

test("runtime recreate supports CPU, skip-stop, colab config, and dangerous policy passthrough", () => {
  const options = loadRecreateRuntimeOptions({
    argv: [
      "--gpu",
      "none",
      "--skip-stop",
      "--colab-config",
      "/tmp/colab.json",
      "--enable-dangerous-tools",
      "--project-root",
      "/content/custom",
    ],
    env: {
      COLAB_MCP_BRIDGE_COLAB_SESSION: "from-env",
    },
  });

  const plan = createRecreateRuntimePlan(options);
  const command = plan[0].command.join(" ");

  assert.equal(options.colabSession, "from-env");
  assert.equal(plan.length, 1);
  assert.match(command, /--gpu none/);
  assert.match(command, /--colab-config \/tmp\/colab\.json/);
  assert.match(command, /--enable-dangerous-tools/);
  assert.match(command, /--project-root \/content\/custom/);
});

test("runtime recreate parser accepts yes aliases and boolean dangerous policy", () => {
  assert.deepEqual(
    parseRecreateRuntimeArgs(["--gpu=A100", "-y", "--enable-dangerous-tools=false"]),
    {
      gpu: "A100",
      yes: true,
      enableDangerousTools: "false",
    },
  );
});
