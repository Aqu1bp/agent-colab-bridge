import test from "node:test";
import assert from "node:assert/strict";
import {
  createReconnectRunnerCommand,
  dryRunLines,
  loadReconnectRunnerOptions,
  parseReconnectRunnerArgs,
  renderReconnectHelper,
} from "../scripts/reconnect-runner.mjs";

test("runner reconnect defaults to the named bridge session", () => {
  const options = loadReconnectRunnerOptions({ argv: [], env: {}, cwd: "/tmp/repo" });

  assert.equal(options.colabSession, "agent-colab-bridge");
  assert.equal(options.timeoutSec, 60);
  assert.equal(options.helperPath, "scripts/colab-reconnect-runner.py");
});

test("runner reconnect command uses google-colab-cli exec with optional config", () => {
  const options = loadReconnectRunnerOptions({
    argv: [
      "--colab-session",
      "named",
      "--colab-config",
      "/tmp/colab.json",
      "--timeout",
      "90",
    ],
    env: {},
    cwd: "/tmp/repo",
  });

  assert.deepEqual(createReconnectRunnerCommand(options, "/tmp/helper.py"), [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    "--config",
    "/tmp/colab.json",
    "exec",
    "-s",
    "named",
    "-f",
    "/tmp/helper.py",
    "--timeout",
    "90",
  ]);
});

test("runner reconnect helper can inject a custom project root before constants are read", () => {
  const source = [
    '"""docstring"""',
    "from __future__ import annotations",
    "",
    "import os",
    "from pathlib import Path",
    'PROJECT_ROOT = Path(os.environ.get("COLAB_BRIDGE_PROJECT_ROOT", "/content/project"))',
    "",
  ].join("\n");

  const rendered = renderReconnectHelper(source, "/content/custom");

  assert.match(rendered, /COLAB_BRIDGE_PROJECT_ROOT"\] = "\/content\/custom"/);
  assert.ok(
    rendered.indexOf('COLAB_BRIDGE_PROJECT_ROOT"] = "/content/custom"') <
      rendered.indexOf("PROJECT_ROOT = Path"),
  );
});

test("runner reconnect dry run explains recovery boundary", () => {
  const options = loadReconnectRunnerOptions({
    argv: ["--dry-run", "--project-root", "/content/custom"],
    env: {},
    cwd: "/tmp/repo",
  });
  const text = dryRunLines(options).join("\n");

  assert.match(text, /No Colab commands were executed/);
  assert.match(text, /<generated-reconnect-runner\.py>/);
  assert.match(text, /existing Colab VM still has the previous runner process environment/);
  assert.match(text, /recreate\/bootstrap the runtime instead/);
});

test("runner reconnect parser rejects invalid timeout", () => {
  assert.deepEqual(parseReconnectRunnerArgs(["--colab-session=named"]), {
    colabSession: "named",
  });
  assert.throws(
    () => loadReconnectRunnerOptions({ argv: ["--timeout", "0"], env: {} }),
    /--timeout must be a positive number/,
  );
});
