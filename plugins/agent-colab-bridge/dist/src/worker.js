import { DEFAULT_AUTH_SKEW_MS } from "./auth.js";
import { BrokerError, RunnerResultUnavailableError, SessionBroker, } from "./broker.js";
import { createBridgeHttpHandler } from "./http.js";
import { bridgeError, newId, } from "./protocol.js";
const persistedStateKey = "colab_mcp_bridge_state_v1";
const rowStoragePrefix = "colab_mcp_bridge_row_v1";
const rowStorageIndexKey = `${rowStoragePrefix}:index`;
const maxAuditRowsPerSession = 200;
const maxNoncesPerSessionSide = 1_000;
const nonceRetentionMs = 10 * 60 * 1000;
const protectedNonceReplayWindowMs = DEFAULT_AUTH_SKEW_MS;
const internalSessionIdHeader = "x-colab-bridge-session-id";
const fallbackBrokers = new WeakMap();
const fallbackBrokerKey = {};
export default {
    fetch(request, env = {}, _context) {
        return createWorkerFetchHandler(env)(request);
    },
};
export function createWorkerFetchHandler(env = {}, options = {}) {
    return async (request) => {
        if (isHealthRequest(request)) {
            return createBridgeHttpHandler({
                broker: options.broker ?? getFallbackBroker(env),
                adminSecret: readAdminSecret(env) ?? "",
                enableDangerousTools: resolveDangerousToolsEnabled(env, options),
            })(request);
        }
        const adminSecret = readAdminSecret(env);
        if (!adminSecret) {
            return workerJsonError(500, bridgeError("INTERNAL_ERROR", "Worker ADMIN_SECRET is not configured.", false));
        }
        if (!options.broker) {
            if (!env.COLAB_BRIDGE_SESSIONS) {
                return workerJsonError(500, bridgeError("INTERNAL_ERROR", "Worker COLAB_BRIDGE_SESSIONS Durable Object binding is not configured.", false));
            }
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
export function getWorkerBrokerForTest(env = {}) {
    return getFallbackBroker(env);
}
export class ColabBridgeSessionDurableObject {
    state;
    env;
    repository = new RowBackedBridgeRepository();
    nonceRepository = new RowBackedNonceRepository();
    broker = new SessionBroker(this.repository, this.nonceRepository);
    pendingRunnerResults = new Map();
    runnerSocket = null;
    runnerAttachment = null;
    loaded = false;
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }
    async fetch(request) {
        if (isHealthRequest(request)) {
            return createBridgeHttpHandler({
                broker: this.broker,
                adminSecret: readAdminSecret(this.env) ?? "",
                enableDangerousTools: resolveDangerousToolsEnabled(this.env),
            })(request);
        }
        const adminSecret = readAdminSecret(this.env);
        if (!adminSecret) {
            return workerJsonError(500, bridgeError("INTERNAL_ERROR", "Worker ADMIN_SECRET is not configured.", false));
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
            }
            catch (error) {
                if (error instanceof WorkerRouteError) {
                    return workerJsonError(error.status, error.bridgeError);
                }
                if (error instanceof BrokerError) {
                    return workerJsonError(statusForWorkerBrokerError(error), error.bridgeError);
                }
                return workerJsonError(500, bridgeError("INTERNAL_ERROR", "Runner WebSocket attach failed.", false));
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
    async createSessionWithId(request, adminSecret, sessionId) {
        const authorization = request.headers.get("authorization");
        const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
        if (!token || token !== adminSecret) {
            return workerJsonError(401, bridgeError("UNAUTHORIZED", "Invalid admin credentials.", false));
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
    async loadPersistedState() {
        if (this.loaded) {
            return;
        }
        const loadedRows = await this.loadRowBackedState();
        if (!loadedRows) {
            const snapshot = await this.state.storage.get(persistedStateKey);
            if (snapshot) {
                this.repository.hydrateLegacySnapshot(snapshot);
                this.nonceRepository.hydrateLegacySnapshot(snapshot.nonces);
            }
        }
        this.loaded = true;
    }
    async loadRowBackedState() {
        const index = await this.state.storage.get(rowStorageIndexKey);
        if (!index || !hasIndexedRows(index)) {
            return false;
        }
        const [sessions, commands, jobs, audits, nonces] = await Promise.all([
            this.loadIndexedRows(index.sessions),
            this.loadIndexedRows(index.commands),
            this.loadIndexedRows(index.jobs ?? []),
            this.loadIndexedRows(index.audits),
            this.loadIndexedRows(index.nonces),
        ]);
        this.repository.hydrateRows({
            sessions: sessions.map((entry) => entry.row),
            commands: commands.map((entry) => entry.row),
            jobs: jobs.map((entry) => entry.row),
            audits,
        });
        this.nonceRepository.hydrateRows(nonces.map((entry) => entry.row));
        return true;
    }
    async loadIndexedRows(keys = []) {
        const entries = await Promise.all(keys.map(async (storageKey) => ({
            storageKey,
            row: await this.state.storage.get(storageKey),
        })));
        return entries.flatMap((entry) => entry.row === undefined ? [] : [{ storageKey: entry.storageKey, row: entry.row }]);
    }
    async persistState() {
        const bridgeChanges = this.repository.drainChanges();
        const nonceChanges = this.nonceRepository.drainChanges();
        const putRows = [...bridgeChanges.putRows, ...nonceChanges.putRows];
        const deleteRows = [...bridgeChanges.deleteKeys, ...nonceChanges.deleteKeys];
        await Promise.all(putRows.map(([key, value]) => this.state.storage.put(key, value)));
        if (deleteRows.length > 0 && this.state.storage.delete) {
            await this.state.storage.delete(deleteRows);
        }
        await this.state.storage.put(rowStorageIndexKey, {
            ...this.repository.indexKeys(),
            nonces: this.nonceRepository.indexKeys(),
        });
    }
    async webSocketMessage(socket, message) {
        await this.loadPersistedState();
        this.restoreAcceptedRunnerSocket();
        const attachment = readRunnerSocketAttachment(socket);
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
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
        if (isAckEnvelopeLike(parsed)) {
            if (attachment) {
                if (parsed.session_id !== attachment.sessionId) {
                    socket.close(1008, "Runner ACK session mismatch.");
                    return;
                }
                this.broker.acknowledgeCommandFromRunner(attachment.sessionId, attachment.runnerInstanceId, parsed.command_id, parsed.reply_to);
                this.broker.recordRunnerActivity(attachment.sessionId, attachment.runnerInstanceId);
                await this.persistState();
            }
            return;
        }
        if (!isResultEnvelopeLike(parsed)) {
            socket.close(1003, "Unsupported runner message.");
            return;
        }
        if (attachment && parsed.session_id !== attachment.sessionId) {
            socket.close(1008, "Runner result session mismatch.");
            return;
        }
        const applied = attachment
            ? this.broker.applyRunnerResult(parsed, {
                runnerInstanceId: attachment.runnerInstanceId,
                replyTo: parsed.reply_to,
            })
            : null;
        if (attachment) {
            this.broker.recordRunnerActivity(attachment.sessionId, attachment.runnerInstanceId);
            await this.persistState();
        }
        const key = pendingResultKey(parsed.command_id, parsed.reply_to);
        const pending = this.pendingRunnerResults.get(key);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRunnerResults.delete(key);
            if (applied || !attachment) {
                pending.resolve(parsed);
            }
            else {
                pending.reject(new RunnerResultUnavailableError("Runner returned a result envelope that does not match the command."));
            }
        }
    }
    async webSocketClose(socket) {
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
    async webSocketError(socket) {
        await this.webSocketClose(socket);
    }
    acceptRunnerWebSocket(request, sessionId) {
        if (!isWebSocketUpgrade(request)) {
            return workerJsonError(426, bridgeError("RUNNER_AUTH_REQUIRED", "Runner WebSocket upgrade is required.", true));
        }
        const pair = createWebSocketPair();
        if (!pair) {
            return workerJsonError(500, bridgeError("INTERNAL_ERROR", "WebSocketPair is not available in this runtime.", false));
        }
        const auth = parseRunnerAuthForWorker(request.headers);
        const metadata = parseRunnerMetadataForWorker(request.headers);
        this.broker.preflightRunnerAuth(sessionId, auth);
        const attachment = {
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
        this.broker.attachRunner(sessionId, auth, metadata, (envelope) => this.sendCommandToRunnerSocket(pair[1], envelope));
        return createWebSocketUpgradeResponse(pair[0]);
    }
    acceptServerSocket(socket) {
        if (this.state.acceptWebSocket) {
            this.state.acceptWebSocket(socket);
            return;
        }
        socket.accept?.();
    }
    restoreAcceptedRunnerSocket() {
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
            this.broker.restoreRunnerConnection(attachment.sessionId, {
                runnerInstanceId: attachment.runnerInstanceId,
                kernelStartedAt: attachment.kernelStartedAt,
                runnerStartedAt: attachment.runnerStartedAt,
            }, (envelope) => this.sendCommandToRunnerSocket(socket, envelope));
            return;
        }
    }
    async sendCommandToRunnerSocket(socket, envelope) {
        await this.persistState();
        const timeoutMs = Math.max(1_000, Date.parse(envelope.deadline_at) - Date.now() + 1_000);
        return new Promise((resolve, reject) => {
            const key = pendingResultKey(envelope.command_id, envelope.message_id);
            const timeout = setTimeout(() => {
                this.pendingRunnerResults.delete(key);
                reject(new RunnerResultUnavailableError("Runner did not return a result before the command deadline; command state is unknown."));
            }, timeoutMs);
            this.pendingRunnerResults.set(key, { socket, timeout, resolve, reject });
            try {
                socket.send(JSON.stringify(envelope));
            }
            catch (error) {
                clearTimeout(timeout);
                this.pendingRunnerResults.delete(key);
                reject(new RunnerResultUnavailableError(error instanceof Error
                    ? error.message
                    : "Runner WebSocket send failed before a result was received."));
            }
        });
    }
    rejectPendingForSocket(socket, error) {
        for (const [key, pending] of this.pendingRunnerResults) {
            if (pending.socket !== socket) {
                continue;
            }
            clearTimeout(pending.timeout);
            this.pendingRunnerResults.delete(key);
            pending.reject(new RunnerResultUnavailableError(error.message));
        }
    }
}
function getFallbackBroker(env) {
    const key = objectKey(env);
    const existing = fallbackBrokers.get(key);
    if (existing) {
        return existing;
    }
    const broker = new SessionBroker();
    fallbackBrokers.set(key, broker);
    return broker;
}
function objectKey(env) {
    return env && typeof env === "object" ? env : fallbackBrokerKey;
}
function readAdminSecret(env) {
    return typeof env.ADMIN_SECRET === "string" && env.ADMIN_SECRET.length > 0
        ? env.ADMIN_SECRET
        : null;
}
function resolveDangerousToolsEnabled(env, options = {}) {
    if (options.enableDangerousTools !== undefined) {
        return options.enableDangerousTools;
    }
    return env.COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS === "1";
}
function routeDurableObjectRequest(request, namespace) {
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
function matchRunnerWebSocketRoute(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "GET" &&
        parts.length === 5 &&
        parts[0] === "v1" &&
        parts[1] === "sessions" &&
        parts[2] &&
        parts[3] === "runner" &&
        parts[4] === "ws") {
        return { sessionId: parts[2] };
    }
    return null;
}
function isWebSocketUpgrade(request) {
    return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}
function createWebSocketPair() {
    if (typeof WebSocketPair === "undefined") {
        return null;
    }
    return new WebSocketPair();
}
function createWebSocketUpgradeResponse(clientSocket) {
    try {
        return new Response(null, {
            status: 101,
            webSocket: clientSocket,
        });
    }
    catch {
        return new Response(null, {
            status: 200,
            headers: { "x-colab-bridge-test-websocket": "accepted" },
        });
    }
}
function parseRunnerAuthForWorker(headers) {
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
function parseRunnerMetadataForWorker(headers) {
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
function parseBearerTokenForWorker(headers) {
    const authorization = headers.get("authorization");
    if (!authorization) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match?.[1]?.trim() || null;
}
class WorkerRouteError extends Error {
    status;
    bridgeError;
    constructor(status, bridgeError) {
        super(bridgeError.message);
        this.status = status;
        this.bridgeError = bridgeError;
    }
}
function readRunnerSocketAttachment(socket) {
    const attachment = socket.deserializeAttachment?.();
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return null;
    }
    const record = attachment;
    if (record.side === "runner" &&
        typeof record.sessionId === "string" &&
        typeof record.runnerInstanceId === "string" &&
        typeof record.kernelStartedAt === "string") {
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
function isRunnerHeartbeat(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return record.kind === "heartbeat";
}
function isResultEnvelopeLike(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (record.kind === "result" &&
        typeof record.session_id === "string" &&
        typeof record.command_id === "string" &&
        typeof record.reply_to === "string" &&
        typeof record.message_id === "string" &&
        typeof record.type === "string" &&
        typeof record.ok === "boolean" &&
        "payload" in record);
}
function isAckEnvelopeLike(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (record.kind === "ack" &&
        typeof record.session_id === "string" &&
        typeof record.command_id === "string" &&
        typeof record.reply_to === "string" &&
        typeof record.message_id === "string" &&
        typeof record.type === "string");
}
function pendingResultKey(commandId, replyTo) {
    return `${commandId}:${replyTo}`;
}
function isSessionCreateRequest(request) {
    const url = new URL(request.url);
    return request.method === "POST" && url.pathname === "/v1/sessions";
}
function isHealthRequest(request) {
    const url = new URL(request.url);
    return request.method === "GET" && url.pathname === "/health";
}
function workerJsonOk(status, data) {
    return new Response(JSON.stringify({ ok: true, data, error: null }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}
function workerJsonError(status, error) {
    return new Response(JSON.stringify({ ok: false, data: null, error }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}
function statusForWorkerBrokerError(error) {
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
class RowBackedBridgeRepository {
    sessions = new Map();
    commands = new Map();
    jobs = new Map();
    audits = [];
    dirtyRows = new Map();
    deletedKeys = new Set();
    auditSequence = 0;
    insertSession(session) {
        this.setSession(session, true);
    }
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        return session ? structuredClone(session) : undefined;
    }
    updateSession(session) {
        this.setSession(session, true);
    }
    insertCommand(command) {
        this.setCommand(command, true);
    }
    getCommand(sessionId, commandId) {
        const command = this.commands.get(this.commandKey(sessionId, commandId));
        return command ? structuredClone(command) : undefined;
    }
    updateCommand(command) {
        this.setCommand(command, true);
    }
    upsertJob(job) {
        this.setJob(job, true);
    }
    getJob(sessionId, jobId) {
        const job = this.jobs.get(this.jobKey(sessionId, jobId));
        return job ? structuredClone(job) : undefined;
    }
    listJobs(sessionId) {
        return [...this.jobs.values()]
            .filter((job) => job.sessionId === sessionId)
            .map((job) => structuredClone(job));
    }
    insertAudit(row) {
        const stored = {
            storageKey: auditRowStorageKey(row.sessionId, row.at, this.auditSequence++),
            row: structuredClone(row),
        };
        this.audits.push(stored);
        this.markDirty(stored.storageKey, stored.row);
        this.compactAuditRows(row.sessionId);
    }
    listAudit(sessionId) {
        return this.audits
            .filter((entry) => entry.row.sessionId === sessionId)
            .map((entry) => structuredClone(entry.row));
    }
    hydrateRows(input) {
        this.sessions.clear();
        this.commands.clear();
        this.jobs.clear();
        this.audits = [];
        this.dirtyRows.clear();
        this.deletedKeys.clear();
        this.auditSequence = 0;
        for (const session of input.sessions) {
            this.setSession(session, false);
        }
        for (const command of input.commands) {
            this.setCommand(command, false);
        }
        for (const job of input.jobs ?? []) {
            this.setJob(job, false);
        }
        for (const audit of input.audits) {
            this.audits.push({
                storageKey: audit.storageKey,
                row: structuredClone(audit.row),
            });
            this.auditSequence++;
        }
    }
    hydrateLegacySnapshot(snapshot) {
        this.sessions.clear();
        this.commands.clear();
        this.jobs.clear();
        this.audits = [];
        this.dirtyRows.clear();
        this.deletedKeys.clear();
        this.auditSequence = 0;
        for (const session of snapshot.sessions ?? []) {
            this.setSession(session, true);
        }
        for (const command of snapshot.commands ?? []) {
            this.setCommand(command, true);
        }
        for (const job of snapshot.jobs ?? []) {
            this.setJob(job, true);
        }
        for (const audit of snapshot.audits ?? []) {
            const stored = {
                storageKey: auditRowStorageKey(audit.sessionId, audit.at, this.auditSequence++),
                row: structuredClone(audit),
            };
            this.audits.push(stored);
            this.markDirty(stored.storageKey, stored.row);
            this.compactAuditRows(audit.sessionId);
        }
    }
    indexKeys() {
        return {
            sessions: [...this.sessions.keys()].map((sessionId) => sessionRowStorageKey(sessionId)),
            commands: [...this.commands.values()].map((command) => commandRowStorageKey(command.sessionId, command.commandId)),
            jobs: [...this.jobs.values()].map((job) => jobRowStorageKey(job.sessionId, job.jobId)),
            audits: this.audits.map((entry) => entry.storageKey),
        };
    }
    drainChanges() {
        const changes = {
            putRows: [...this.dirtyRows.entries()],
            deleteKeys: [...this.deletedKeys],
        };
        this.dirtyRows.clear();
        this.deletedKeys.clear();
        return changes;
    }
    setSession(session, dirty) {
        const row = structuredClone(session);
        this.sessions.set(row.sessionId, row);
        if (dirty) {
            this.markDirty(sessionRowStorageKey(row.sessionId), row);
        }
    }
    setCommand(command, dirty) {
        const row = structuredClone(command);
        row.runnerMessageId ??= null;
        this.commands.set(this.commandKey(row.sessionId, row.commandId), row);
        if (dirty) {
            this.markDirty(commandRowStorageKey(row.sessionId, row.commandId), row);
        }
    }
    setJob(job, dirty) {
        const row = structuredClone(job);
        this.jobs.set(this.jobKey(row.sessionId, row.jobId), row);
        if (dirty) {
            this.markDirty(jobRowStorageKey(row.sessionId, row.jobId), row);
        }
    }
    markDirty(storageKey, row) {
        this.deletedKeys.delete(storageKey);
        this.dirtyRows.set(storageKey, structuredClone(row));
    }
    compactAuditRows(sessionId) {
        const sessionRows = this.audits.filter((entry) => entry.row.sessionId === sessionId);
        if (sessionRows.length <= maxAuditRowsPerSession) {
            return;
        }
        const deleteCount = sessionRows.length - maxAuditRowsPerSession;
        const deleteKeys = new Set(sessionRows.slice(0, deleteCount).map((entry) => entry.storageKey));
        this.audits = this.audits.filter((entry) => {
            if (!deleteKeys.has(entry.storageKey)) {
                return true;
            }
            this.dirtyRows.delete(entry.storageKey);
            this.deletedKeys.add(entry.storageKey);
            return false;
        });
    }
    commandKey(sessionId, commandId) {
        return `${sessionId}:${commandId}`;
    }
    jobKey(sessionId, jobId) {
        return `${sessionId}:${jobId}`;
    }
}
class RowBackedNonceRepository {
    rows = new Map();
    dirtyRows = new Map();
    deletedKeys = new Set();
    hasNonce(sessionId, side, nonce) {
        return this.rows.has(this.key(sessionId, side, nonce));
    }
    storeNonce(sessionId, side, nonce, seenAt) {
        const row = { sessionId, side, nonce, seenAt };
        this.setNonce(row, true);
        this.compactNonceRows(sessionId, side, seenAt);
    }
    hydrateRows(rows = []) {
        this.rows.clear();
        this.dirtyRows.clear();
        this.deletedKeys.clear();
        for (const row of rows) {
            this.setNonce(row, false);
        }
    }
    hydrateLegacySnapshot(rows = []) {
        this.rows.clear();
        this.dirtyRows.clear();
        this.deletedKeys.clear();
        for (const row of rows) {
            this.setNonce(row, true);
            this.compactNonceRows(row.sessionId, row.side, row.seenAt);
        }
    }
    indexKeys() {
        return [...this.rows.values()].map((row) => nonceRowStorageKey(row.sessionId, row.side, row.nonce));
    }
    drainChanges() {
        const changes = {
            putRows: [...this.dirtyRows.entries()],
            deleteKeys: [...this.deletedKeys],
        };
        this.dirtyRows.clear();
        this.deletedKeys.clear();
        return changes;
    }
    setNonce(row, dirty) {
        const cloned = structuredClone(row);
        this.rows.set(this.key(cloned.sessionId, cloned.side, cloned.nonce), cloned);
        if (dirty) {
            const storageKey = nonceRowStorageKey(cloned.sessionId, cloned.side, cloned.nonce);
            this.deletedKeys.delete(storageKey);
            this.dirtyRows.set(storageKey, cloned);
        }
    }
    compactNonceRows(sessionId, side, referenceSeenAt) {
        const referenceTime = Date.parse(referenceSeenAt);
        const rows = [...this.rows.values()]
            .filter((row) => row.sessionId === sessionId && row.side === side)
            .sort((left, right) => Date.parse(left.seenAt) - Date.parse(right.seenAt));
        const deleteKeys = new Set();
        if (Number.isFinite(referenceTime)) {
            const cutoff = referenceTime - nonceRetentionMs;
            for (const row of rows) {
                const seenAt = Date.parse(row.seenAt);
                if (Number.isFinite(seenAt) && seenAt < cutoff) {
                    deleteKeys.add(this.key(row.sessionId, row.side, row.nonce));
                }
            }
        }
        const remainingRows = rows.filter((row) => !deleteKeys.has(this.key(row.sessionId, row.side, row.nonce)));
        const capOverflow = Math.max(0, remainingRows.length - maxNoncesPerSessionSide);
        if (capOverflow > 0 && Number.isFinite(referenceTime)) {
            const cutoff = referenceTime - protectedNonceReplayWindowMs;
            const oldEnoughRows = remainingRows.filter((row) => {
                const seenAt = Date.parse(row.seenAt);
                return Number.isFinite(seenAt) && seenAt < cutoff;
            });
            for (const row of oldEnoughRows.slice(0, capOverflow)) {
                deleteKeys.add(this.key(row.sessionId, row.side, row.nonce));
            }
        }
        for (const key of deleteKeys) {
            const row = this.rows.get(key);
            if (!row) {
                continue;
            }
            const storageKey = nonceRowStorageKey(row.sessionId, row.side, row.nonce);
            this.rows.delete(key);
            this.dirtyRows.delete(storageKey);
            this.deletedKeys.add(storageKey);
        }
    }
    key(sessionId, side, nonce) {
        return `${sessionId}:${side}:${nonce}`;
    }
}
function hasIndexedRows(index) {
    return (index.sessions.length > 0 ||
        index.commands.length > 0 ||
        (index.jobs?.length ?? 0) > 0 ||
        index.audits.length > 0 ||
        index.nonces.length > 0);
}
function sessionRowStorageKey(sessionId) {
    return `${rowStoragePrefix}:session:${encodeStorageKeyPart(sessionId)}`;
}
function commandRowStorageKey(sessionId, commandId) {
    return `${rowStoragePrefix}:command:${encodeStorageKeyPart(sessionId)}:${encodeStorageKeyPart(commandId)}`;
}
function jobRowStorageKey(sessionId, jobId) {
    return `${rowStoragePrefix}:job:${encodeStorageKeyPart(sessionId)}:${encodeStorageKeyPart(jobId)}`;
}
function auditRowStorageKey(sessionId, at, sequence) {
    return `${rowStoragePrefix}:audit:${encodeStorageKeyPart(sessionId)}:${encodeStorageKeyPart(at)}:${sequence}`;
}
function nonceRowStorageKey(sessionId, side, nonce) {
    return `${rowStoragePrefix}:nonce:${encodeStorageKeyPart(sessionId)}:${side}:${encodeStorageKeyPart(nonce)}`;
}
function encodeStorageKeyPart(value) {
    return encodeURIComponent(value);
}
