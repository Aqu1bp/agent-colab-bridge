import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Colab runner launches Python subprocesses unbuffered", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "colab-runner-python-"));
  try {
    const probe = `
import asyncio
import importlib.util
import json
import os
import shlex
import sys
from dataclasses import asdict

runner_path = sys.argv[1]
project_root = sys.argv[2]
os.environ["COLAB_BRIDGE_PROJECT_ROOT"] = project_root
spec = importlib.util.spec_from_file_location("colab_runner", runner_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["colab_runner"] = module
spec.loader.exec_module(module)

async def main():
    executable = shlex.quote(sys.executable)
    shell = await module.run_shell({
        "command": f"{executable} -c " + shlex.quote("import os; print(os.environ.get('PYTHONUNBUFFERED'))"),
        "timeout_sec": 5,
        "max_output_bytes": 1024,
    })
    python = await module.run_python({
        "code": "import os\\nprint(os.environ.get('PYTHONUNBUFFERED'))",
        "timeout_sec": 5,
        "max_output_bytes": 1024,
    })
    print(json.dumps({"shell": asdict(shell), "python": asdict(python)}))

asyncio.run(main())
`;
    const result = spawnSync("python3", ["-", resolve("python/colab_runner.py"), projectRoot], {
      cwd: resolve("."),
      input: probe,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.shell.stdout, "1\n");
    assert.equal(output.python.stdout, "1\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
