import { BrokerError } from "./broker.js";
import { FakeRunner } from "./fake-runner.js";
import { bridgeError, assertCommandType, isDangerousCommandType, normalizeForegroundRunPayload, normalizeInterruptJobPayload, normalizeReadFilePayload, normalizeStartJobPayload, normalizeTailJobPayload, normalizeWriteFilePayload, } from "./protocol.js";
import { RunnerConnection } from "./runner-connection.js";
class HttpRouteError extends Error {
    status;
    bridgeError;
    constructor(status, bridgeError) {
        super(bridgeError.message);
        this.status = status;
        this.bridgeError = bridgeError;
    }
}
export function createBridgeHttpHandler(context) {
    return async (request) => {
        try {
            return await dispatchRequest(context, request);
        }
        catch (error) {
            if (error instanceof HttpRouteError) {
                return jsonError(error.status, error.bridgeError);
            }
            if (error instanceof BrokerError) {
                return jsonError(statusForBrokerError(error), error.bridgeError);
            }
            return jsonError(500, bridgeError("INTERNAL_ERROR", "Unexpected bridge route error.", false));
        }
    };
}
export function attachFakeRunnerForTest(input) {
    let counter = 0;
    const runner = new FakeRunner(input.broker, input.sessionId, () => ({
        token: input.runnerToken,
        timestamp: (input.now ?? new Date()).toISOString(),
        nonce: `fake_runner_http_${++counter}`,
    }), input.options);
    runner.attach(input.now);
    return runner;
}
async function dispatchRequest(context, request) {
    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);
    const now = context.now?.() ?? new Date();
    if (route.name === "health") {
        return jsonOk(200, { status: "ok" });
    }
    if (route.name === "createSession") {
        requireAdminAuth(request.headers, context.adminSecret);
        return jsonOk(201, serializeSession(context.broker.createSession(now)));
    }
    if (route.name === "status") {
        const data = context.broker.getStatus(route.sessionId, parseControllerAuth(request.headers), now);
        return jsonOk(200, data);
    }
    if (route.name === "createCommand") {
        const auth = parseControllerAuth(request.headers);
        const body = await parseJsonObject(request);
        const command = await context.broker.createCommand(route.sessionId, auth, parseCommandInput(body, { enableDangerousTools: context.enableDangerousTools === true }), now);
        return jsonOk(201, serializeCommand(command));
    }
    if (route.name === "getCommand") {
        const command = context.broker.getCommandResult(route.sessionId, parseControllerAuth(request.headers), route.commandId, now);
        return jsonOk(200, serializeCommand(command));
    }
    if (route.name === "revoke") {
        context.broker.revoke(route.sessionId, parseControllerAuth(request.headers), now);
        return jsonOk(200, { revoked: true });
    }
    if (route.name === "runnerAttach") {
        const auth = parseRunnerAuth(request.headers);
        context.broker.preflightRunnerAuth(route.sessionId, auth, now);
        const metadata = parseRunnerMetadata(request.headers);
        const transport = context.runnerTransportFactory?.({
            sessionId: route.sessionId,
            runnerInstanceId: metadata.runnerInstanceId,
        });
        if (!transport) {
            context.broker.authenticateRunner(route.sessionId, auth, now);
            return jsonError(426, bridgeError("RUNNER_AUTH_REQUIRED", "Runner WebSocket upgrade is required.", true));
        }
        new RunnerConnection({
            broker: context.broker,
            sessionId: route.sessionId,
            auth,
            metadata,
            transport,
            now,
        }).attach();
        return jsonOk(200, {
            runner_connected: true,
            runner_instance_id: metadata.runnerInstanceId,
        });
    }
    return jsonError(404, bridgeError("INVALID_ARGUMENT", "Unknown route.", false));
}
function matchRoute(method, pathname) {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (method === "GET" && pathname === "/health") {
        return { name: "health" };
    }
    if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "sessions") {
        return { name: "createSession" };
    }
    if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "sessions") {
        const sessionId = parts[2] ?? "";
        if (method === "GET" && parts.length === 4 && parts[3] === "status") {
            return { name: "status", sessionId };
        }
        if (method === "POST" && parts.length === 4 && parts[3] === "commands") {
            return { name: "createCommand", sessionId };
        }
        if (method === "GET" && parts.length === 5 && parts[3] === "commands") {
            return { name: "getCommand", sessionId, commandId: parts[4] ?? "" };
        }
        if (method === "POST" && parts.length === 4 && parts[3] === "revoke") {
            return { name: "revoke", sessionId };
        }
        if (method === "GET" && parts.length === 5 && parts[3] === "runner" && parts[4] === "ws") {
            return { name: "runnerAttach", sessionId };
        }
    }
    return { name: "unknown" };
}
function requireAdminAuth(headers, adminSecret) {
    const token = parseBearerToken(headers);
    if (!token || token !== adminSecret) {
        throw new HttpRouteError(401, bridgeError("UNAUTHORIZED", "Invalid admin credentials.", false));
    }
}
function parseControllerAuth(headers) {
    return parseSideAuth(headers);
}
function parseRunnerAuth(headers) {
    return parseSideAuth(headers);
}
function parseSideAuth(headers) {
    const token = parseBearerToken(headers);
    const timestamp = headers.get("x-bridge-timestamp");
    const nonce = headers.get("x-bridge-nonce");
    if (!token) {
        throw new HttpRouteError(401, bridgeError("UNAUTHORIZED", "Missing bearer authorization.", false));
    }
    if (!timestamp) {
        throw new HttpRouteError(401, bridgeError("UNAUTHORIZED", "Missing auth timestamp.", false));
    }
    if (!nonce) {
        throw new HttpRouteError(401, bridgeError("UNAUTHORIZED", "Missing auth nonce.", false));
    }
    return { token, timestamp, nonce };
}
function parseRunnerMetadata(headers) {
    const runnerInstanceId = headers.get("x-bridge-runner-instance-id")?.trim();
    const kernelStartedAt = headers.get("x-bridge-kernel-started-at")?.trim();
    const runnerStartedAt = headers.get("x-bridge-runner-started-at")?.trim();
    if (!runnerInstanceId) {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "Missing runner instance id.", false));
    }
    if (!kernelStartedAt || !Number.isFinite(Date.parse(kernelStartedAt))) {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "Missing or invalid kernel start time.", false));
    }
    if (runnerStartedAt && !Number.isFinite(Date.parse(runnerStartedAt))) {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "Invalid runner start time.", false));
    }
    return {
        runnerInstanceId,
        kernelStartedAt,
        ...(runnerStartedAt ? { runnerStartedAt } : {}),
    };
}
function parseBearerToken(headers) {
    const authorization = headers.get("authorization");
    if (!authorization) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match?.[1]?.trim() || null;
}
async function parseJsonObject(request) {
    let parsed;
    try {
        parsed = await request.json();
    }
    catch {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "Request body must be valid JSON.", false));
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "Request body must be a JSON object.", false));
    }
    return parsed;
}
function parseCommandInput(body, options) {
    const { type, payload, deadline_ms: deadlineMs, command_id: commandId } = body;
    if (typeof type !== "string") {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "Unsupported command type.", false));
    }
    if (isDangerousCommandType(type) && !options.enableDangerousTools) {
        throw new HttpRouteError(403, bridgeError("TOOL_DISABLED", `${type} is disabled by local bridge policy.`, false));
    }
    try {
        assertCommandType(type);
    }
    catch {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "Unsupported command type.", false));
    }
    if (deadlineMs !== undefined &&
        (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "deadline_ms must be a positive number.", false));
    }
    if (commandId !== undefined && typeof commandId !== "string") {
        throw new HttpRouteError(400, bridgeError("INVALID_ARGUMENT", "command_id must be a string.", false));
    }
    let normalizedPayload = payload;
    let normalizedDeadlineMs = deadlineMs;
    if (type === "run_shell" || type === "run_python") {
        let foregroundPayload;
        try {
            foregroundPayload = normalizeForegroundRunPayload(type, payload ?? {});
        }
        catch (error) {
            if (isBridgeErrorLike(error)) {
                throw new HttpRouteError(400, error);
            }
            throw error;
        }
        normalizedPayload = foregroundPayload;
        normalizedDeadlineMs ??= Math.ceil(foregroundPayload.timeout_sec * 1000);
    }
    if (type === "write_file") {
        let filePayload;
        try {
            filePayload = normalizeWriteFilePayload(payload ?? {});
        }
        catch (error) {
            if (isBridgeErrorLike(error)) {
                throw new HttpRouteError(400, error);
            }
            throw error;
        }
        normalizedPayload = filePayload;
    }
    if (type === "read_file") {
        let filePayload;
        try {
            filePayload = normalizeReadFilePayload(payload ?? {});
        }
        catch (error) {
            if (isBridgeErrorLike(error)) {
                throw new HttpRouteError(400, error);
            }
            throw error;
        }
        normalizedPayload = filePayload;
    }
    if (type === "start_job") {
        let jobPayload;
        try {
            jobPayload = normalizeStartJobPayload(payload ?? {});
        }
        catch (error) {
            if (isBridgeErrorLike(error)) {
                throw new HttpRouteError(400, error);
            }
            throw error;
        }
        normalizedPayload = jobPayload;
    }
    if (type === "tail_job") {
        let jobPayload;
        try {
            jobPayload = normalizeTailJobPayload(payload ?? {});
        }
        catch (error) {
            if (isBridgeErrorLike(error)) {
                throw new HttpRouteError(400, error);
            }
            throw error;
        }
        normalizedPayload = jobPayload;
    }
    if (type === "interrupt_job") {
        let jobPayload;
        try {
            jobPayload = normalizeInterruptJobPayload(payload ?? {});
        }
        catch (error) {
            if (isBridgeErrorLike(error)) {
                throw new HttpRouteError(400, error);
            }
            throw error;
        }
        normalizedPayload = jobPayload;
    }
    return {
        type,
        payload: normalizedPayload,
        deadlineMs: normalizedDeadlineMs,
        commandId,
    };
}
function isBridgeErrorLike(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (typeof record.code === "string" &&
        typeof record.message === "string" &&
        typeof record.retryable === "boolean");
}
function serializeSession(session) {
    return {
        session_id: session.sessionId,
        controller_token: session.controllerToken,
        runner_token: session.runnerToken,
        expires_at: session.expiresAt,
    };
}
function serializeCommand(command) {
    return {
        session_id: command.sessionId,
        command_id: command.commandId,
        type: command.type,
        state: command.state,
        result_payload: command.resultPayload,
        error: command.error,
        deadline_at: command.deadlineAt,
        created_at: command.createdAt,
        updated_at: command.updatedAt,
        runner_instance_id: command.runnerInstanceId,
        state_history: command.stateHistory,
    };
}
function statusForBrokerError(error) {
    if (error.bridgeError.code === "UNAUTHORIZED" ||
        error.bridgeError.code === "REPLAY_DETECTED" ||
        error.bridgeError.code === "SESSION_EXPIRED") {
        if (error.bridgeError.message.toLowerCase().includes("revoked")) {
            return 409;
        }
        return 401;
    }
    if (error.bridgeError.code === "INVALID_ARGUMENT" &&
        error.bridgeError.message.toLowerCase().includes("unknown command")) {
        return 404;
    }
    if (error.bridgeError.code === "INVALID_ARGUMENT" &&
        error.bridgeError.message.toLowerCase().includes("already been used")) {
        return 409;
    }
    if (error.bridgeError.code === "INVALID_ARGUMENT") {
        return 400;
    }
    if (error.bridgeError.code === "INTERNAL_ERROR") {
        return 500;
    }
    return 400;
}
function jsonOk(status, data) {
    return json(status, { ok: true, data, error: null });
}
function jsonError(status, error) {
    return json(status, { ok: false, data: null, error });
}
function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
        },
    });
}
