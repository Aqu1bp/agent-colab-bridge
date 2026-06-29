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

test("Colab runner handles ping and job summaries without log text", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "colab-runner-python-jobs-"));
  try {
    const probe = `
import asyncio
import importlib.util
import json
import os
import shlex
import sys

runner_path = sys.argv[1]
project_root = sys.argv[2]
os.environ["COLAB_BRIDGE_PROJECT_ROOT"] = project_root
spec = importlib.util.spec_from_file_location("colab_runner", runner_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["colab_runner"] = module
spec.loader.exec_module(module)

def envelope(command_type, payload=None):
    envelope.counter += 1
    return {
        "protocol_version": 1,
        "session_id": "sess_python",
        "command_id": f"cmd_{envelope.counter}",
        "message_id": f"msg_{envelope.counter}",
        "kind": "command",
        "type": command_type,
        "sent_at": "2026-06-29T00:00:00Z",
        "deadline_at": "2026-06-29T00:00:30Z",
        "payload": payload or {},
    }
envelope.counter = 0

async def main():
    executable = shlex.quote(sys.executable)
    command = f"{executable} -u -c " + shlex.quote("import time; print('py-secret-log'); time.sleep(5)")
    ping = await module.handle_command(envelope("ping"))
    start = await module.handle_command(envelope("start_job", {
        "command": command,
        "name": "py-summary-job",
        "max_log_bytes": 4096,
    }))
    job_id = start["payload"]["job_id"]
    listed = await module.handle_command(envelope("list_jobs"))
    status = await module.handle_command(envelope("job_status", {"job_id": job_id}))
    missing = await module.handle_command(envelope("job_status", {"job_id": "job_missing"}))
    interrupt = await module.handle_command(envelope("interrupt_job", {
        "job_id": job_id,
        "signal": "SIGKILL",
        "kill_after_sec": 0,
    }))
    print(json.dumps({
        "ping": ping,
        "start": start,
        "list": listed,
        "status": status,
        "missing": missing,
        "interrupt": interrupt,
    }))

asyncio.run(main())
`;
    const result = spawnSync("python3", ["-", resolve("python/colab_runner.py"), projectRoot], {
      cwd: resolve("."),
      input: probe,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    const listSummary = output.list.payload.jobs[0];
    const statusSummary = output.status.payload;

    assert.deepEqual(output.ping.payload, { ok: true, pong: true });
    assert.equal(output.start.ok, true);
    assert.equal(output.list.ok, true);
    assert.equal(output.status.ok, true);
    assert.equal(listSummary.job_id, output.start.payload.job_id);
    assert.equal(listSummary.status, "running");
    assert.equal(listSummary.active, true);
    assert.equal(listSummary.name, "py-summary-job");
    assert.equal(listSummary.exit_code, null);
    assert.equal(listSummary.interrupted_at, null);
    assert.equal("events" in listSummary, false);
    assert.equal("stdout" in listSummary, false);
    assert.equal("stderr" in listSummary, false);
    assert.equal(statusSummary.job_id, output.start.payload.job_id);
    assert.equal(statusSummary.name, "py-summary-job");
    assert.equal(JSON.stringify(output.list.payload).includes("py-secret-log"), false);
    assert.equal(JSON.stringify(output.status.payload).includes("py-secret-log"), false);
    assert.equal(output.missing.ok, false);
    assert.equal(output.missing.error.code, "JOB_NOT_FOUND");
    assert.equal(output.interrupt.ok, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Colab runner write_file creates safe missing parent directories", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "colab-runner-python-files-"));
  try {
    const probe = `
import asyncio
import importlib.util
import json
import os
import sys

runner_path = sys.argv[1]
project_root = sys.argv[2]
os.environ["COLAB_BRIDGE_PROJECT_ROOT"] = project_root
spec = importlib.util.spec_from_file_location("colab_runner", runner_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["colab_runner"] = module
spec.loader.exec_module(module)

def envelope(command_type, payload=None):
    envelope.counter += 1
    return {
        "protocol_version": 1,
        "session_id": "sess_python_files",
        "command_id": f"cmd_{envelope.counter}",
        "message_id": f"msg_{envelope.counter}",
        "kind": "command",
        "type": command_type,
        "sent_at": "2026-06-29T00:00:00Z",
        "deadline_at": "2026-06-29T00:00:30Z",
        "payload": payload or {},
    }
envelope.counter = 0

async def main():
    overwrite = await module.handle_command(envelope("write_file", {
        "path": "nested/overwrite/hello.txt",
        "content": "hello",
        "mode": "overwrite",
    }))
    create_new = await module.handle_command(envelope("write_file", {
        "path": "nested/create-new/config.txt",
        "content": "first",
        "mode": "create_new",
    }))
    duplicate_create_new = await module.handle_command(envelope("write_file", {
        "path": "nested/create-new/config.txt",
        "content": "second",
        "mode": "create_new",
    }))
    append_missing = await module.handle_command(envelope("write_file", {
        "path": "nested/append/log.txt",
        "content": "first",
        "mode": "append",
    }))
    append_existing = await module.handle_command(envelope("write_file", {
        "path": "nested/append/log.txt",
        "content": " second",
        "mode": "append",
    }))
    append_exec_bits = os.stat(os.path.join(project_root, "nested", "append", "log.txt")).st_mode & 0o111
    appended = await module.handle_command(envelope("read_file", {
        "path": "nested/append/log.txt",
        "max_bytes": 1024,
    }))
    oversized = await module.handle_command(envelope("write_file", {
        "path": "oversized/should-not/exist.txt",
        "content": "x" * (module.MAX_FILE_CONTENT_BYTES + 1),
        "mode": "overwrite",
    }))
    oversized_parent_exists = os.path.exists(os.path.join(project_root, "oversized"))
    traversal = await module.handle_command(envelope("write_file", {
        "path": "../escape.txt",
        "content": "no",
        "mode": "overwrite",
    }))
    print(json.dumps({
        "overwrite": overwrite,
        "create_new": create_new,
        "duplicate_create_new": duplicate_create_new,
        "append_missing": append_missing,
        "append_existing": append_existing,
        "append_exec_bits": append_exec_bits,
        "appended": appended,
        "oversized": oversized,
        "oversized_parent_exists": oversized_parent_exists,
        "traversal": traversal,
    }))

asyncio.run(main())
`;
    const result = spawnSync("python3", ["-", resolve("python/colab_runner.py"), projectRoot], {
      cwd: resolve("."),
      input: probe,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());

    assert.equal(output.overwrite.ok, true);
    assert.equal(output.overwrite.payload.path, "nested/overwrite/hello.txt");
    assert.equal(output.create_new.ok, true);
    assert.equal(output.duplicate_create_new.ok, false);
    assert.equal(output.duplicate_create_new.error.code, "INVALID_ARGUMENT");
    assert.equal(output.append_missing.ok, true);
    assert.equal(output.append_existing.ok, true);
    assert.equal(output.append_exec_bits, 0);
    assert.equal(output.appended.ok, true);
    assert.equal(output.appended.payload.content, "first second");
    assert.equal(output.oversized.ok, false);
    assert.equal(output.oversized.error.code, "INVALID_ARGUMENT");
    assert.equal(output.oversized_parent_exists, false);
    assert.equal(output.traversal.ok, false);
    assert.equal(output.traversal.error.code, "FORBIDDEN_PATH");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
