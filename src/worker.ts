import { type NonceRepository } from "./auth.js";
import {
  type AuditRow,
  type BridgeRepository,
  type SessionRow,
  SessionBroker,
} from "./broker.js";
import { createBridgeHttpHandler, type BridgeHttpHandler } from "./http.js";
import { bridgeError, newId, type CommandRow } from "./protocol.js";

export interface BridgeWorkerEnv {
  ADMIN_SECRET?: string;
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
}

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

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
  options: { broker?: SessionBroker } = {},
): BridgeHttpHandler {
  return async (request: Request): Promise<Response> => {
    if (isHealthRequest(request)) {
      return createBridgeHttpHandler({
        broker: options.broker ?? getFallbackBroker(env),
        adminSecret: readAdminSecret(env) ?? "",
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
    const internalSessionId = request.headers.get(internalSessionIdHeader);
    if (isSessionCreateRequest(request) && internalSessionId) {
      return this.createSessionWithId(request, adminSecret, internalSessionId);
    }

    const response = await createBridgeHttpHandler({
      broker: this.broker,
      adminSecret,
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
