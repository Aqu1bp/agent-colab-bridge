import test from "node:test";
import assert from "node:assert/strict";
import {
  createStopRuntimeCommand,
  dryRunLines,
  loadStopRuntimeOptions,
  parseStopRuntimeArgs,
} from "../scripts/stop-runtime.mjs";

test("runtime stop defaults to the named bridge session", () => {
  const options = loadStopRuntimeOptions({ argv: ["--dry-run"], env: {} });

  assert.equal(options.colabSession, "codex-colab-bridge");
  assert.deepEqual(createStopRuntimeCommand(options), [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    "stop",
    "-s",
    "codex-colab-bridge",
  ]);
});

test("runtime stop supports named sessions and google-colab-cli config", () => {
  const options = loadStopRuntimeOptions({
    argv: [
      "--yes",
      "--colab-session",
      "named",
      "--colab-config",
      "/tmp/colab.json",
    ],
    env: {},
  });

  assert.equal(options.yes, true);
  assert.deepEqual(createStopRuntimeCommand(options), [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    "--config",
    "/tmp/colab.json",
    "stop",
    "-s",
    "named",
  ]);
});

test("runtime stop dry run describes destructive boundary", () => {
  const options = loadStopRuntimeOptions({
    argv: ["--dry-run", "--colab-session", "named"],
    env: {},
  });
  const text = dryRunLines(options).join("\n");

  assert.match(text, /No Colab runtime was stopped/);
  assert.match(text, /colab stop -s named/);
});

test("runtime stop parser accepts yes alias", () => {
  assert.deepEqual(parseStopRuntimeArgs(["-y", "--colab-session=named"]), {
    yes: true,
    colabSession: "named",
  });
});
