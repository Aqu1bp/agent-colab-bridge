import { type AuthAttempt, type NonceRepository } from "./auth.js";
import {
  type AuditRow,
  type BridgeRepository,
  BrokerError,
  type RunnerMetadata,
  type SessionRow,
  SessionBroker,
} from "./broker.js";
import { createBridgeHttpHandler, type BridgeHttpHandler } from "./http.js";
import {
  bridgeError,
  newId,
  type BridgeError,
  type CommandEnvelope,
  type CommandRow,
  type ResultEnvelope,
} from "./protocol.js";
import { type RunnerTransport } from "./runner-connection.js";

export interface BridgeWorkerEnv {
  ADMIN_SECRET?: string;
  COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS?: string;
  COLAB_BRIDGE_SESSIONS?: DurableObjectNamespaceLike;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectIdLike {}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  acceptWebSocket?(socket: WorkerWebSocketLike): void;
  getWebSockets?(): WorkerWebSocketLike[];
}

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

export interface WorkerWebSocketLike {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  accept?(): void;
  serializeAttachment?(attachment: unknown): void;
  deserializeAttachment?(): unknown;
}

interface WebSocketPairLike {
  0: WorkerWebSocketLike;
  1: WorkerWebSocketLike;
}

interface WebSocketPairConstructorLike {
  new(): WebSocketPairLike;
}

declare const WebSocketPair: WebSocketPairConstructorLike | undefined;

interface WorkerBrokerStateSnapshot {
  sessions: SessionRow[];
  commands: CommandRow[];
  audits: AuditRow[];
  nonces: NonceSnapshotRow[];
}

interface NonceSnapshotRow {
  sessionId: string;
  side: "controller" | "runner";
  nonce: string;
  seenAt: string;
}

interface RunnerSocketAttachment {
  side: "runner";
  sessionId: string;
  runnerInstanceId: string;
  kernelStartedAt: string;
  runnerStartedAt?: string;
}

interface PendingRunnerResult {
  socket: WorkerWebSocketLike;
  timeout: ReturnType<typeof setTimeout>;
  resolve(result: ResultEnvelope): void;
  reject(error: Error): void;
}

const persistedStateKey = "colab_mcp_bridge_state_v1";
const internalSessionIdHeader = "x-colab-bridge-session-id";
const fallbackBrokers = new WeakMap<object, SessionBroker>();
const fallbackBrokerKey = {};

export default {
  fetch(
    request: Request,
    env: BridgeWorkerEnv = {},
    _context?: ExecutionContextLike,
  ): Promise<Response> {
    return createWorkerFetchHandler(env)(request);
  },
};

export function createWorkerFetchHandler(
  env: BridgeWorkerEnv = {},
  options: {
    broker?: SessionBroker;
    enableDangerousTools?: boolean;
    runnerTransportFactory?: (input: {
      sessionId: string;
      runnerInstanceId: string;
    }) => RunnerTransport;
  } = {},
): BridgeHttpHandler {
  return async (request: Request): Promise<Response> => {
    if (isHealthRequest(request)) {
      return createBridgeHttpHandler({
        broker: options.broker ?? getFallbackBroker(env),
        adminSecret: readAdminSecret(env) ?? "",
        enableDangerousTools: resolveDangerousToolsEnabled(env, options),
      })(request);
    }

    const adminSecret = readAdminSecret(env);
    if (!adminSecret) {
      return workerJsonError(
        500,
        bridgeError("INTERNAL_ERROR", "Worker ADMIN_SECRET is not configured.", false),
      );
    }

    if (!options.broker && env.COLAB_BRIDGE_SESSIONS) {
      const routed = routeDurableObjectRequest(request, env.COLAB_BRIDGE_SESSIONS);
      if (routed) {
        return routed;
      }
    }

    return createBridgeHttpHandler({
      broker: options.broker ?? getFallbackBroker(env),
      adminSecret,
      enableDangerousTools: resolveDangerousToolsEnabled(env, options),
      runnerTransportFactory: options.runnerTransportFactory,
    })(request);
  };
}

export function getWorkerBrokerForTest(env: BridgeWorkerEnv = {}): SessionBroker {
  return getFallbackBroker(env);
}

export class ColabBridgeSessionDurableObject {
  private readonly repository = new SnapshotBridgeRepository();
  private readonly nonceRepository = new SnapshotNonceRepository();
  private readonly broker = new SessionBroker(this.repository, this.nonceRepository);
  private readonly pendingRunnerResults = new Map<string, PendingRunnerResult>();
  private runnerSocket: WorkerWebSocketLike | null = null;
  private runnerAttachment: RunnerSocketAttachment | null = null;
  private loaded = false;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: BridgeWorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (isHealthRequest(request)) {
      return createBridgeHttpHandler({
        broker: this.broker,
        adminSecret: readAdminSecret(this.env) ?? "",
        enableDangerousTools: resolveDangerousToolsEnabled(this.env),
      })(request);
    }

    const adminSecret = readAdminSecret(this.env);
    if (!adminSecret) {
      return workerJsonError(
        500,
        bridgeError("INTERNAL_ERROR", "Worker ADMIN_SECRET is not configured.", false),
      );
    }

    await this.loadPersistedState();
    this.restoreAcceptedRunnerSocket();
    const internalSessionId = request.headers.get(internalSessionIdHeader);
    if (isSessionCreateRequest(request) && internalSessionId) {
      return this.createSessionWithId(request, adminSecret, internalSessionId);
    }

    const runnerWebSocketRoute = matchRunnerWebSocketRoute(request);
    if (runnerWebSocketRoute) {
      try {
        const response = this.acceptRunnerWebSocket(request, runnerWebSocketRoute.sessionId);
        await this.persistState();
        return response;
      } catch (error) {
        if (error instanceof WorkerRouteError) {
          return workerJsonError(error.status, error.bridgeError);
        }
        if (error instanceof BrokerError) {
          return workerJsonError(statusForWorkerBrokerError(error), error.bridgeError);
        }
        return workerJsonError(
          500,
          bridgeError("INTERNAL_ERROR", "Runner WebSocket attach failed.", false),
        );
      }
    }

    const response = await createBridgeHttpHandler({
      broker: this.broker,
      adminSecret,
      enableDangerousTools: resolveDangerousToolsEnabled(this.env),
    })(request);
    await this.persistState();
    return response;
  }

  private async createSessionWithId(
    request: Request,
    adminSecret: string,
    sessionId: string,
  ): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!token || token !== adminSecret) {
      return workerJsonError(
        401,
        bridgeError("UNAUTHORIZED", "Invalid admin credentials.", false),
      );
    }

    const session = this.broker.createSession(new Date(), sessionId);
    await this.persistState();
    return workerJsonOk(201, {
      session_id: session.sessionId,
      controller_token: session.controllerToken,
      runner_token: session.runnerToken,
      expires_at: session.expiresAt,
    });
  }

  private async loadPersistedState(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const snapshot = await this.state.storage.get<WorkerBrokerStateSnapshot>(persistedStateKey);
    if (snapshot) {
      this.repository.hydrate(snapshot);
      this.nonceRepository.hydrate(snapshot.nonces);
    }
    this.loaded = true;
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put<WorkerBrokerStateSnapshot>(persistedStateKey, {
      ...this.repository.snapshot(),
      nonces: this.nonceRepository.snapshot(),
    });
  }

  async webSocketMessage(socket: WorkerWebSocketLike, message: string | ArrayBuffer): Promise<void> {
    await this.loadPersistedState();
    this.restoreAcceptedRunnerSocket();
    const attachment = readRunnerSocketAttachment(socket);
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      socket.close(1003, "Runner message must be JSON.");
      return;
    }

    if (isRunnerHeartbeat(parsed)) {
      if (attachment) {
        this.broker.recordRunnerActivity(attachment.sessionId, attachment.runnerInstanceId);
        await this.persistState();
      }
      return;
    }

    if (!isResultEnvelopeLike(parsed)) {
      socket.close(1003, "Unsupported runner message.");
      return;
    }

    const key = pendingResultKey(parsed.command_id, parsed.reply_to);
    const pending = this.pendingRunnerResults.get(key);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRunnerResults.delete(key);
      pending.resolve(parsed);
    }

    if (attachment) {
      this.broker.recordRunnerActivity(attachment.sessionId, attachment.runnerInstanceId);
      await this.persistState();
    }
  }

  async webSocketClose(socket: WorkerWebSocketLike): Promise<void> {
    await this.loadPersistedState();
    const attachment = readRunnerSocketAttachment(socket);
    this.rejectPendingForSocket(socket, bridgeError("RUNNER_OFFLINE", "Runner WebSocket closed.", true));
    if (attachment) {
      this.broker.markRunnerDisconnected(attachment.sessionId, attachment.runnerInstanceId);
      await this.persistState();
    }
    if (this.runnerSocket === socket) {
      this.runnerSocket = null;
      this.runnerAttachment = null;
    }
  }

  async webSocketError(socket: WorkerWebSocketLike): Promise<void> {
    await this.webSocketClose(socket);
  }

  private acceptRunnerWebSocket(request: Request, sessionId: string): Response {
    if (!isWebSocketUpgrade(request)) {
      return workerJsonError(
        426,
        bridgeError("RUNNER_AUTH_REQUIRED", "Runner WebSocket upgrade is required.", true),
      );
    }

    const pair = createWebSocketPair();
    if (!pair) {
      return workerJsonError(
        500,
        bridgeError("INTERNAL_ERROR", "WebSocketPair is not available in this runtime.", false),
      );
    }

    const auth = parseRunnerAuthForWorker(request.headers);
    const metadata = parseRunnerMetadataForWorker(request.headers);
    this.broker.preflightRunnerAuth(sessionId, auth);

    const attachment: RunnerSocketAttachment = {
      side: "runner",
      sessionId,
      runnerInstanceId: metadata.runnerInstanceId,
      kernelStartedAt: metadata.kernelStartedAt,
      runnerStartedAt: metadata.runnerStartedAt,
    };
    pair[1].serializeAttachment?.(attachment);

    if (this.runnerSocket && this.runnerSocket !== pair[1]) {
      this.runnerSocket.close(1012, "Runner reconnected.");
    }
    this.runnerSocket = pair[1];
    this.runnerAttachment = attachment;
    this.acceptServerSocket(pair[1]);
    this.broker.attachRunner(
      sessionId,
      auth,
      metadata,
      (envelope) => this.sendCommandToRunnerSocket(pair[1], envelope),
    );

    return createWebSocketUpgradeResponse(pair[0]);
  }

  private acceptServerSocket(socket: WorkerWebSocketLike): void {
    if (this.state.acceptWebSocket) {
      this.state.acceptWebSocket(socket);
      return;
    }
    socket.accept?.();
  }

  private restoreAcceptedRunnerSocket(): void {
    if (this.runnerSocket || !this.state.getWebSockets) {
      return;
    }

    for (const socket of this.state.getWebSockets()) {
      const attachment = readRunnerSocketAttachment(socket);
      if (!attachment) {
        continue;
      }

      this.runnerSocket = socket;
      this.runnerAttachment = attachment;
      this.broker.restoreRunnerConnection(
        attachment.sessionId,
        {
          runnerInstanceId: attachment.runnerInstanceId,
          kernelStartedAt: attachment.kernelStartedAt,
          runnerStartedAt: attachment.runnerStartedAt,
        },
        (envelope) => this.sendCommandToRunnerSocket(socket, envelope),
      );
      return;
    }
  }

  private sendCommandToRunnerSocket(
    socket: WorkerWebSocketLike,
    envelope: CommandEnvelope,
  ): Promise<ResultEnvelope> {
    const timeoutMs = Math.max(1_000, Date.parse(envelope.deadline_at) - Date.now() + 1_000);
    return new Promise((resolve, reject) => {
      const key = pendingResultKey(envelope.command_id, envelope.message_id);
      const timeout = setTimeout(() => {
        this.pendingRunnerResults.delete(key);
        reject(new Error("Runner command timed out waiting for WebSocket result."));
      }, timeoutMs);

      this.pendingRunnerResults.set(key, { socket, timeout, resolve, reject });
      try {
        socket.send(JSON.stringify(envelope));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRunnerResults.delete(key);
        reject(error);
      }
    });
  }

  private rejectPendingForSocket(socket: WorkerWebSocketLike, error: BridgeError): void {
    for (const [key, pending] of this.pendingRunnerResults) {
      if (pending.socket !== socket) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingRunnerResults.delete(key);
      pending.reject(new Error(error.message));
    }
  }
}

function getFallbackBroker(env: BridgeWorkerEnv): SessionBroker {
  const key = objectKey(env);
  const existing = fallbackBrokers.get(key);
  if (existing) {
    return existing;
  }

  const broker = new SessionBroker();
  fallbackBrokers.set(key, broker);
  return broker;
}

function objectKey(env: BridgeWorkerEnv): object {
  return env && typeof env === "object" ? env : fallbackBrokerKey;
}

function readAdminSecret(env: BridgeWorkerEnv): string | null {
  return typeof env.ADMIN_SECRET === "string" && env.ADMIN_SECRET.length > 0
    ? env.ADMIN_SECRET
    : null;
}

function resolveDangerousToolsEnabled(
  env: BridgeWorkerEnv,
  options: { enableDangerousTools?: boolean } = {},
): boolean {
  if (options.enableDangerousTools !== undefined) {
    return options.enableDangerousTools;
  }

  return env.COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS === "1";
}

function routeDurableObjectRequest(
  request: Request,
  namespace: DurableObjectNamespaceLike,
): Promise<Response> | null {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (isSessionCreateRequest(request)) {
    const sessionId = newId("sess");
    const headers = new Headers(request.headers);
    headers.set(internalSessionIdHeader, sessionId);
    const routedRequest = new Request(request, { headers });
    return namespace.get(namespace.idFromName(sessionId)).fetch(routedRequest);
  }

  if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "sessions" && parts[2]) {
    return namespace.get(namespace.idFromName(parts[2])).fetch(request);
  }

  return null;
}

function matchRunnerWebSocketRoute(request: Request): { sessionId: string } | null {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (
    request.method === "GET" &&
    parts.length === 5 &&
    parts[0] === "v1" &&
    parts[1] === "sessions" &&
    parts[2] &&
    parts[3] === "runner" &&
    parts[4] === "ws"
  ) {
    return { sessionId: parts[2] };
  }
  return null;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function createWebSocketPair(): WebSocketPairLike | null {
  if (typeof WebSocketPair === "undefined") {
    return null;
  }
  return new WebSocketPair();
}

function createWebSocketUpgradeResponse(clientSocket: WorkerWebSocketLike): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    } as ResponseInit & { webSocket: WorkerWebSocketLike });
  } catch {
    return new Response(null, {
      status: 200,
      headers: { "x-colab-bridge-test-websocket": "accepted" },
    });
  }
}

function parseRunnerAuthForWorker(headers: Headers): AuthAttempt {
  const token = parseBearerTokenForWorker(headers);
  const timestamp = headers.get("x-bridge-timestamp");
  const nonce = headers.get("x-bridge-nonce");

  if (!token) {
    throw new WorkerRouteError(401, bridgeError("UNAUTHORIZED", "Missing bearer authorization.", false));
  }
  if (!timestamp) {
    throw new WorkerRouteError(401, bridgeError("UNAUTHORIZED", "Missing auth timestamp.", false));
  }
  if (!nonce) {
    throw new WorkerRouteError(401, bridgeError("UNAUTHORIZED", "Missing auth nonce.", false));
  }

  return { token, timestamp, nonce };
}

function parseRunnerMetadataForWorker(headers: Headers): RunnerMetadata {
  const runnerInstanceId = headers.get("x-bridge-runner-instance-id")?.trim();
  const kernelStartedAt = headers.get("x-bridge-kernel-started-at")?.trim();
  const runnerStartedAt = headers.get("x-bridge-runner-started-at")?.trim();

  if (!runnerInstanceId) {
    throw new WorkerRouteError(400, bridgeError("INVALID_ARGUMENT", "Missing runner instance id.", false));
  }
  if (!kernelStartedAt || !Number.isFinite(Date.parse(kernelStartedAt))) {
    throw new WorkerRouteError(400, bridgeError("INVALID_ARGUMENT", "Missing or invalid kernel start time.", false));
  }
  if (runnerStartedAt && !Number.isFinite(Date.parse(runnerStartedAt))) {
    throw new WorkerRouteError(400, bridgeError("INVALID_ARGUMENT", "Invalid runner start time.", false));
  }

  return {
    runnerInstanceId,
    kernelStartedAt,
    ...(runnerStartedAt ? { runnerStartedAt } : {}),
  };
}

function parseBearerTokenForWorker(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

class WorkerRouteError extends Error {
  constructor(
    readonly status: number,
    readonly bridgeError: BridgeError,
  ) {
    super(bridgeError.message);
  }
}

function readRunnerSocketAttachment(socket: WorkerWebSocketLike): RunnerSocketAttachment | null {
  const attachment = socket.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
    return null;
  }

  const record = attachment as Record<string, unknown>;
  if (
    record.side === "runner" &&
    typeof record.sessionId === "string" &&
    typeof record.runnerInstanceId === "string" &&
    typeof record.kernelStartedAt === "string"
  ) {
    return {
      side: "runner",
      sessionId: record.sessionId,
      runnerInstanceId: record.runnerInstanceId,
      kernelStartedAt: record.kernelStartedAt,
      ...(typeof record.runnerStartedAt === "string" ? { runnerStartedAt: record.runnerStartedAt } : {}),
    };
  }
  return null;
}

function isRunnerHeartbeat(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === "heartbeat";
}

function isResultEnvelopeLike(value: unknown): value is ResultEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.kind === "result" &&
    typeof record.session_id === "string" &&
    typeof record.command_id === "string" &&
    typeof record.reply_to === "string" &&
    typeof record.message_id === "string" &&
    typeof record.type === "string" &&
    typeof record.ok === "boolean" &&
    "payload" in record
  );
}

function pendingResultKey(commandId: string, replyTo: string): string {
  return `${commandId}:${replyTo}`;
}

function isSessionCreateRequest(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "POST" && url.pathname === "/v1/sessions";
}

function isHealthRequest(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && url.pathname === "/health";
}

function workerJsonOk<TData>(status: number, data: TData): Response {
  return new Response(JSON.stringify({ ok: true, data, error: null }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function workerJsonError(status: number, error: ReturnType<typeof bridgeError>): Response {
  return new Response(JSON.stringify({ ok: false, data: null, error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function statusForWorkerBrokerError(error: BrokerError): number {
  switch (error.bridgeError.code) {
    case "UNAUTHORIZED":
    case "SESSION_EXPIRED":
      return 401;
    case "REPLAY_DETECTED":
      return 409;
    default:
      return 400;
  }
}

class SnapshotBridgeRepository implements BridgeRepository {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly commands = new Map<string, CommandRow>();
  private audits: AuditRow[] = [];

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

  snapshot(): Omit<WorkerBrokerStateSnapshot, "nonces"> {
    return {
      sessions: [...this.sessions.values()].map((row) => structuredClone(row)),
      commands: [...this.commands.values()].map((row) => structuredClone(row)),
      audits: this.audits.map((row) => structuredClone(row)),
    };
  }

  hydrate(snapshot: Omit<WorkerBrokerStateSnapshot, "nonces">): void {
    this.sessions.clear();
    this.commands.clear();
    this.audits = [];

    for (const session of snapshot.sessions ?? []) {
      this.sessions.set(session.sessionId, structuredClone(session));
    }
    for (const command of snapshot.commands ?? []) {
      this.commands.set(this.commandKey(command.sessionId, command.commandId), structuredClone(command));
    }
    this.audits = (snapshot.audits ?? []).map((row) => structuredClone(row));
  }

  private commandKey(sessionId: string, commandId: string): string {
    return `${sessionId}:${commandId}`;
  }
}

class SnapshotNonceRepository implements NonceRepository {
  private rows = new Map<string, NonceSnapshotRow>();

  hasNonce(sessionId: string, side: "controller" | "runner", nonce: string): boolean {
    return this.rows.has(this.key(sessionId, side, nonce));
  }

  storeNonce(
    sessionId: string,
    side: "controller" | "runner",
    nonce: string,
    seenAt: string,
  ): void {
    this.rows.set(this.key(sessionId, side, nonce), { sessionId, side, nonce, seenAt });
  }

  snapshot(): NonceSnapshotRow[] {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }

  hydrate(rows: NonceSnapshotRow[] = []): void {
    this.rows.clear();
    for (const row of rows) {
      this.rows.set(this.key(row.sessionId, row.side, row.nonce), structuredClone(row));
    }
  }

  private key(sessionId: string, side: "controller" | "runner", nonce: string): string {
    return `${sessionId}:${side}:${nonce}`;
  }
}
