import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("runner reconnect fails when Colab reports a traceback despite zero CLI exit", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "colab-reconnect-test-"));
  try {
    const uvx = resolve(tempDir, "uvx");
    await writeFile(
      uvx,
      [
        "#!/bin/sh",
        "printf '%s\\n' 'Traceback (most recent call last)' >&2",
        "printf '%s\\n' 'RuntimeError: Runner pid file is missing: /content/project/.colab_mcp_runner.pid' >&2",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = await runNodeScript(["scripts/reconnect-runner.mjs", "--timeout", "1"], {
      PATH: `${tempDir}:${process.env.PATH ?? ""}`,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Runner pid file is missing/);
    assert.match(result.stderr, /did not report RUNNER_STATUS=reconnect_requested/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runner reconnect helper refuses to stop an unrelated pid-file process", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "colab-reconnect-pid-test-"));
  try {
    const projectRoot = join(tempDir, "project");
    const procRoot = join(tempDir, "proc");
    const processRoot = join(procRoot, "4242");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(processRoot, { recursive: true });
    await writeFile(join(projectRoot, ".colab_mcp_runner.pid"), "4242", "utf8");
    await writeFile(
      join(processRoot, "environ"),
      [
        "COLAB_BRIDGE_URL=https://bridge.test",
        "COLAB_BRIDGE_SESSION_ID=sess_reconnect",
        "COLAB_BRIDGE_RUNNER_TOKEN=secret",
        `COLAB_BRIDGE_PROJECT_ROOT=${projectRoot}`,
        "",
      ].join("\0"),
      "utf8",
    );
    await writeFile(join(processRoot, "cmdline"), "/usr/bin/python3\0/tmp/not-the-runner.py\0", "utf8");
    await writeFile(
      join(processRoot, "stat"),
      `4242 (python3) S ${Array.from({ length: 24 }, (_, index) => index + 1).join(" ")}`,
      "utf8",
    );

    const probe = `
import importlib.util
import json
import os
import sys

os.environ["COLAB_BRIDGE_PROJECT_ROOT"] = sys.argv[2]
os.environ["COLAB_BRIDGE_PROC_ROOT"] = sys.argv[3]
spec = importlib.util.spec_from_file_location("helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["helper"] = module
spec.loader.exec_module(module)

killpg_calls = []
module.os.killpg = lambda pid, sig: killpg_calls.append({"pid": pid, "sig": sig})

errors = []
for name in ("read_runner_env", "stop_existing_runner"):
    try:
        getattr(module, name)()
    except RuntimeError as error:
        errors.append(str(error))

print(json.dumps({"errors": errors, "killpg_calls": killpg_calls}))
`;
    const result = spawnSyncPython(
      ["-", resolve("scripts", "colab-reconnect-runner.py"), projectRoot, procRoot],
      probe,
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.killpg_calls.length, 0);
    assert.match(output.errors[0], /does not point to the expected/);
    assert.match(output.errors[1], /Refusing to stop process/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

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

function spawnSyncPython(args, input) {
  return spawnSync("python3", args, {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
  });
}
