import test from "node:test";
import assert from "node:assert/strict";
import {
  collectRuntimeOptions,
  createRuntimeOptionsCommand,
  formatRuntimeOptionsLines,
  loadRuntimeOptions,
  parseAcceleratorOptions,
  parseRuntimeOptionsArgs,
} from "../scripts/runtime-options.mjs";

test("runtime options parser extracts GPU and TPU candidates from colab new help", () => {
  const parsed = parseAcceleratorOptions(`
 Usage: colab new [OPTIONS]

 Create a new session

╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --session  -s      TEXT  Session name                                        │
│ --tpu              TEXT  TPU accelerator variant. Supported: v5e1, v6e1.     │
│ --gpu              TEXT  GPU accelerator variant. Supported: T4, L4, G4,     │
│                          H100, A100.                                         │
│                          If omitted (along with --tpu), a CPU runtime is     │
│                          created.                                            │
│                          Availability varies by Colab subscription tier.     │
│ --help     -h            Show this message and exit.                         │
╰──────────────────────────────────────────────────────────────────────────────╯
  `);

  assert.deepEqual(parsed, {
    cpu: true,
    gpu: ["T4", "L4", "G4", "H100", "A100"],
    tpu: ["v5e1", "v6e1"],
  });
});

test("runtime options command includes optional google-colab-cli config", () => {
  assert.deepEqual(createRuntimeOptionsCommand({ colabConfig: "/tmp/colab.json" }), [
    "uvx",
    "--from",
    "google-colab-cli",
    "colab",
    "--config",
    "/tmp/colab.json",
    "new",
    "--help",
  ]);
});

test("runtime options collector uses parsed CLI output and explains availability limits", async () => {
  const result = await collectRuntimeOptions({
    options: {},
    runCommand: async () => ({
      ok: true,
      code: 0,
      stdout: "--tpu TEXT TPU accelerator variant. Supported: v5e1, v6e1.\n--gpu TEXT GPU accelerator variant. Supported: T4, L4. If omitted",
      stderr: "",
    }),
  });

  assert.equal(result.source, "google-colab-cli colab new --help");
  assert.deepEqual(result.gpu, ["T4", "L4"]);
  assert.deepEqual(result.tpu, ["v5e1", "v6e1"]);
  assert.match(result.availability, /Supported candidates only/);
  assert.equal(result.warnings.length, 0);
  assert.match(formatRuntimeOptionsLines(result).join("\n"), /real allocation depends on Colab tier/);
});

test("runtime options collector falls back when CLI cannot be read", async () => {
  const result = await collectRuntimeOptions({
    options: {},
    runCommand: async () => ({
      ok: false,
      code: 127,
      stdout: "",
      stderr: "uvx not found",
    }),
  });

  assert.equal(result.source, "built-in fallback");
  assert.deepEqual(result.gpu, ["T4", "L4", "G4", "H100", "A100"]);
  assert.deepEqual(result.tpu, ["v5e1", "v6e1"]);
  assert.match(result.warnings[0], /Could not read google-colab-cli/);
});

test("runtime options args support json and colab config", () => {
  assert.deepEqual(parseRuntimeOptionsArgs(["--json", "--colab-config=/tmp/colab.json"]), {
    json: true,
    colabConfig: "/tmp/colab.json",
  });
  assert.deepEqual(loadRuntimeOptions({ argv: [], env: { COLAB_MCP_BRIDGE_COLAB_CONFIG: "/tmp/from-env.json" } }), {
    help: false,
    json: false,
    colabConfig: "/tmp/from-env.json",
  });
});
