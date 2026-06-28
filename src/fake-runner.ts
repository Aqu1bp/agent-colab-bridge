import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, mkdtempSync, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import {
  bridgeError,
  createResultEnvelope,
  MAX_FILE_CONTENT_BYTES,
  normalizeForegroundRunPayload,
  normalizeReadFilePayload,
  normalizeWriteFilePayload,
  type BridgeError,
  type CommandEnvelope,
  type ForegroundRunResultPayload,
  type GpuStatusPayload,
  type ReadFilePayload,
  type ReadFileResultPayload,
  type ResultEnvelope,
  type RunPythonPayload,
  type RunShellPayload,
  type WriteFilePayload,
  type WriteFileResultPayload,
} from "./protocol.js";
import { type AuthAttempt } from "./auth.js";
import { type SessionBroker } from "./broker.js";

export interface FakeRunnerOptions {
  runnerInstanceId?: string;
  kernelStartedAt?: string;
  runnerStartedAt?: string;
  projectRoot?: string;
}

export class FakeRunner {
  readonly runnerInstanceId: string;
  readonly kernelStartedAt: string;
  readonly runnerStartedAt: string;
  readonly projectRoot: string;

  constructor(
    private readonly broker: SessionBroker,
    private readonly sessionId: string,
    private readonly runnerAuthFactory: () => AuthAttempt,
    options: FakeRunnerOptions = {},
  ) {
    this.runnerInstanceId = options.runnerInstanceId ?? "runner_fake";
    this.kernelStartedAt = options.kernelStartedAt ?? new Date("2026-06-28T10:00:00.000Z").toISOString();
    this.runnerStartedAt = options.runnerStartedAt ?? new Date("2026-06-28T10:00:01.000Z").toISOString();
    this.projectRoot = options.projectRoot ?? mkdtempSync(join(tmpdir(), "colab-mcp-fake-project-"));
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
          ? await runFakeShell(payload as RunShellPayload, this.projectRoot)
          : await runFakePython(payload as RunPythonPayload, this.projectRoot);

      return createResultEnvelope({
        command: envelope,
        ok: true,
        payload: result,
      });
    }

    if (envelope.type === "write_file" || envelope.type === "read_file") {
      try {
        const result =
          envelope.type === "write_file"
            ? await runFakeWriteFile(normalizeWriteFilePayload(envelope.payload), this.projectRoot)
            : await runFakeReadFile(normalizeReadFilePayload(envelope.payload), this.projectRoot);

        return createResultEnvelope({
          command: envelope,
          ok: true,
          payload: result,
        });
      } catch (error) {
        return createResultEnvelope({
          command: envelope,
          ok: false,
          payload: {},
          error: toBridgeError(error, "File command failed."),
        });
      }
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

async function runFakeShell(payload: RunShellPayload, projectRoot: string): Promise<ForegroundRunResultPayload> {
  await mkdir(projectRoot, { recursive: true });
  return runBoundedProcess({
    command: payload.command,
    args: [],
    shell: true,
    cwd: projectRoot,
    timeoutSec: payload.timeout_sec,
    maxOutputBytes: payload.max_output_bytes,
  });
}

async function runFakePython(payload: RunPythonPayload, projectRoot: string): Promise<ForegroundRunResultPayload> {
  const directory = join(projectRoot, ".colab_mcp_tmp", `snippet-${process.pid}-${Date.now()}`);
  const filePath = join(directory, "snippet.py");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(filePath, payload.code, "utf8");
    return await runBoundedProcess({
      command: "python3",
      args: [filePath],
      shell: false,
      cwd: projectRoot,
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
  cwd: string;
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
      cwd: input.cwd,
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

async function runFakeWriteFile(
  payload: WriteFilePayload,
  projectRoot: string,
): Promise<WriteFileResultPayload> {
  const safePath = await resolveSafeProjectPath(projectRoot, payload.path);
  const bytesWritten = Buffer.byteLength(payload.content, "utf8");
  if (bytesWritten > MAX_FILE_CONTENT_BYTES) {
    throw fileCommandError(
      "INVALID_ARGUMENT",
      `content must be no larger than ${MAX_FILE_CONTENT_BYTES} bytes.`,
    );
  }

  if (payload.mode === "append") {
    const target = await lstatIfExists(safePath.absolutePath);
    if (!target) {
      throw fileCommandError("INVALID_ARGUMENT", "append target must exist.");
    }
    assertRegularFileTarget(target);
    const file = await openNoFollow(safePath.absolutePath, constants.O_WRONLY | constants.O_APPEND);
    try {
      await file.writeFile(payload.content, "utf8");
    } finally {
      await file.close();
    }
    return {
      path: safePath.relativePath,
      bytes_written: bytesWritten,
      mode: payload.mode,
    };
  }

  const target = await lstatIfExists(safePath.absolutePath);
  if (target?.isSymbolicLink()) {
    throw fileCommandError("FORBIDDEN_PATH", "symlink targets are not allowed.");
  }
  if (payload.mode === "create_new" && target) {
    throw fileCommandError("INVALID_ARGUMENT", "create_new target already exists.");
  }
  if (payload.mode === "overwrite" && target) {
    assertRegularFileTarget(target);
  }

  const tempPath = join(
    safePath.parentPath,
    `.${basename(safePath.absolutePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, payload.content, { encoding: "utf8", flag: "wx" });
    if (payload.mode === "create_new") {
      try {
        await link(tempPath, safePath.absolutePath);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw fileCommandError("INVALID_ARGUMENT", "create_new target already exists.");
        }
        throw error;
      }
    } else {
      await rename(tempPath, safePath.absolutePath);
    }
  } finally {
    await unlink(tempPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  return {
    path: safePath.relativePath,
    bytes_written: bytesWritten,
    mode: payload.mode,
  };
}

async function runFakeReadFile(
  payload: ReadFilePayload,
  projectRoot: string,
): Promise<ReadFileResultPayload> {
  const safePath = await resolveSafeProjectPath(projectRoot, payload.path);
  const target = await lstatIfExists(safePath.absolutePath);
  if (!target) {
    throw fileCommandError("INVALID_ARGUMENT", "read target does not exist.");
  }
  assertRegularFileTarget(target);

  const file = await openNoFollow(safePath.absolutePath, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(payload.max_bytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const accepted = buffer.subarray(0, Math.min(bytesRead, payload.max_bytes));
    return {
      path: safePath.relativePath,
      content: accepted.toString("utf8"),
      bytes_read: accepted.length,
      truncated: bytesRead > payload.max_bytes,
    };
  } finally {
    await file.close();
  }
}

async function openNoFollow(filePath: string, flags: number): ReturnType<typeof open> {
  try {
    return await open(filePath, flags | noFollowFlag());
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw fileCommandError("FORBIDDEN_PATH", "symlink targets are not allowed.");
    }
    throw error;
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

interface SafeProjectPath {
  relativePath: string;
  absolutePath: string;
  parentPath: string;
}

async function resolveSafeProjectPath(projectRoot: string, inputPath: string): Promise<SafeProjectPath> {
  const relativePath = normalizeRelativeProjectPath(inputPath);
  await mkdir(projectRoot, { recursive: true });
  const rootStat = await lstat(projectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw fileCommandError("FORBIDDEN_PATH", "project root must be a real directory.");
  }

  const segments = relativePath.split("/");
  let current = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const parent = await lstatIfExists(current);
    if (!parent) {
      throw fileCommandError("INVALID_ARGUMENT", "parent directory does not exist.");
    }
    if (parent.isSymbolicLink()) {
      throw fileCommandError("FORBIDDEN_PATH", "parent directory symlinks are not allowed.");
    }
    if (!parent.isDirectory()) {
      throw fileCommandError("INVALID_ARGUMENT", "parent path is not a directory.");
    }
  }

  const absolutePath = join(projectRoot, ...segments);
  return {
    relativePath,
    absolutePath,
    parentPath: dirname(absolutePath),
  };
}

function normalizeRelativeProjectPath(inputPath: string): string {
  const converted = inputPath.replaceAll("\\", "/");
  if (converted.trim().length === 0 || converted.includes("\0")) {
    throw fileCommandError("FORBIDDEN_PATH", "path must be a non-empty relative path.");
  }
  if (posix.isAbsolute(converted) || win32.isAbsolute(inputPath)) {
    throw fileCommandError("FORBIDDEN_PATH", "absolute paths are not allowed.");
  }

  const inputSegments = converted.split("/");
  if (inputSegments.includes("..")) {
    throw fileCommandError("FORBIDDEN_PATH", "path traversal is not allowed.");
  }

  const normalized = posix.normalize(converted);
  if (
    normalized === "." ||
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw fileCommandError("FORBIDDEN_PATH", "path must resolve under the project root.");
  }

  return normalized;
}

function assertRegularFileTarget(stat: Stats): void {
  if (stat.isSymbolicLink()) {
    throw fileCommandError("FORBIDDEN_PATH", "symlink targets are not allowed.");
  }
  if (!stat.isFile()) {
    throw fileCommandError("INVALID_ARGUMENT", "target must be a regular file.");
  }
}

async function lstatIfExists(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

class FileCommandError extends Error {
  constructor(readonly bridgeError: BridgeError) {
    super(bridgeError.message);
  }
}

function fileCommandError(code: BridgeError["code"], message: string): FileCommandError {
  return new FileCommandError(bridgeError(code, message, false));
}

function toBridgeError(error: unknown, fallbackMessage: string): BridgeError {
  if (error instanceof FileCommandError) {
    return error.bridgeError;
  }
  if (isBridgeErrorLike(error)) {
    return error;
  }
  return bridgeError("INTERNAL_ERROR", fallbackMessage, false);
}

function isBridgeErrorLike(value: unknown): value is BridgeError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
