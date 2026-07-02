import { AuthFailure, generateToken, hashToken, validateTimestamp, InMemoryNonceRepository, validateAuthenticatedRequest, verifyToken, } from "./auth.js";
import { bridgeError, createCommandEnvelope, isFinalCommandState, newId, payloadHash, } from "./protocol.js";
export class InMemoryBridgeRepository {
    sessions = new Map();
    commands = new Map();
    audits = [];
    insertSession(session) {
        this.sessions.set(session.sessionId, structuredClone(session));
    }
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        return session ? structuredClone(session) : undefined;
    }
    updateSession(session) {
        this.sessions.set(session.sessionId, structuredClone(session));
    }
    insertCommand(command) {
        this.commands.set(this.commandKey(command.sessionId, command.commandId), structuredClone(command));
    }
    getCommand(sessionId, commandId) {
        const command = this.commands.get(this.commandKey(sessionId, commandId));
        return command ? structuredClone(command) : undefined;
    }
    updateCommand(command) {
        this.commands.set(this.commandKey(command.sessionId, command.commandId), structuredClone(command));
    }
    insertAudit(row) {
        this.audits.push(structuredClone(row));
    }
    listAudit(sessionId) {
        return this.audits.filter((row) => row.sessionId === sessionId).map((row) => structuredClone(row));
    }
    commandKey(sessionId, commandId) {
        return `${sessionId}:${commandId}`;
    }
}
export class BrokerError extends Error {
    bridgeError;
    constructor(error) {
        super(error.message);
        this.bridgeError = error;
    }
}
export class SessionBroker {
    repository;
    nonceRepository;
    options;
    runners = new Map();
    constructor(repository = new InMemoryBridgeRepository(), nonceRepository = new InMemoryNonceRepository(), options = {}) {
        this.repository = repository;
        this.nonceRepository = nonceRepository;
        this.options = options;
    }
    createSession(now = new Date(), sessionId = newId("sess")) {
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
    getStatus(sessionId, auth, now = new Date()) {
        const session = this.requireController(sessionId, auth, now);
        return this.toStatus(session, now);
    }
    revoke(sessionId, auth, now = new Date()) {
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
    attachRunner(sessionId, auth, metadata, handler, now = new Date()) {
        const session = this.requireRunner(sessionId, auth, now);
        const attachEvent = session.runnerInstanceId === null
            ? "runner_attach"
            : session.runnerInstanceId === metadata.runnerInstanceId
                ? "runner_reconnect"
                : "runner_restart";
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
    runnerHeartbeat(sessionId, auth, now = new Date()) {
        const session = this.requireRunner(sessionId, auth, now);
        session.lastHeartbeatAt = now.toISOString();
        this.repository.updateSession(session);
    }
    recordRunnerActivity(sessionId, runnerInstanceId, now = new Date()) {
        const session = this.requireLiveSession(sessionId, now);
        if (runnerInstanceId && session.runnerInstanceId !== runnerInstanceId) {
            return;
        }
        session.runnerConnected = true;
        session.lastHeartbeatAt = now.toISOString();
        this.repository.updateSession(session);
    }
    restoreRunnerConnection(sessionId, metadata, handler, now = new Date()) {
        const session = this.requireLiveSession(sessionId, now);
        session.runnerConnected = true;
        session.runnerInstanceId = metadata.runnerInstanceId;
        session.kernelStartedAt = metadata.kernelStartedAt;
        session.runnerStartedAt = metadata.runnerStartedAt ?? session.runnerStartedAt ?? now.toISOString();
        session.lastHeartbeatAt = now.toISOString();
        this.repository.updateSession(session);
        this.runners.set(sessionId, handler);
    }
    markRunnerDisconnected(sessionId, runnerInstanceId, now = new Date()) {
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
    authenticateRunner(sessionId, auth, now = new Date()) {
        this.requireRunner(sessionId, auth, now);
    }
    preflightRunnerAuth(sessionId, auth, now = new Date()) {
        const session = this.requireLiveSession(sessionId, now);
        try {
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
        }
        catch (error) {
            this.auditAuthFailure(sessionId, "runner", now, error);
            throw this.toBrokerError(error);
        }
    }
    async createCommand(sessionId, auth, input, now = new Date()) {
        const session = this.requireController(sessionId, auth, now);
        const commandId = input.commandId ?? newId("cmd");
        const deadlineAt = new Date(now.getTime() + (input.deadlineMs ?? 30_000)).toISOString();
        const hash = payloadHash(input.payload ?? {});
        const existing = this.repository.getCommand(sessionId, commandId);
        if (existing) {
            if (existing.type !== input.type || existing.requestPayloadHash !== hash) {
                throw new BrokerError(bridgeError("INVALID_ARGUMENT", "Command id has already been used with a different type or payload."));
            }
            return existing;
        }
        const createdAt = now.toISOString();
        const command = {
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
        let result;
        try {
            result = await runner(envelope);
        }
        catch {
            const deliveredCommand = this.requireCommand(sessionId, commandId);
            this.failCommand(deliveredCommand, bridgeError("INTERNAL_ERROR", "Runner failed while executing the command."), now);
            return this.requireCommand(sessionId, commandId);
        }
        const deliveredCommand = this.requireCommand(sessionId, commandId);
        if (result.session_id !== sessionId ||
            result.command_id !== commandId ||
            result.reply_to !== envelope.message_id) {
            this.failCommand(deliveredCommand, bridgeError("INTERNAL_ERROR", "Runner returned a result envelope that does not match the command."), now, result.payload);
            return this.requireCommand(sessionId, commandId);
        }
        if (result.ok) {
            this.completeCommand(deliveredCommand, result.payload, now);
        }
        else {
            this.failCommand(deliveredCommand, result.error ?? bridgeError("INTERNAL_ERROR", "Runner returned a failed result without an error."), now, result.payload);
        }
        return this.requireCommand(sessionId, commandId);
    }
    acknowledgeCommand(sessionId, auth, commandId, now = new Date()) {
        this.requireRunner(sessionId, auth, now);
        const command = this.requireCommand(sessionId, commandId);
        if (!isFinalCommandState(command.state)) {
            this.transitionCommand(command, "runner_acknowledged", now);
        }
        return this.requireCommand(sessionId, commandId);
    }
    getCommandResult(sessionId, auth, commandId, now = new Date()) {
        this.requireController(sessionId, auth, now);
        return this.requireCommand(sessionId, commandId);
    }
    getAuditRows(sessionId) {
        return this.repository.listAudit(sessionId);
    }
    getStoredCommand(sessionId, commandId) {
        return this.repository.getCommand(sessionId, commandId);
    }
    completeCommand(command, resultPayload, now) {
        this.transitionCommand(command, "running", now);
        command.resultPayload = resultPayload;
        command.error = null;
        this.transitionCommand(command, "succeeded", now);
    }
    failCommand(command, error, now, resultPayload = null) {
        command.resultPayload = resultPayload;
        command.error = error;
        this.transitionCommand(command, "failed", now);
    }
    transitionCommand(command, nextState, now) {
        command.state = nextState;
        command.updatedAt = now.toISOString();
        command.stateHistory.push(nextState);
        this.repository.updateCommand(command);
    }
    requireController(sessionId, auth, now) {
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
        }
        catch (error) {
            this.auditAuthFailure(sessionId, "controller", now, error);
            throw this.toBrokerError(error);
        }
    }
    requireRunner(sessionId, auth, now) {
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
        }
        catch (error) {
            this.auditAuthFailure(sessionId, "runner", now, error);
            throw this.toBrokerError(error);
        }
    }
    requireLiveSession(sessionId, now) {
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
    requireCommand(sessionId, commandId) {
        const command = this.repository.getCommand(sessionId, commandId);
        if (!command) {
            throw new BrokerError(bridgeError("INVALID_ARGUMENT", "Unknown command."));
        }
        return command;
    }
    toStatus(session, now) {
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
    isRunnerFresh(session, now) {
        if (!session.runnerConnected || !session.lastHeartbeatAt) {
            return false;
        }
        const lastHeartbeat = Date.parse(session.lastHeartbeatAt);
        if (!Number.isFinite(lastHeartbeat)) {
            return false;
        }
        return now.getTime() - lastHeartbeat <= (this.options.runnerStaleMs ?? 45_000);
    }
    audit(row) {
        this.repository.insertAudit(row);
    }
    auditAuthFailure(sessionId, callerSide, now, error) {
        this.audit({
            sessionId,
            at: now.toISOString(),
            event: "auth_failure",
            callerSide,
            outcome: "rejected",
            errorCode: error instanceof AuthFailure ? error.bridgeError.code : "INTERNAL_ERROR",
        });
    }
    toBrokerError(error) {
        if (error instanceof BrokerError) {
            return error;
        }
        if (error instanceof AuthFailure) {
            return new BrokerError(error.bridgeError);
        }
        throw error;
    }
}
