import { createHash, randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1 as const;

export const commandStates = [
  "accepted",
  "queued",
  "sent_to_runner",
  "runner_acknowledged",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
  "expired",
  "unknown",
] as const;

export type CommandState = (typeof commandStates)[number];

export const errorCodes = [
  "RUNNER_OFFLINE",
  "SESSION_EXPIRED",
  "UNAUTHORIZED",
  "FORBIDDEN_PATH",
  "COMMAND_TIMEOUT",
  "OUTPUT_TRUNCATED",
  "JOB_ALREADY_RUNNING",
  "JOB_NOT_FOUND",
  "CURSOR_EXPIRED",
  "RUNNER_RESTARTED",
  "COMMAND_STATE_UNKNOWN",
  "TOOL_DISABLED",
  "REPLAY_DETECTED",
  "RATE_LIMITED",
  "COMMAND_EXPIRED",
  "RUNNER_AUTH_REQUIRED",
  "INVALID_ARGUMENT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export type CommandType = "status" | "ping" | "gpu_status";

export interface BridgeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface CommandEnvelope<TPayload = unknown> {
  protocol_version: typeof PROTOCOL_VERSION;
  session_id: string;
  command_id: string;
  message_id: string;
  kind: "command";
  type: CommandType;
  sent_at: string;
  deadline_at: string;
  payload: TPayload;
}

export interface ResultEnvelope<TPayload = unknown> {
  protocol_version: typeof PROTOCOL_VERSION;
  session_id: string;
  command_id: string;
  message_id: string;
  reply_to: string;
  kind: "result";
  type: `${CommandType}_result`;
  sent_at: string;
  ok: boolean;
  payload: TPayload;
  error?: BridgeError;
}

export interface CommandRow {
  sessionId: string;
  commandId: string;
  type: CommandType;
  state: CommandState;
  requestPayload: unknown;
  requestPayloadHash: string;
  resultPayload: unknown | null;
  error: BridgeError | null;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  runnerInstanceId: string | null;
  stateHistory: CommandState[];
}

export interface GpuStatusPayload {
  available: boolean;
  source: "nvidia-smi" | "torch" | "fake" | "none";
  gpus: Array<{
    index: number;
    name: string;
    memory_total_mb: number | null;
    memory_used_mb: number | null;
    utilization_gpu_percent: number | null;
  }>;
  raw: string;
}

export function bridgeError(
  code: ErrorCode,
  message: string,
  retryable = false,
): BridgeError {
  return { code, message, retryable };
}

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function createCommandEnvelope<TPayload>(input: {
  sessionId: string;
  commandId: string;
  type: CommandType;
  payload: TPayload;
  deadlineAt: string;
  sentAt?: string;
}): CommandEnvelope<TPayload> {
  return {
    protocol_version: PROTOCOL_VERSION,
    session_id: input.sessionId,
    command_id: input.commandId,
    message_id: newId("msg"),
    kind: "command",
    type: input.type,
    sent_at: input.sentAt ?? nowIso(),
    deadline_at: input.deadlineAt,
    payload: input.payload,
  };
}

export function createResultEnvelope<TPayload>(input: {
  command: CommandEnvelope;
  ok: boolean;
  payload: TPayload;
  error?: BridgeError;
  sentAt?: string;
}): ResultEnvelope<TPayload> {
  return {
    protocol_version: PROTOCOL_VERSION,
    session_id: input.command.session_id,
    command_id: input.command.command_id,
    message_id: newId("msg"),
    reply_to: input.command.message_id,
    kind: "result",
    type: `${input.command.type}_result`,
    sent_at: input.sentAt ?? nowIso(),
    ok: input.ok,
    payload: input.payload,
    ...(input.error ? { error: input.error } : {}),
  };
}

export function isFinalCommandState(state: CommandState): boolean {
  return [
    "succeeded",
    "failed",
    "timed_out",
    "canceled",
    "expired",
    "unknown",
  ].includes(state);
}

export function assertCommandType(value: string): asserts value is CommandType {
  if (value !== "status" && value !== "ping" && value !== "gpu_status") {
    throw bridgeError("INVALID_ARGUMENT", `Unsupported command type: ${value}`);
  }
}
