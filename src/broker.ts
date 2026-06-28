import {
  AuthFailure,
  generateToken,
  hashToken,
  type AuthAttempt,
  type NonceRepository,
  InMemoryNonceRepository,
  validateAuthenticatedRequest,
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
  type ResultEnvelope,
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

export interface BridgeRepository {
  insertSession(session: SessionRow): void;
  getSession(sessionId: string): SessionRow | undefined;
  updateSession(session: SessionRow): void;
  insertCommand(command: CommandRow): void;
  getCommand(sessionId: string, commandId: string): CommandRow | undefined;
  updateCommand(command: CommandRow): void;
  insertAudit(row: AuditRow): void;
  listAudit(sessionId: string): AuditRow[];
}

export class InMemoryBridgeRepository implements BridgeRepository {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly commands = new Map<string, CommandRow>();
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

  insertAudit(row: AuditRow): void {
    this.audits.push(structuredClone(row));
  }

  listAudit(sessionId: string): AuditRow[] {
    return this.audits.filter((row) => row.sessionId === sessionId).map((row) => structuredClone(row));
  }

  private commandKey(sessionId: string, commandId: string): string {
    return `${sessionId}:${commandId}`;
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
  active_job_id: null;
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

export class SessionBroker {
  private readonly runners = new Map<string, RunnerHandler>();

  constructor(
    private readonly repository: BridgeRepository = new InMemoryBridgeRepository(),
    private readonly nonceRepository: NonceRepository = new InMemoryNonceRepository(),
    private readonly options: { sessionTtlMs?: number; authSkewMs?: number; runnerStaleMs?: number } = {},
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
      event: "runner_attach",
      callerSide: "runner",
      outcome: "accepted",
    });
  }

  runnerHeartbeat(sessionId: string, auth: AuthAttempt, now = new Date()): void {
    const session = this.requireRunner(sessionId, auth, now);
    session.lastHeartbeatAt = now.toISOString();
    this.repository.updateSession(session);
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

    command.runnerInstanceId = session.runnerInstanceId;
    this.transitionCommand(command, "sent_to_runner", now);
    const envelope = createCommandEnvelope({
      sessionId,
      commandId,
      type: input.type,
      payload: input.payload ?? {},
      deadlineAt,
      sentAt: now.toISOString(),
    });

    let result: ResultEnvelope;
    try {
      result = await runner(envelope);
    } catch {
      const deliveredCommand = this.requireCommand(sessionId, commandId);
      this.failCommand(
        deliveredCommand,
        bridgeError("INTERNAL_ERROR", "Runner failed while executing the command."),
        now,
      );
      return this.requireCommand(sessionId, commandId);
    }

    const deliveredCommand = this.requireCommand(sessionId, commandId);
    if (
      result.session_id !== sessionId ||
      result.command_id !== commandId ||
      result.reply_to !== envelope.message_id
    ) {
      this.failCommand(
        deliveredCommand,
        bridgeError("INTERNAL_ERROR", "Runner returned a result envelope that does not match the command."),
        now,
        result.payload,
      );
      return this.requireCommand(sessionId, commandId);
    }

    if (result.ok) {
      this.completeCommand(deliveredCommand, result.payload, now);
    } else {
      this.failCommand(
        deliveredCommand,
        result.error ?? bridgeError("INTERNAL_ERROR", "Runner returned a failed result without an error."),
        now,
        result.payload,
      );
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

  private transitionCommand(command: CommandRow, nextState: CommandState, now: Date): void {
    command.state = nextState;
    command.updatedAt = now.toISOString();
    command.stateHistory.push(nextState);
    this.repository.updateCommand(command);
  }

  private requireController(sessionId: string, auth: AuthAttempt, now: Date): SessionRow {
    const session = this.requireLiveSession(sessionId, now);
    try {
      validateAuthenticatedRequest({
        sessionId,
        side: "controller",
        attempt: auth,
        expectedTokenHash: session.controllerTokenHash,
        nonceRepository: this.nonceRepository,
        now,
        skewMs: this.options.authSkewMs,
      });
      return session;
    } catch (error) {
      this.auditAuthFailure(sessionId, "controller", now, error);
      throw this.toBrokerError(error);
    }
  }

  private requireRunner(sessionId: string, auth: AuthAttempt, now: Date): SessionRow {
    const session = this.requireLiveSession(sessionId, now);
    try {
      validateAuthenticatedRequest({
        sessionId,
        side: "runner",
        attempt: auth,
        expectedTokenHash: session.runnerTokenHash,
        nonceRepository: this.nonceRepository,
        now,
        skewMs: this.options.authSkewMs,
      });
      return session;
    } catch (error) {
      this.auditAuthFailure(sessionId, "runner", now, error);
      throw this.toBrokerError(error);
    }
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
    return {
      session_id: session.sessionId,
      runner_connected: this.isRunnerFresh(session, now),
      controller_connected: true,
      runner_instance_id: session.runnerInstanceId,
      kernel_started_at: session.kernelStartedAt,
      runner_started_at: session.runnerStartedAt,
      last_heartbeat_at: session.lastHeartbeatAt,
      project_root: "/content/project",
      active_job_id: null,
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
