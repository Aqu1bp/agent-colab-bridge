import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
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
import { StringDecoder } from "node:string_decoder";
import {
  bridgeError,
  createResultEnvelope,
  MAX_FILE_CONTENT_BYTES,
  newId,
  normalizeForegroundRunPayload,
  normalizeInterruptJobPayload,
  normalizeJobStatusPayload,
  normalizeListJobsPayload,
  normalizeReadFilePayload,
  normalizeStartJobPayload,
  normalizeTailJobPayload,
  normalizeWriteFilePayload,
  type BridgeError,
  type CommandEnvelope,
  type ForegroundRunResultPayload,
  type GpuStatusPayload,
  type InterruptJobPayload,
  type InterruptJobResultPayload,
  type JobLogEvent,
  type JobStatus,
  type JobStatusCommandPayload,
  type JobStatusResultPayload,
  type JobSummaryPayload,
  type ListJobsResultPayload,
  type ReadFilePayload,
  type ReadFileResultPayload,
  type ResultEnvelope,
  type RunPythonPayload,
  type RunShellPayload,
  type StartJobPayload,
  type StartJobResultPayload,
  type TailJobPayload,
  type TailJobResultPayload,
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
  private readonly jobs = new Map<string, FakeBackgroundJob>();
  private activeJobId: string | null = null;

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

    if (envelope.type === "start_job") {
      try {
        const result = await this.startBackgroundJob(normalizeStartJobPayload(envelope.payload));
        return createResultEnvelope({
          command: envelope,
          ok: true,
          payload: result,
        });
      } catch (error) {
        return createResultEnvelope({
          command: envelope,
          ok: false,
          payload: backgroundJobErrorPayload(error),
          error: toBridgeError(error, "Background job start failed."),
        });
      }
    }

    if (envelope.type === "list_jobs") {
      try {
        normalizeListJobsPayload(envelope.payload);
        const result = this.listBackgroundJobs();
        return createResultEnvelope({
          command: envelope,
          ok: true,
          payload: result,
        });
      } catch (error) {
        return createResultEnvelope({
          command: envelope,
          ok: false,
          payload: backgroundJobErrorPayload(error),
          error: toBridgeError(error, "Background job list failed."),
        });
      }
    }

    if (envelope.type === "job_status") {
      try {
        const result = this.backgroundJobStatus(normalizeJobStatusPayload(envelope.payload));
        return createResultEnvelope({
          command: envelope,
          ok: true,
          payload: result,
        });
      } catch (error) {
        return createResultEnvelope({
          command: envelope,
          ok: false,
          payload: backgroundJobErrorPayload(error),
          error: toBridgeError(error, "Background job status failed."),
        });
      }
    }

    if (envelope.type === "tail_job") {
      try {
        const result = this.tailBackgroundJob(normalizeTailJobPayload(envelope.payload));
        return createResultEnvelope({
          command: envelope,
          ok: true,
          payload: result,
        });
      } catch (error) {
        return createResultEnvelope({
          command: envelope,
          ok: false,
          payload: backgroundJobErrorPayload(error),
          error: toBridgeError(error, "Background job tail failed."),
        });
      }
    }

    if (envelope.type === "interrupt_job") {
      try {
        const result = await this.interruptBackgroundJob(normalizeInterruptJobPayload(envelope.payload));
        return createResultEnvelope({
          command: envelope,
          ok: true,
          payload: result,
        });
      } catch (error) {
        return createResultEnvelope({
          command: envelope,
          ok: false,
          payload: backgroundJobErrorPayload(error),
          error: toBridgeError(error, "Background job interrupt failed."),
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
        active_job_id: this.runningJob()?.id ?? null,
      },
    });
  }

  private async startBackgroundJob(payload: StartJobPayload): Promise<StartJobResultPayload> {
    const runningJob = this.runningJob();
    if (runningJob) {
      throw backgroundJobError("JOB_ALREADY_RUNNING", "A background job is already running.", {
        job_id: runningJob.id,
      });
    }

    await mkdir(this.projectRoot, { recursive: true });
    const job = FakeBackgroundJob.start(payload, this.projectRoot);
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;
    job.done.finally(() => {
      if (this.activeJobId === job.id) {
        this.activeJobId = null;
      }
    });
    return {
      job_id: job.id,
      status: "running",
      started_at: job.startedAt,
    };
  }

  private tailBackgroundJob(payload: TailJobPayload): TailJobResultPayload {
    const job = this.jobs.get(payload.job_id);
    if (!job) {
      throw backgroundJobError("JOB_NOT_FOUND", "Background job was not found.", {
        job_id: payload.job_id,
      });
    }
    return job.tail(payload.cursor, payload.max_bytes);
  }

  private listBackgroundJobs(): ListJobsResultPayload {
    return {
      jobs: Array.from(this.jobs.values()).map((job) =>
        job.summary(this.activeJobId === job.id && job.status === "running"),
      ),
    };
  }

  private backgroundJobStatus(payload: JobStatusCommandPayload): JobStatusResultPayload {
    const job = this.jobs.get(payload.job_id);
    if (!job) {
      throw backgroundJobError("JOB_NOT_FOUND", "Background job was not found.", {
        job_id: payload.job_id,
      });
    }
    return job.summary(this.activeJobId === job.id && job.status === "running");
  }

  private async interruptBackgroundJob(payload: InterruptJobPayload): Promise<InterruptJobResultPayload> {
    const job = this.jobs.get(payload.job_id);
    if (!job) {
      throw backgroundJobError("JOB_NOT_FOUND", "Background job was not found.", {
        job_id: payload.job_id,
      });
    }
    return job.interrupt(payload);
  }

  private runningJob(): FakeBackgroundJob | null {
    if (!this.activeJobId) {
      return null;
    }
    const job = this.jobs.get(this.activeJobId);
    return job?.status === "running" ? job : null;
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
      args: ["-u", filePath],
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
      env: childProcessEnv(),
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

class FakeBackgroundJob {
  readonly id: string;
  readonly startedAt: string;
  readonly name?: string;
  status: JobStatus = "running";
  exitCode: number | null = null;
  interruptedAt: string | null = null;
  readonly done: Promise<void>;
  private readonly logRing: JobLogRing;

  private constructor(
    private readonly child: ChildProcess,
    payload: StartJobPayload,
  ) {
    this.id = newId("job");
    this.startedAt = currentIso();
    this.name = payload.name;
    this.logRing = new JobLogRing(payload.max_log_bytes);
    this.done = this.watchChild();
    this.watchStream("stdout");
    this.watchStream("stderr");
  }

  static start(payload: StartJobPayload, projectRoot: string): FakeBackgroundJob {
    const child = spawn(payload.command, [], {
      cwd: projectRoot,
      env: childProcessEnv(),
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new FakeBackgroundJob(child, payload);
  }

  summary(active: boolean): JobSummaryPayload {
    return {
      job_id: this.id,
      status: this.status,
      started_at: this.startedAt,
      exit_code: this.exitCode,
      interrupted_at: this.interruptedAt,
      active,
      ...(this.name !== undefined ? { name: this.name } : {}),
    };
  }

  tail(cursor: number, maxBytes: number): TailJobResultPayload {
    const result = this.logRing.tail(cursor, maxBytes);
    if (result.expired) {
      throw backgroundJobError("CURSOR_EXPIRED", "Background job log cursor has expired.", {
        job_id: this.id,
        oldest_cursor: result.oldestCursor,
      });
    }

    return {
      job_id: this.id,
      status: this.status,
      next_cursor: result.nextCursor,
      events: result.events,
      truncated: result.truncated,
      exit_code: this.exitCode,
    };
  }

  async interrupt(payload: InterruptJobPayload): Promise<InterruptJobResultPayload> {
    const interruptedAt = this.interruptedAt ?? currentIso();
    this.interruptedAt = interruptedAt;

    if (this.status === "running") {
      this.sendSignal(payload.signal);
      let escalation: NodeJS.Timeout | undefined;
      if (payload.signal === "SIGTERM") {
        escalation = setTimeout(() => {
          if (this.status === "running") {
            this.sendSignal("SIGKILL");
          }
        }, payload.kill_after_sec * 1000);
      }

      try {
        const fallbackMs = payload.signal === "SIGTERM"
          ? (payload.kill_after_sec + 1) * 1000
          : 5_000;
        await Promise.race([this.done, sleep(fallbackMs)]);
      } finally {
        if (escalation) {
          clearTimeout(escalation);
        }
      }
    }

    return {
      job_id: this.id,
      status: this.status,
      exit_code: this.exitCode,
      interrupted_at: interruptedAt,
    };
  }

  private watchChild(): Promise<void> {
    return new Promise((resolve) => {
      this.child.on("error", (error) => {
        this.logRing.add("stderr", `${error.message}\n`);
      });
      this.child.on("close", (code) => {
        this.exitCode = code;
        this.status = this.interruptedAt ? "interrupted" : "exited";
        resolve();
      });
    });
  }

  private watchStream(streamName: "stdout" | "stderr"): void {
    const stream = streamName === "stdout" ? this.child.stdout : this.child.stderr;
    if (!stream) {
      return;
    }

    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (text) {
        this.logRing.add(streamName, text);
      }
    });
    stream.on("end", () => {
      const text = decoder.end();
      if (text) {
        this.logRing.add(streamName, text);
      }
    });
  }

  private sendSignal(signalName: InterruptJobPayload["signal"]): void {
    if (!this.child.pid) {
      return;
    }

    if (process.platform !== "win32") {
      try {
        process.kill(-this.child.pid, signalName);
        return;
      } catch (error) {
        if (!isNodeError(error) || (error.code !== "ESRCH" && error.code !== "EPERM")) {
          throw error;
        }
      }
    }

    try {
      this.child.kill(signalName);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function childProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1",
  };
}

interface TailRingOk {
  expired: false;
  nextCursor: number;
  events: JobLogEvent[];
  truncated: boolean;
}

interface TailRingExpired {
  expired: true;
  oldestCursor: number;
}

class JobLogRing {
  private readonly events: Array<JobLogEvent & { bytes: number }> = [];
  private nextCursor = 1;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  add(stream: JobLogEvent["stream"], text: string): void {
    for (const chunk of splitUtf8TextByBytes(text, this.maxEventBytes())) {
      this.addEvent(stream, chunk);
    }
  }

  tail(cursor: number, maxBytes: number): TailRingOk | TailRingExpired {
    const oldestCursor = this.events[0]?.cursor;
    if (oldestCursor !== undefined && cursor < oldestCursor - 1) {
      return { expired: true, oldestCursor };
    }

    const available = this.events.filter((event) => event.cursor > cursor);
    const events: JobLogEvent[] = [];
    let bytes = 0;
    let truncated = false;
    for (const event of available) {
      const nextBytes = bytes + event.bytes;
      if (events.length > 0 && nextBytes > maxBytes) {
        truncated = true;
        break;
      }

      events.push(stripEventBytes(event));
      bytes = nextBytes;
      if (nextBytes > maxBytes) {
        truncated = available.length > events.length || true;
        break;
      }
    }

    return {
      expired: false,
      nextCursor: events.at(-1)?.cursor ?? Math.max(cursor, this.nextCursor - 1),
      events,
      truncated,
    };
  }

  private addEvent(stream: JobLogEvent["stream"], text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    this.events.push({
      cursor: this.nextCursor++,
      stream,
      text,
      at: currentIso(),
      bytes,
    });
    this.totalBytes += bytes;
    this.compact();
  }

  private compact(): void {
    let droppedBytes = 0;
    while (this.totalBytes > this.maxBytes && this.events.length > 1) {
      const removed = this.events.shift();
      if (!removed) {
        break;
      }
      this.totalBytes -= removed.bytes;
      if (removed.stream !== "log_dropped") {
        droppedBytes += removed.bytes;
      }
    }

    if (droppedBytes > 0) {
      this.addLogDroppedEvent(droppedBytes);
    }
  }

  private addLogDroppedEvent(droppedBytes: number): void {
    const text = `Dropped ${droppedBytes} bytes from background job log ring.`;
    const bytes = Buffer.byteLength(text, "utf8");
    this.events.push({
      cursor: this.nextCursor++,
      stream: "log_dropped",
      text,
      at: currentIso(),
      bytes,
    });
    this.totalBytes += bytes;

    while (this.totalBytes > this.maxBytes && this.events.length > 1) {
      const removed = this.events.shift();
      if (!removed) {
        break;
      }
      this.totalBytes -= removed.bytes;
    }
  }

  private maxEventBytes(): number {
    return Math.max(64, Math.min(16 * 1024, Math.floor(this.maxBytes / 4)));
  }
}

class BackgroundJobError extends Error {
  constructor(
    readonly bridgeError: BridgeError,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(bridgeError.message);
  }
}

function backgroundJobError(
  code: BridgeError["code"],
  message: string,
  payload: Record<string, unknown> = {},
): BackgroundJobError {
  return new BackgroundJobError(bridgeError(code, message, false), payload);
}

function backgroundJobErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof BackgroundJobError) {
    return error.payload;
  }
  return {};
}

function splitUtf8TextByBytes(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function stripEventBytes(event: JobLogEvent & { bytes: number }): JobLogEvent {
  return {
    cursor: event.cursor,
    stream: event.stream,
    text: event.text,
    at: event.at,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentIso(): string {
  return new Date().toISOString();
}

async function runFakeWriteFile(
  payload: WriteFilePayload,
  projectRoot: string,
): Promise<WriteFileResultPayload> {
  const bytesWritten = Buffer.byteLength(payload.content, "utf8");
  if (bytesWritten > MAX_FILE_CONTENT_BYTES) {
    throw fileCommandError(
      "INVALID_ARGUMENT",
      `content must be no larger than ${MAX_FILE_CONTENT_BYTES} bytes.`,
    );
  }

  const safePath = await resolveSafeProjectPath(projectRoot, payload.path, { createParents: true });

  if (payload.mode === "append") {
    const target = await lstatIfExists(safePath.absolutePath);
    if (target) {
      assertRegularFileTarget(target);
    }
    const file = await openNoFollow(
      safePath.absolutePath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    );
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

async function resolveSafeProjectPath(
  projectRoot: string,
  inputPath: string,
  options: { createParents?: boolean } = {},
): Promise<SafeProjectPath> {
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
    let parent = await lstatIfExists(current);
    if (!parent) {
      if (!options.createParents) {
        throw fileCommandError("INVALID_ARGUMENT", "parent directory does not exist.");
      }
      try {
        await mkdir(current);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
      parent = await lstatIfExists(current);
    }
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
  if (error instanceof BackgroundJobError) {
    return error.bridgeError;
  }
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
