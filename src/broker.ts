import {
  AuthFailure,
  generateToken,
  hashToken,
  validateTimestamp,
  type AuthAttempt,
  type NonceRepository,
  InMemoryNonceRepository,
  validateAuthenticatedRequest,
  verifyToken,
} from "./auth.js";
import {
  bridgeError,
  createCommandEnvelope,
  isFinalCommandState,
  newId,
  nowIso,
  payloadHash,
  type BridgeError,
  type CommandEnvelope,
  type CommandRow,
  type CommandState,
  type CommandType,
  type InterruptJobResultPayload,
  type JobStatus,
  type JobSummaryPayload,
  type ResultEnvelope,
  type StartJobResultPayload,
  type TailJobResultPayload,
} from "./protocol.js";

export interface SessionRow {
  sessionId: string;
  controllerTokenHash: string;
  runnerTokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  runnerConnected: boolean;
  runnerInstanceId: string | null;
  kernelStartedAt: string | null;
  runnerStartedAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface AuditRow {
  sessionId: string;
  at: string;
  event: string;
  callerSide: "controller" | "runner" | "system";
  outcome: "accepted" | "rejected";
  commandId?: string;
  commandType?: string;
  payloadHash?: string;
  errorCode?: string;
}

export interface JobRow {
  sessionId: string;
  jobId: string;
  commandId: string;
  runnerInstanceId: string | null;
  status: JobStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  interruptedAt: string | null;
  updatedAt: string;
  name?: string;
}

export interface BridgeRepository {
  insertSession(session: SessionRow): void;
  getSession(sessionId: string): SessionRow | undefined;
  updateSession(session: SessionRow): void;
  insertCommand(command: CommandRow): void;
  getCommand(sessionId: string, commandId: string): CommandRow | undefined;
  updateCommand(command: CommandRow): void;
  upsertJob(job: JobRow): void;
  getJob(sessionId: string, jobId: string): JobRow | undefined;
  listJobs(sessionId: string): JobRow[];
  insertAudit(row: AuditRow): void;
  listAudit(sessionId: string): AuditRow[];
}

export class InMemoryBridgeRepository implements BridgeRepository {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly commands = new Map<string, CommandRow>();
  private readonly jobs = new Map<string, JobRow>();
  private readonly audits: AuditRow[] = [];

  insertSession(session: SessionRow): void {
    this.sessions.set(session.sessionId, structuredClone(session));
  }

  getSession(sessionId: string): SessionRow | undefined {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  updateSession(session: SessionRow): void {
    this.sessions.set(session.sessionId, structuredClone(session));
  }

  insertCommand(command: CommandRow): void {
    this.commands.set(this.commandKey(command.sessionId, command.commandId), structuredClone(command));
  }

  getCommand(sessionId: string, commandId: string): CommandRow | undefined {
    const command = this.commands.get(this.commandKey(sessionId, commandId));
    return command ? structuredClone(command) : undefined;
  }

  updateCommand(command: CommandRow): void {
    this.commands.set(this.commandKey(command.sessionId, command.commandId), structuredClone(command));
  }

  upsertJob(job: JobRow): void {
    this.jobs.set(this.jobKey(job.sessionId, job.jobId), structuredClone(job));
  }

  getJob(sessionId: string, jobId: string): JobRow | undefined {
    const job = this.jobs.get(this.jobKey(sessionId, jobId));
    return job ? structuredClone(job) : undefined;
  }

  listJobs(sessionId: string): JobRow[] {
    return [...this.jobs.values()]
      .filter((job) => job.sessionId === sessionId)
      .map((job) => structuredClone(job));
  }

  insertAudit(row: AuditRow): void {
    this.audits.push(structuredClone(row));
  }

  listAudit(sessionId: string): AuditRow[] {
    return this.audits.filter((row) => row.sessionId === sessionId).map((row) => structuredClone(row));
  }

  private commandKey(sessionId: string, commandId: string): string {
    return `${sessionId}:${commandId}`;
  }

  private jobKey(sessionId: string, jobId: string): string {
    return `${sessionId}:${jobId}`;
  }
}

export interface RunnerMetadata {
  runnerInstanceId: string;
  kernelStartedAt: string;
  runnerStartedAt?: string;
}

export interface BrokerStatus {
  session_id: string;
  runner_connected: boolean;
  controller_connected: boolean;
  runner_instance_id: string | null;
  kernel_started_at: string | null;
  runner_started_at: string | null;
  last_heartbeat_at: string | null;
  project_root: "/content/project";
  active_job_id: string | null;
  session_expires_at: string;
}

export type RunnerHandler = (
  envelope: CommandEnvelope,
) => Promise<ResultEnvelope> | ResultEnvelope;

export interface CreateSessionResult {
  sessionId: string;
  controllerToken: string;
  runnerToken: string;
  expiresAt: string;
}

export class BrokerError extends Error {
  readonly bridgeError: BridgeError;

  constructor(error: BridgeError) {
    super(error.message);
    this.bridgeError = error;
  }
}

export class RunnerResultUnavailableError extends Error {}

type AuthFailureThrottleKey = `${string}:${"controller" | "runner"}`;

export class SessionBroker {
  private readonly runners = new Map<string, RunnerHandler>();
  private readonly authFailureBuckets = new Map<AuthFailureThrottleKey, number[]>();

  constructor(
    private readonly repository: BridgeRepository = new InMemoryBridgeRepository(),
    private readonly nonceRepository: NonceRepository = new InMemoryNonceRepository(),
    private readonly options: {
      sessionTtlMs?: number;
      authSkewMs?: number;
      runnerStaleMs?: number;
      authFailureWindowMs?: number;
      authFailureLimit?: number;
    } = {},
  ) {}

  createSession(now = new Date(), sessionId = newId("sess")): CreateSessionResult {
    const controllerToken = generateToken();
    const runnerToken = generateToken();
    const expiresAt = new Date(now.getTime() + (this.options.sessionTtlMs ?? 8 * 60 * 60 * 1000)).toISOString();

    this.repository.insertSession({
      sessionId,
      controllerTokenHash: hashToken(controllerToken),
      runnerTokenHash: hashToken(runnerToken),
      createdAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
      runnerConnected: false,
      runnerInstanceId: null,
      kernelStartedAt: null,
      runnerStartedAt: null,
      lastHeartbeatAt: null,
    });

    this.audit({
      sessionId,
      at: now.toISOString(),
      event: "session_create",
      callerSide: "system",
      outcome: "accepted",
    });

    return { sessionId, controllerToken, runnerToken, expiresAt };
  }

  getStatus(sessionId: string, auth: AuthAttempt, now = new Date()): BrokerStatus {
    const session = this.requireController(sessionId, auth, now);
    return this.toStatus(session, now);
  }

  revoke(sessionId: string, auth: AuthAttempt, now = new Date()): void {
    const session = this.requireController(sessionId, auth, now);
    session.revokedAt = now.toISOString();
    session.runnerConnected = false;
    this.runners.delete(sessionId);
    this.repository.updateSession(session);
    this.audit({
      sessionId,
      at: now.toISOString(),
      event: "revoke",
      callerSide: "controller",
      outcome: "accepted",
    });
  }

  attachRunner(
    sessionId: string,
    auth: AuthAttempt,
    metadata: RunnerMetadata,
    handler: RunnerHandler,
    now = new Date(),
  ): void {
    const session = this.requireRunner(sessionId, auth, now);
    const previousRunnerInstanceId = session.runnerInstanceId;
    const attachEvent =
      session.runnerInstanceId === null
        ? "runner_attach"
        : session.runnerInstanceId === metadata.runnerInstanceId
          ? "runner_reconnect"
          : "runner_restart";
    if (
      previousRunnerInstanceId &&
      previousRunnerInstanceId !== metadata.runnerInstanceId
    ) {
      this.markRunningJobsLost(sessionId, previousRunnerInstanceId, now);
    }
    session.runnerConnected = true;
    session.runnerInstanceId = metadata.runnerInstanceId;
    session.kernelStartedAt = metadata.kernelStartedAt;
    session.runnerStartedAt = metadata.runnerStartedAt ?? now.toISOString();
    session.lastHeartbeatAt = now.toISOString();
    this.repository.updateSession(session);
    this.runners.set(sessionId, handler);
    this.audit({
      sessionId,
      at: now.toISOString(),
      event: attachEvent,
      callerSide: "runner",
      outcome: "accepted",
    });
  }

  runnerHeartbeat(sessionId: string, auth: AuthAttempt, now = new Date()): void {
    const session = this.requireRunner(sessionId, auth, now);
    session.lastHeartbeatAt = now.toISOString();
    this.repository.updateSession(session);
  }

  recordRunnerActivity(sessionId: string, runnerInstanceId: string | null, now = new Date()): void {
    const session = this.requireLiveSession(sessionId, now);
    if (runnerInstanceId && session.runnerInstanceId !== runnerInstanceId) {
      return;
    }
    session.runnerConnected = true;
    session.lastHeartbeatAt = now.toISOString();
    this.repository.updateSession(session);
  }

  restoreRunnerConnection(
    sessionId: string,
    metadata: RunnerMetadata,
    handler: RunnerHandler,
    now = new Date(),
  ): void {
    const session = this.requireLiveSession(sessionId, now);
    const previousRunnerInstanceId = session.runnerInstanceId;
    if (
      previousRunnerInstanceId &&
      previousRunnerInstanceId !== metadata.runnerInstanceId
    ) {
      this.markRunningJobsLost(sessionId, previousRunnerInstanceId, now);
    }
    session.runnerConnected = true;
    session.runnerInstanceId = metadata.runnerInstanceId;
    session.kernelStartedAt = metadata.kernelStartedAt;
    session.runnerStartedAt = metadata.runnerStartedAt ?? session.runnerStartedAt ?? now.toISOString();
    session.lastHeartbeatAt = now.toISOString();
    this.repository.updateSession(session);
    this.runners.set(sessionId, handler);
  }

  markRunnerDisconnected(sessionId: string, runnerInstanceId: string | null, now = new Date()): void {
    const session = this.repository.getSession(sessionId);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now.getTime()) {
      return;
    }
    if (runnerInstanceId && session.runnerInstanceId !== runnerInstanceId) {
      return;
    }
    session.runnerConnected = false;
    session.lastHeartbeatAt = now.toISOString();
    this.repository.updateSession(session);
    this.runners.delete(sessionId);
  }

  authenticateRunner(sessionId: string, auth: AuthAttempt, now = new Date()): void {
    this.requireRunner(sessionId, auth, now);
  }

  preflightRunnerAuth(sessionId: string, auth: AuthAttempt, now = new Date()): void {
    const session = this.requireLiveSession(sessionId, now);
    try {
      this.assertAuthNotThrottled(sessionId, "runner", now);
      validateTimestamp(auth.timestamp, {
        now,
        skewMs: this.options.authSkewMs,
      });
      if (!verifyToken(auth.token, session.runnerTokenHash)) {
        throw new AuthFailure(bridgeError("UNAUTHORIZED", "Invalid credentials."));
      }
      if (!auth.nonce) {
        throw new AuthFailure(bridgeError("UNAUTHORIZED", "Missing auth nonce."));
      }
      if (this.nonceRepository.hasNonce(sessionId, "runner", auth.nonce)) {
        throw new AuthFailure(bridgeError("REPLAY_DETECTED", "Nonce has already been used."));
      }
    } catch (error) {
      this.recordAuthFailure(sessionId, "runner", now, error);
      this.auditAuthFailure(sessionId, "runner", now, error);
      throw this.toBrokerError(error);
    }
  }

  async createCommand(
    sessionId: string,
    auth: AuthAttempt,
    input: { type: CommandType; payload?: unknown; deadlineMs?: number; commandId?: string },
    now = new Date(),
  ): Promise<CommandRow> {
    const session = this.requireController(sessionId, auth, now);
    const commandId = input.commandId ?? newId("cmd");
    const deadlineAt = new Date(now.getTime() + (input.deadlineMs ?? 30_000)).toISOString();
    const hash = payloadHash(input.payload ?? {});
    const existing = this.repository.getCommand(sessionId, commandId);
    if (existing) {
      if (existing.type !== input.type || existing.requestPayloadHash !== hash) {
        throw new BrokerError(
          bridgeError(
            "INVALID_ARGUMENT",
            "Command id has already been used with a different type or payload.",
          ),
        );
      }
      return existing;
    }

    const createdAt = now.toISOString();
    const command: CommandRow = {
      sessionId,
      commandId,
      type: input.type,
      state: "accepted",
      requestPayload: input.payload ?? {},
      requestPayloadHash: hash,
      resultPayload: null,
      error: null,
      deadlineAt,
      createdAt,
      updatedAt: createdAt,
      runnerInstanceId: null,
      runnerMessageId: null,
      stateHistory: ["accepted"],
    };
    this.repository.insertCommand(command);
    this.audit({
      sessionId,
      at: createdAt,
      event: "command_create",
      callerSide: "controller",
      outcome: "accepted",
      commandId,
      commandType: input.type,
      payloadHash: hash,
    });

    this.transitionCommand(command, "queued", now);

    const runner = this.runners.get(sessionId);
    if (!this.isRunnerFresh(session, now) || !session.runnerInstanceId || !runner) {
      this.failCommand(command, bridgeError("RUNNER_OFFLINE", "No Colab runner is connected for this session.", true), now);
      return this.requireCommand(sessionId, commandId);
    }

    const envelope = createCommandEnvelope({
      sessionId,
      commandId,
      type: input.type,
      payload: input.payload ?? {},
      deadlineAt,
      sentAt: now.toISOString(),
    });
    command.runnerInstanceId = session.runnerInstanceId;
    command.runnerMessageId = envelope.message_id;
    this.transitionCommand(command, "sent_to_runner", now);

    let result: ResultEnvelope;
    try {
      result = await runner(envelope);
    } catch (error) {
      const deliveredCommand = this.requireCommand(sessionId, commandId);
      if (error instanceof RunnerResultUnavailableError) {
        this.markCommandUnknown(
          deliveredCommand,
          bridgeError("COMMAND_STATE_UNKNOWN", error.message, true),
          now,
        );
      } else {
        this.failCommand(
          deliveredCommand,
          bridgeError("INTERNAL_ERROR", "Runner failed while executing the command."),
          now,
        );
      }
      return this.requireCommand(sessionId, commandId);
    }

    const deliveredCommand = this.requireCommand(sessionId, commandId);
    const applied = this.applyRunnerResult(
      result,
      { runnerInstanceId: session.runnerInstanceId, replyTo: envelope.message_id },
      now,
    );
    if (!applied) {
      this.failCommand(
        deliveredCommand,
        bridgeError("INTERNAL_ERROR", "Runner returned a result envelope that does not match the command."),
        now,
        result.payload,
      );
      return this.requireCommand(sessionId, commandId);
    }
    return this.requireCommand(sessionId, commandId);
  }

  acknowledgeCommand(sessionId: string, auth: AuthAttempt, commandId: string, now = new Date()): CommandRow {
    this.requireRunner(sessionId, auth, now);
    const command = this.requireCommand(sessionId, commandId);
    if (!isFinalCommandState(command.state)) {
      this.transitionCommand(command, "runner_acknowledged", now);
    }
    return this.requireCommand(sessionId, commandId);
  }

  acknowledgeCommandFromRunner(
    sessionId: string,
    runnerInstanceId: string | null,
    commandId: string,
    replyTo: string,
    now = new Date(),
  ): CommandRow | null {
    const command = this.repository.getCommand(sessionId, commandId);
    if (!command) {
      return null;
    }
    if (command.runnerMessageId && command.runnerMessageId !== replyTo) {
      return null;
    }
    if (!this.isCurrentRunnerInstance(sessionId, runnerInstanceId)) {
      return null;
    }
    if (runnerInstanceId && command.runnerInstanceId && command.runnerInstanceId !== runnerInstanceId) {
      return null;
    }
    if (!isFinalCommandState(command.state)) {
      this.transitionCommand(command, "runner_acknowledged", now);
    }
    return this.requireCommand(sessionId, commandId);
  }

  applyRunnerResult(
    result: ResultEnvelope,
    expected: { runnerInstanceId?: string | null; replyTo?: string } = {},
    now = new Date(),
  ): CommandRow | null {
    const command = this.repository.getCommand(result.session_id, result.command_id);
    if (!command) {
      return null;
    }
    if (expected.replyTo && result.reply_to !== expected.replyTo) {
      return null;
    }
    if (command.runnerMessageId && result.reply_to !== command.runnerMessageId) {
      return null;
    }
    if (!this.isCurrentRunnerInstance(result.session_id, expected.runnerInstanceId ?? null)) {
      return null;
    }
    if (
      expected.runnerInstanceId &&
      command.runnerInstanceId &&
      command.runnerInstanceId !== expected.runnerInstanceId
    ) {
      return null;
    }
    if (
      isFinalCommandState(command.state) &&
      command.state !== "unknown" &&
      !(command.state === "failed" && command.error?.code === "COMMAND_STATE_UNKNOWN")
    ) {
      return command;
    }

    if (result.ok) {
      this.completeCommand(command, result.payload, now);
    } else {
      this.failCommand(
        command,
        result.error ?? bridgeError("INTERNAL_ERROR", "Runner returned a failed result without an error."),
        now,
        result.payload,
      );
    }
    const updated = this.requireCommand(result.session_id, result.command_id);
    this.applyJobMetadataFromResult(updated, result, now);
    return this.requireCommand(result.session_id, result.command_id);
  }

  getCommandResult(sessionId: string, auth: AuthAttempt, commandId: string, now = new Date()): CommandRow {
    this.requireController(sessionId, auth, now);
    return this.requireCommand(sessionId, commandId);
  }

  getAuditRows(sessionId: string): AuditRow[] {
    return this.repository.listAudit(sessionId);
  }

  getStoredCommand(sessionId: string, commandId: string): CommandRow | undefined {
    return this.repository.getCommand(sessionId, commandId);
  }

  private completeCommand(command: CommandRow, resultPayload: unknown, now: Date): void {
    this.transitionCommand(command, "running", now);
    command.resultPayload = resultPayload;
    command.error = null;
    this.transitionCommand(command, "succeeded", now);
  }

  private failCommand(command: CommandRow, error: BridgeError, now: Date, resultPayload: unknown = null): void {
    command.resultPayload = resultPayload;
    command.error = error;
    this.transitionCommand(command, "failed", now);
  }

  private markCommandUnknown(command: CommandRow, error: BridgeError, now: Date): void {
    command.error = error;
    this.transitionCommand(command, "unknown", now);
  }

  private transitionCommand(command: CommandRow, nextState: CommandState, now: Date): void {
    if (command.state === nextState) {
      command.updatedAt = now.toISOString();
      this.repository.updateCommand(command);
      return;
    }
    command.state = nextState;
    command.updatedAt = now.toISOString();
    command.stateHistory.push(nextState);
    this.repository.updateCommand(command);
  }

  private applyJobMetadataFromResult(command: CommandRow, result: ResultEnvelope, now: Date): void {
    if (!result.ok) {
      return;
    }

    if (command.type === "start_job") {
      this.recordStartedJob(command, result.payload, now);
      return;
    }
    if (command.type === "list_jobs") {
      this.recordListedJobs(command, result.payload, now);
      return;
    }
    if (command.type === "job_status") {
      this.recordJobSummary(command, result.payload, now);
      return;
    }
    if (command.type === "tail_job") {
      this.recordTailJob(command, result.payload, now);
      return;
    }
    if (command.type === "interrupt_job") {
      this.recordInterruptedJob(command, result.payload, now);
    }
  }

  private recordStartedJob(command: CommandRow, payload: unknown, now: Date): void {
    if (!isStartJobResultPayload(payload)) {
      return;
    }
    const request = isRecord(command.requestPayload) ? command.requestPayload : {};
    const name = typeof request.name === "string" ? request.name : undefined;
    this.repository.upsertJob({
      sessionId: command.sessionId,
      jobId: payload.job_id,
      commandId: command.commandId,
      runnerInstanceId: command.runnerInstanceId,
      status: payload.status,
      startedAt: payload.started_at,
      endedAt: null,
      exitCode: null,
      interruptedAt: null,
      updatedAt: now.toISOString(),
      ...(name ? { name } : {}),
    });
  }

  private recordListedJobs(command: CommandRow, payload: unknown, now: Date): void {
    if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
      return;
    }
    for (const job of payload.jobs) {
      this.recordJobSummary(command, job, now);
    }
  }

  private recordJobSummary(command: CommandRow, payload: unknown, now: Date): void {
    if (!isJobSummaryPayload(payload)) {
      return;
    }
    const existing = this.repository.getJob(command.sessionId, payload.job_id);
    this.repository.upsertJob({
      sessionId: command.sessionId,
      jobId: payload.job_id,
      commandId: existing?.commandId ?? command.commandId,
      runnerInstanceId: existing?.runnerInstanceId ?? command.runnerInstanceId,
      status: payload.status,
      startedAt: payload.started_at,
      endedAt: payload.status === "running" ? null : (existing?.endedAt ?? now.toISOString()),
      exitCode: payload.exit_code,
      interruptedAt: payload.interrupted_at,
      updatedAt: now.toISOString(),
      ...(payload.name ?? existing?.name ? { name: payload.name ?? existing?.name } : {}),
    });
  }

  private recordTailJob(command: CommandRow, payload: unknown, now: Date): void {
    if (!isTailJobResultPayload(payload)) {
      return;
    }
    const existing = this.repository.getJob(command.sessionId, payload.job_id);
    if (!existing) {
      return;
    }
    this.repository.upsertJob({
      ...existing,
      status: payload.status,
      endedAt: payload.status === "running" ? null : (existing.endedAt ?? now.toISOString()),
      exitCode: payload.exit_code,
      updatedAt: now.toISOString(),
    });
  }

  private recordInterruptedJob(command: CommandRow, payload: unknown, now: Date): void {
    if (!isInterruptJobResultPayload(payload)) {
      return;
    }
    const existing = this.repository.getJob(command.sessionId, payload.job_id);
    const request = isRecord(command.requestPayload) ? command.requestPayload : {};
    this.repository.upsertJob({
      sessionId: command.sessionId,
      jobId: payload.job_id,
      commandId: existing?.commandId ?? command.commandId,
      runnerInstanceId: existing?.runnerInstanceId ?? command.runnerInstanceId,
      status: payload.status,
      startedAt: existing?.startedAt ?? now.toISOString(),
      endedAt: payload.status === "running" ? null : payload.interrupted_at,
      exitCode: payload.exit_code,
      interruptedAt: payload.interrupted_at,
      updatedAt: now.toISOString(),
      ...(existing?.name ?? (typeof request.name === "string" ? request.name : undefined)
        ? { name: existing?.name ?? (request.name as string) }
        : {}),
    });
  }

  private markRunningJobsLost(sessionId: string, runnerInstanceId: string, now: Date): void {
    for (const job of this.repository.listJobs(sessionId)) {
      if (job.status !== "running" || job.runnerInstanceId !== runnerInstanceId) {
        continue;
      }
      this.repository.upsertJob({
        ...job,
        status: "unknown_lost",
        endedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }
  }

  private isCurrentRunnerInstance(sessionId: string, runnerInstanceId: string | null): boolean {
    if (!runnerInstanceId) {
      return true;
    }
    const session = this.repository.getSession(sessionId);
    return Boolean(session && session.runnerInstanceId === runnerInstanceId);
  }

  private requireController(sessionId: string, auth: AuthAttempt, now: Date): SessionRow {
    const session = this.requireLiveSession(sessionId, now);
    try {
      this.assertAuthNotThrottled(sessionId, "controller", now);
      validateAuthenticatedRequest({
        sessionId,
        side: "controller",
        attempt: auth,
        expectedTokenHash: session.controllerTokenHash,
        nonceRepository: this.nonceRepository,
        now,
        skewMs: this.options.authSkewMs,
      });
      this.clearAuthFailures(sessionId, "controller");
      return session;
    } catch (error) {
      this.recordAuthFailure(sessionId, "controller", now, error);
      this.auditAuthFailure(sessionId, "controller", now, error);
      throw this.toBrokerError(error);
    }
  }

  private requireRunner(sessionId: string, auth: AuthAttempt, now: Date): SessionRow {
    const session = this.requireLiveSession(sessionId, now);
    try {
      this.assertAuthNotThrottled(sessionId, "runner", now);
      validateAuthenticatedRequest({
        sessionId,
        side: "runner",
        attempt: auth,
        expectedTokenHash: session.runnerTokenHash,
        nonceRepository: this.nonceRepository,
        now,
        skewMs: this.options.authSkewMs,
      });
      this.clearAuthFailures(sessionId, "runner");
      return session;
    } catch (error) {
      this.recordAuthFailure(sessionId, "runner", now, error);
      this.auditAuthFailure(sessionId, "runner", now, error);
      throw this.toBrokerError(error);
    }
  }

  private assertAuthNotThrottled(
    sessionId: string,
    side: "controller" | "runner",
    now: Date,
  ): void {
    const key = this.authFailureKey(sessionId, side);
    const failures = this.pruneAuthFailures(key, now);
    if (failures.length >= this.authFailureLimit()) {
      throw new AuthFailure(bridgeError("RATE_LIMITED", "Too many failed authentication attempts.", true));
    }
  }

  private recordAuthFailure(
    sessionId: string,
    side: "controller" | "runner",
    now: Date,
    error: unknown,
  ): void {
    if (error instanceof AuthFailure && error.bridgeError.code === "RATE_LIMITED") {
      return;
    }
    const key = this.authFailureKey(sessionId, side);
    const failures = this.pruneAuthFailures(key, now);
    failures.push(now.getTime());
    this.authFailureBuckets.set(key, failures);
  }

  private clearAuthFailures(sessionId: string, side: "controller" | "runner"): void {
    this.authFailureBuckets.delete(this.authFailureKey(sessionId, side));
  }

  private pruneAuthFailures(key: AuthFailureThrottleKey, now: Date): number[] {
    const cutoff = now.getTime() - this.authFailureWindowMs();
    const failures = (this.authFailureBuckets.get(key) ?? []).filter((at) => at >= cutoff);
    if (failures.length > 0) {
      this.authFailureBuckets.set(key, failures);
    } else {
      this.authFailureBuckets.delete(key);
    }
    return failures;
  }

  private authFailureKey(
    sessionId: string,
    side: "controller" | "runner",
  ): AuthFailureThrottleKey {
    return `${sessionId}:${side}`;
  }

  private authFailureWindowMs(): number {
    return this.options.authFailureWindowMs ?? 60_000;
  }

  private authFailureLimit(): number {
    return this.options.authFailureLimit ?? 20;
  }

  private requireLiveSession(sessionId: string, now: Date): SessionRow {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new BrokerError(bridgeError("UNAUTHORIZED", "Unknown session."));
    }
    if (session.revokedAt) {
      throw new BrokerError(bridgeError("UNAUTHORIZED", "Session has been revoked."));
    }
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      throw new BrokerError(bridgeError("SESSION_EXPIRED", "Session has expired."));
    }
    return session;
  }

  private requireCommand(sessionId: string, commandId: string): CommandRow {
    const command = this.repository.getCommand(sessionId, commandId);
    if (!command) {
      throw new BrokerError(bridgeError("INVALID_ARGUMENT", "Unknown command."));
    }
    return command;
  }

  private toStatus(session: SessionRow, now: Date): BrokerStatus {
    const activeJob = this.repository
      .listJobs(session.sessionId)
      .filter(
        (job) =>
          job.status === "running" &&
          (!session.runnerInstanceId || job.runnerInstanceId === session.runnerInstanceId),
      )
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
    return {
      session_id: session.sessionId,
      runner_connected: this.isRunnerFresh(session, now),
      controller_connected: true,
      runner_instance_id: session.runnerInstanceId,
      kernel_started_at: session.kernelStartedAt,
      runner_started_at: session.runnerStartedAt,
      last_heartbeat_at: session.lastHeartbeatAt,
      project_root: "/content/project",
      active_job_id: activeJob?.jobId ?? null,
      session_expires_at: session.expiresAt,
    };
  }

  private isRunnerFresh(session: SessionRow, now: Date): boolean {
    if (!session.runnerConnected || !session.lastHeartbeatAt) {
      return false;
    }

    const lastHeartbeat = Date.parse(session.lastHeartbeatAt);
    if (!Number.isFinite(lastHeartbeat)) {
      return false;
    }

    return now.getTime() - lastHeartbeat <= (this.options.runnerStaleMs ?? 45_000);
  }

  private audit(row: AuditRow): void {
    this.repository.insertAudit(row);
  }

  private auditAuthFailure(
    sessionId: string,
    callerSide: "controller" | "runner",
    now: Date,
    error: unknown,
  ): void {
    this.audit({
      sessionId,
      at: now.toISOString(),
      event: "auth_failure",
      callerSide,
      outcome: "rejected",
      errorCode: error instanceof AuthFailure ? error.bridgeError.code : "INTERNAL_ERROR",
    });
  }

  private toBrokerError(error: unknown): BrokerError {
    if (error instanceof BrokerError) {
      return error;
    }
    if (error instanceof AuthFailure) {
      return new BrokerError(error.bridgeError);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStartJobResultPayload(value: unknown): value is StartJobResultPayload {
  return (
    isRecord(value) &&
    typeof value.job_id === "string" &&
    value.status === "running" &&
    typeof value.started_at === "string"
  );
}

function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === "running" ||
    value === "exited" ||
    value === "interrupted" ||
    value === "unknown_lost"
  );
}

function isJobSummaryPayload(value: unknown): value is JobSummaryPayload {
  return (
    isRecord(value) &&
    typeof value.job_id === "string" &&
    isJobStatus(value.status) &&
    typeof value.started_at === "string" &&
    (typeof value.exit_code === "number" || value.exit_code === null) &&
    (typeof value.interrupted_at === "string" || value.interrupted_at === null) &&
    typeof value.active === "boolean"
  );
}

function isTailJobResultPayload(value: unknown): value is TailJobResultPayload {
  return (
    isRecord(value) &&
    typeof value.job_id === "string" &&
    isJobStatus(value.status) &&
    (typeof value.exit_code === "number" || value.exit_code === null)
  );
}

function isInterruptJobResultPayload(value: unknown): value is InterruptJobResultPayload {
  return (
    isRecord(value) &&
    typeof value.job_id === "string" &&
    isJobStatus(value.status) &&
    (typeof value.exit_code === "number" || value.exit_code === null) &&
    typeof value.interrupted_at === "string"
  );
}
