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

export type CommandType =
  | "status"
  | "ping"
  | "gpu_status"
  | "run_shell"
  | "run_python"
  | "write_file"
  | "read_file";

export const DEFAULT_FOREGROUND_TIMEOUT_SEC = 30;
export const MAX_FOREGROUND_TIMEOUT_SEC = 120;
export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024;
export const MAX_OUTPUT_BYTES = 20 * 1024;
export const DEFAULT_READ_FILE_MAX_BYTES = 20 * 1024;
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
export const MAX_READ_FILE_BYTES = 1024 * 1024;

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

export interface RunShellPayload {
  command: string;
  timeout_sec: number;
  max_output_bytes: number;
}

export interface RunPythonPayload {
  code: string;
  timeout_sec: number;
  max_output_bytes: number;
}

export type WriteFileMode = "overwrite" | "append" | "create_new";

export interface WriteFilePayload {
  path: string;
  content: string;
  mode: WriteFileMode;
}

export interface ReadFilePayload {
  path: string;
  max_bytes: number;
}

export interface ForegroundRunResultPayload {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
}

export interface WriteFileResultPayload {
  path: string;
  bytes_written: number;
  mode: WriteFileMode;
}

export interface ReadFileResultPayload {
  path: string;
  content: string;
  bytes_read: number;
  truncated: boolean;
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
  if (
    value !== "status" &&
    value !== "ping" &&
    value !== "gpu_status" &&
    value !== "run_shell" &&
    value !== "run_python" &&
    value !== "write_file" &&
    value !== "read_file"
  ) {
    throw bridgeError("INVALID_ARGUMENT", `Unsupported command type: ${value}`);
  }
}

export function isDangerousCommandType(
  value: string,
): value is "run_shell" | "run_python" | "write_file" {
  return value === "run_shell" || value === "run_python" || value === "write_file";
}

export function normalizeForegroundRunPayload(
  type: "run_shell" | "run_python",
  payload: unknown,
): RunShellPayload | RunPythonPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw bridgeError("INVALID_ARGUMENT", "Foreground command payload must be an object.");
  }

  const record = payload as Record<string, unknown>;
  const source = type === "run_shell" ? record.command : record.code;
  const sourceName = type === "run_shell" ? "command" : "code";
  if (typeof source !== "string" || source.length === 0) {
    throw bridgeError("INVALID_ARGUMENT", `${sourceName} must be a non-empty string.`);
  }

  const timeoutSec = normalizePositiveNumber(
    record.timeout_sec,
    "timeout_sec",
    DEFAULT_FOREGROUND_TIMEOUT_SEC,
    MAX_FOREGROUND_TIMEOUT_SEC,
  );
  const maxOutputBytes = normalizePositiveInteger(
    record.max_output_bytes,
    "max_output_bytes",
    DEFAULT_MAX_OUTPUT_BYTES,
    MAX_OUTPUT_BYTES,
  );

  if (type === "run_shell") {
    return {
      command: source,
      timeout_sec: timeoutSec,
      max_output_bytes: maxOutputBytes,
    };
  }

  return {
    code: source,
    timeout_sec: timeoutSec,
    max_output_bytes: maxOutputBytes,
  };
}

export function normalizeWriteFilePayload(payload: unknown): WriteFilePayload {
  const record = normalizeObjectPayload(payload, "write_file payload");
  const path = record.path;
  if (typeof path !== "string" || path.length === 0) {
    throw bridgeError("INVALID_ARGUMENT", "path must be a non-empty string.");
  }

  const content = record.content;
  if (typeof content !== "string") {
    throw bridgeError("INVALID_ARGUMENT", "content must be a string.");
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_CONTENT_BYTES) {
    throw bridgeError(
      "INVALID_ARGUMENT",
      `content must be no larger than ${MAX_FILE_CONTENT_BYTES} bytes.`,
    );
  }

  const mode = record.mode;
  if (mode !== "overwrite" && mode !== "append" && mode !== "create_new") {
    throw bridgeError(
      "INVALID_ARGUMENT",
      "mode must be one of overwrite, append, or create_new.",
    );
  }

  return { path, content, mode };
}

export function normalizeReadFilePayload(payload: unknown): ReadFilePayload {
  const record = normalizeObjectPayload(payload, "read_file payload");
  const path = record.path;
  if (typeof path !== "string" || path.length === 0) {
    throw bridgeError("INVALID_ARGUMENT", "path must be a non-empty string.");
  }

  const maxBytes = normalizePositiveInteger(
    record.max_bytes,
    "max_bytes",
    DEFAULT_READ_FILE_MAX_BYTES,
    MAX_READ_FILE_BYTES,
  );

  return { path, max_bytes: maxBytes };
}

function normalizeObjectPayload(payload: unknown, name: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw bridgeError("INVALID_ARGUMENT", `${name} must be an object.`);
  }

  return payload as Record<string, unknown>;
}

function normalizePositiveNumber(
  value: unknown,
  name: string,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maxValue) {
    throw bridgeError("INVALID_ARGUMENT", `${name} must be a positive number no greater than ${maxValue}.`);
  }

  return value;
}

function normalizePositiveInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maxValue
  ) {
    throw bridgeError("INVALID_ARGUMENT", `${name} must be a positive integer no greater than ${maxValue}.`);
  }

  return value;
}
