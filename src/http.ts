import { type AuthAttempt } from "./auth.js";
import { BrokerError, SessionBroker, type CreateSessionResult } from "./broker.js";
import { FakeRunner, type FakeRunnerOptions } from "./fake-runner.js";
import {
  bridgeError,
  type BridgeError,
  type CommandRow,
  type CommandType,
} from "./protocol.js";
import { RunnerConnection, type RunnerTransport } from "./runner-connection.js";

export interface BridgeHttpContext {
  broker: SessionBroker;
  adminSecret: string;
  now?: () => Date;
  runnerTransportFactory?: (input: {
    sessionId: string;
    runnerInstanceId: string;
  }) => RunnerTransport;
}

export type BridgeHttpHandler = (request: Request) => Promise<Response>;

interface JsonEnvelope<TData> {
  ok: boolean;
  data: TData | null;
  error: BridgeError | null;
}

class HttpRouteError extends Error {
  constructor(
    readonly status: number,
    readonly bridgeError: BridgeError,
  ) {
    super(bridgeError.message);
  }
}

export function createBridgeHttpHandler(context: BridgeHttpContext): BridgeHttpHandler {
  return async (request: Request): Promise<Response> => {
    try {
      return await dispatchRequest(context, request);
    } catch (error) {
      if (error instanceof HttpRouteError) {
        return jsonError(error.status, error.bridgeError);
      }

      if (error instanceof BrokerError) {
        return jsonError(statusForBrokerError(error), error.bridgeError);
      }

      return jsonError(
        500,
        bridgeError("INTERNAL_ERROR", "Unexpected bridge route error.", false),
      );
    }
  };
}

export function attachFakeRunnerForTest(input: {
  broker: SessionBroker;
  sessionId: string;
  runnerToken: string;
  options?: FakeRunnerOptions;
  now?: Date;
}): FakeRunner {
  let counter = 0;
  const runner = new FakeRunner(
    input.broker,
    input.sessionId,
    () => ({
      token: input.runnerToken,
      timestamp: (input.now ?? new Date()).toISOString(),
      nonce: `fake_runner_http_${++counter}`,
    }),
    input.options,
  );
  runner.attach(input.now);
  return runner;
}

async function dispatchRequest(
  context: BridgeHttpContext,
  request: Request,
): Promise<Response> {
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
    const data = context.broker.getStatus(
      route.sessionId,
      parseControllerAuth(request.headers),
      now,
    );
    return jsonOk(200, data);
  }

  if (route.name === "createCommand") {
    const auth = parseControllerAuth(request.headers);
    const body = await parseJsonObject(request);
    const command = await context.broker.createCommand(
      route.sessionId,
      auth,
      parseCommandInput(body),
      now,
    );
    return jsonOk(201, serializeCommand(command));
  }

  if (route.name === "getCommand") {
    const command = context.broker.getCommandResult(
      route.sessionId,
      parseControllerAuth(request.headers),
      route.commandId,
      now,
    );
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
      return jsonError(
        426,
        bridgeError("RUNNER_AUTH_REQUIRED", "Runner WebSocket upgrade is required.", true),
      );
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

type RouteMatch =
  | { name: "health" }
  | { name: "createSession" }
  | { name: "status"; sessionId: string }
  | { name: "createCommand"; sessionId: string }
  | { name: "getCommand"; sessionId: string; commandId: string }
  | { name: "revoke"; sessionId: string }
  | { name: "runnerAttach"; sessionId: string }
  | { name: "unknown" };

function matchRoute(method: string, pathname: string): RouteMatch {
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

function requireAdminAuth(headers: Headers, adminSecret: string): void {
  const token = parseBearerToken(headers);
  if (!token || token !== adminSecret) {
    throw new HttpRouteError(
      401,
      bridgeError("UNAUTHORIZED", "Invalid admin credentials.", false),
    );
  }
}

function parseControllerAuth(headers: Headers): AuthAttempt {
  return parseSideAuth(headers);
}

function parseRunnerAuth(headers: Headers): AuthAttempt {
  return parseSideAuth(headers);
}

function parseSideAuth(headers: Headers): AuthAttempt {
  const token = parseBearerToken(headers);
  const timestamp = headers.get("x-bridge-timestamp");
  const nonce = headers.get("x-bridge-nonce");

  if (!token) {
    throw new HttpRouteError(
      401,
      bridgeError("UNAUTHORIZED", "Missing bearer authorization.", false),
    );
  }

  if (!timestamp) {
    throw new HttpRouteError(
      401,
      bridgeError("UNAUTHORIZED", "Missing auth timestamp.", false),
    );
  }

  if (!nonce) {
    throw new HttpRouteError(
      401,
      bridgeError("UNAUTHORIZED", "Missing auth nonce.", false),
    );
  }

  return { token, timestamp, nonce };
}

function parseRunnerMetadata(headers: Headers): {
  runnerInstanceId: string;
  kernelStartedAt: string;
  runnerStartedAt?: string;
} {
  const runnerInstanceId = headers.get("x-bridge-runner-instance-id")?.trim();
  const kernelStartedAt = headers.get("x-bridge-kernel-started-at")?.trim();
  const runnerStartedAt = headers.get("x-bridge-runner-started-at")?.trim();

  if (!runnerInstanceId) {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "Missing runner instance id.", false),
    );
  }

  if (!kernelStartedAt || !Number.isFinite(Date.parse(kernelStartedAt))) {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "Missing or invalid kernel start time.", false),
    );
  }

  if (runnerStartedAt && !Number.isFinite(Date.parse(runnerStartedAt))) {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "Invalid runner start time.", false),
    );
  }

  return {
    runnerInstanceId,
    kernelStartedAt,
    ...(runnerStartedAt ? { runnerStartedAt } : {}),
  };
}

function parseBearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "Request body must be valid JSON.", false),
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "Request body must be a JSON object.", false),
    );
  }

  return parsed as Record<string, unknown>;
}

function parseCommandInput(body: Record<string, unknown>): {
  type: CommandType;
  payload?: unknown;
  deadlineMs?: number;
  commandId?: string;
} {
  const { type, payload, deadline_ms: deadlineMs, command_id: commandId } = body;
  if (type !== "status" && type !== "ping" && type !== "gpu_status") {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "Unsupported command type.", false),
    );
  }

  if (
    deadlineMs !== undefined &&
    (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs <= 0)
  ) {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "deadline_ms must be a positive number.", false),
    );
  }

  if (commandId !== undefined && typeof commandId !== "string") {
    throw new HttpRouteError(
      400,
      bridgeError("INVALID_ARGUMENT", "command_id must be a string.", false),
    );
  }

  return {
    type,
    payload,
    deadlineMs: deadlineMs as number | undefined,
    commandId,
  };
}

function serializeSession(session: CreateSessionResult): {
  session_id: string;
  controller_token: string;
  runner_token: string;
  expires_at: string;
} {
  return {
    session_id: session.sessionId,
    controller_token: session.controllerToken,
    runner_token: session.runnerToken,
    expires_at: session.expiresAt,
  };
}

function serializeCommand(command: CommandRow): {
  session_id: string;
  command_id: string;
  type: CommandType;
  state: string;
  result_payload: unknown | null;
  error: BridgeError | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  runner_instance_id: string | null;
  state_history: string[];
} {
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

function statusForBrokerError(error: BrokerError): number {
  if (
    error.bridgeError.code === "UNAUTHORIZED" ||
    error.bridgeError.code === "REPLAY_DETECTED" ||
    error.bridgeError.code === "SESSION_EXPIRED"
  ) {
    if (error.bridgeError.message.toLowerCase().includes("revoked")) {
      return 409;
    }
    return 401;
  }

  if (
    error.bridgeError.code === "INVALID_ARGUMENT" &&
    error.bridgeError.message.toLowerCase().includes("unknown command")
  ) {
    return 404;
  }

  if (
    error.bridgeError.code === "INVALID_ARGUMENT" &&
    error.bridgeError.message.toLowerCase().includes("already been used")
  ) {
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

function jsonOk<TData>(status: number, data: TData): Response {
  return json(status, { ok: true, data, error: null });
}

function jsonError(status: number, error: BridgeError): Response {
  return json(status, { ok: false, data: null, error });
}

function json<TData>(status: number, body: JsonEnvelope<TData>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
