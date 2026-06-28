import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeError,
  createResultEnvelope,
  type CommandEnvelope,
  type ForegroundRunResultPayload,
  type GpuStatusPayload,
  type ResultEnvelope,
  type RunPythonPayload,
  type RunShellPayload,
  normalizeForegroundRunPayload,
} from "./protocol.js";
import { type AuthAttempt } from "./auth.js";
import { type SessionBroker } from "./broker.js";

export interface FakeRunnerOptions {
  runnerInstanceId?: string;
  kernelStartedAt?: string;
  runnerStartedAt?: string;
}

export class FakeRunner {
  readonly runnerInstanceId: string;
  readonly kernelStartedAt: string;
  readonly runnerStartedAt: string;

  constructor(
    private readonly broker: SessionBroker,
    private readonly sessionId: string,
    private readonly runnerAuthFactory: () => AuthAttempt,
    options: FakeRunnerOptions = {},
  ) {
    this.runnerInstanceId = options.runnerInstanceId ?? "runner_fake";
    this.kernelStartedAt = options.kernelStartedAt ?? new Date("2026-06-28T10:00:00.000Z").toISOString();
    this.runnerStartedAt = options.runnerStartedAt ?? new Date("2026-06-28T10:00:01.000Z").toISOString();
  }

  attach(now = new Date()): void {
    this.broker.attachRunner(
      this.sessionId,
      this.runnerAuthFactory(),
      {
        runnerInstanceId: this.runnerInstanceId,
        kernelStartedAt: this.kernelStartedAt,
        runnerStartedAt: this.runnerStartedAt,
      },
      (envelope) => this.handle(envelope),
      now,
    );
  }

  async handle(envelope: CommandEnvelope): Promise<ResultEnvelope> {
    this.broker.acknowledgeCommand(this.sessionId, this.runnerAuthFactory(), envelope.command_id);

    if (envelope.type === "ping") {
      return createResultEnvelope({
        command: envelope,
        ok: true,
        payload: { ok: true, pong: true },
      });
    }

    if (envelope.type === "gpu_status") {
      return createResultEnvelope({
        command: envelope,
        ok: true,
        payload: fakeGpuStatus(),
      });
    }

    if (envelope.type === "run_shell" || envelope.type === "run_python") {
      let payload: RunShellPayload | RunPythonPayload;
      try {
        payload = normalizeForegroundRunPayload(envelope.type, envelope.payload);
      } catch {
        return createResultEnvelope({
          command: envelope,
          ok: false,
          payload: {},
          error: bridgeError("INVALID_ARGUMENT", "Invalid foreground command payload."),
        });
      }

      const result =
        envelope.type === "run_shell"
          ? await runFakeShell(payload as RunShellPayload)
          : await runFakePython(payload as RunPythonPayload);

      return createResultEnvelope({
        command: envelope,
        ok: true,
        payload: result,
      });
    }

    return createResultEnvelope({
      command: envelope,
      ok: true,
      payload: {
        session_id: this.sessionId,
        runner_connected: true,
        runner_instance_id: this.runnerInstanceId,
        kernel_started_at: this.kernelStartedAt,
        runner_started_at: this.runnerStartedAt,
      },
    });
  }
}

async function runFakeShell(payload: RunShellPayload): Promise<ForegroundRunResultPayload> {
  return runBoundedProcess({
    command: payload.command,
    args: [],
    shell: true,
    timeoutSec: payload.timeout_sec,
    maxOutputBytes: payload.max_output_bytes,
  });
}

async function runFakePython(payload: RunPythonPayload): Promise<ForegroundRunResultPayload> {
  const directory = join(tmpdir(), `colab-mcp-fake-${process.pid}-${Date.now()}`);
  const filePath = join(directory, "snippet.py");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(filePath, payload.code, "utf8");
    return await runBoundedProcess({
      command: "python3",
      args: [filePath],
      shell: false,
      timeoutSec: payload.timeout_sec,
      maxOutputBytes: payload.max_output_bytes,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runBoundedProcess(input: {
  command: string;
  args: string[];
  shell: boolean;
  timeoutSec: number;
  maxOutputBytes: number;
}): Promise<ForegroundRunResultPayload> {
  const startedAt = performance.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let remaining = input.maxOutputBytes;
  let truncated = false;
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: process.cwd(),
      shell: input.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutSec * 1000);

    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      const accepted = chunk.subarray(0, Math.min(chunk.length, remaining));
      remaining -= accepted.length;
      if (accepted.length < chunk.length) {
        truncated = true;
      }

      if (stream === "stdout") {
        stdout = Buffer.concat([stdout, accepted]);
      } else {
        stderr = Buffer.concat([stderr, accepted]);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    child.on("error", (error) => {
      append("stderr", Buffer.from(`${error.message}\n`, "utf8"));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exit_code: timedOut ? null : code,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        timed_out: timedOut,
        truncated,
      });
    });
  });
}

export function fakeGpuStatus(): GpuStatusPayload {
  return {
    available: true,
    source: "fake",
    gpus: [
      {
        index: 0,
        name: "Fake Colab GPU",
        memory_total_mb: 16384,
        memory_used_mb: 1024,
        utilization_gpu_percent: 7,
      },
    ],
    raw: "Fake Colab GPU, 16384 MiB, 1024 MiB, 7 %",
  };
}
