import { createHash, randomUUID } from "node:crypto";
export const PROTOCOL_VERSION = 1;
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
];
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
];
export const DEFAULT_FOREGROUND_TIMEOUT_SEC = 30;
export const MAX_FOREGROUND_TIMEOUT_SEC = 120;
export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024;
export const MAX_OUTPUT_BYTES = 20 * 1024;
export const DEFAULT_READ_FILE_MAX_BYTES = 20 * 1024;
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
export const MAX_READ_FILE_BYTES = 1024 * 1024;
export const DEFAULT_JOB_LOG_BYTES = 200 * 1024;
export const MAX_JOB_LOG_BYTES = 200 * 1024;
export const DEFAULT_TAIL_MAX_BYTES = 20 * 1024;
export const MAX_TAIL_BYTES = 200 * 1024;
export const DEFAULT_INTERRUPT_KILL_AFTER_SEC = 5;
export const MAX_INTERRUPT_KILL_AFTER_SEC = 30;
export function bridgeError(code, message, retryable = false) {
    return { code, message, retryable };
}
export function nowIso(now = new Date()) {
    return now.toISOString();
}
export function newId(prefix) {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
export function stableJson(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(",")}]`;
    }
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
        .join(",")}}`;
}
export function payloadHash(payload) {
    return createHash("sha256").update(stableJson(payload)).digest("hex");
}
export function createCommandEnvelope(input) {
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
export function createResultEnvelope(input) {
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
export function isFinalCommandState(state) {
    return [
        "succeeded",
        "failed",
        "timed_out",
        "canceled",
        "expired",
        "unknown",
    ].includes(state);
}
export function assertCommandType(value) {
    if (value !== "status" &&
        value !== "ping" &&
        value !== "gpu_status" &&
        value !== "run_shell" &&
        value !== "run_python" &&
        value !== "write_file" &&
        value !== "read_file" &&
        value !== "start_job" &&
        value !== "tail_job" &&
        value !== "interrupt_job") {
        throw bridgeError("INVALID_ARGUMENT", `Unsupported command type: ${value}`);
    }
}
export function isDangerousCommandType(value) {
    return (value === "run_shell" ||
        value === "run_python" ||
        value === "write_file" ||
        value === "start_job" ||
        value === "interrupt_job");
}
export function normalizeForegroundRunPayload(type, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw bridgeError("INVALID_ARGUMENT", "Foreground command payload must be an object.");
    }
    const record = payload;
    const source = type === "run_shell" ? record.command : record.code;
    const sourceName = type === "run_shell" ? "command" : "code";
    if (typeof source !== "string" || source.length === 0) {
        throw bridgeError("INVALID_ARGUMENT", `${sourceName} must be a non-empty string.`);
    }
    const timeoutSec = normalizePositiveNumber(record.timeout_sec, "timeout_sec", DEFAULT_FOREGROUND_TIMEOUT_SEC, MAX_FOREGROUND_TIMEOUT_SEC);
    const maxOutputBytes = normalizePositiveInteger(record.max_output_bytes, "max_output_bytes", DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
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
export function normalizeWriteFilePayload(payload) {
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
        throw bridgeError("INVALID_ARGUMENT", `content must be no larger than ${MAX_FILE_CONTENT_BYTES} bytes.`);
    }
    const mode = record.mode;
    if (mode !== "overwrite" && mode !== "append" && mode !== "create_new") {
        throw bridgeError("INVALID_ARGUMENT", "mode must be one of overwrite, append, or create_new.");
    }
    return { path, content, mode };
}
export function normalizeReadFilePayload(payload) {
    const record = normalizeObjectPayload(payload, "read_file payload");
    const path = record.path;
    if (typeof path !== "string" || path.length === 0) {
        throw bridgeError("INVALID_ARGUMENT", "path must be a non-empty string.");
    }
    const maxBytes = normalizePositiveInteger(record.max_bytes, "max_bytes", DEFAULT_READ_FILE_MAX_BYTES, MAX_READ_FILE_BYTES);
    return { path, max_bytes: maxBytes };
}
export function normalizeStartJobPayload(payload) {
    const record = normalizeObjectPayload(payload, "start_job payload");
    const command = record.command;
    if (typeof command !== "string" || command.length === 0) {
        throw bridgeError("INVALID_ARGUMENT", "command must be a non-empty string.");
    }
    const name = record.name;
    if (name !== undefined && typeof name !== "string") {
        throw bridgeError("INVALID_ARGUMENT", "name must be a string.");
    }
    const maxLogBytes = normalizePositiveInteger(record.max_log_bytes, "max_log_bytes", DEFAULT_JOB_LOG_BYTES, MAX_JOB_LOG_BYTES);
    return {
        command,
        ...(name !== undefined ? { name } : {}),
        max_log_bytes: maxLogBytes,
    };
}
export function normalizeTailJobPayload(payload) {
    const record = normalizeObjectPayload(payload, "tail_job payload");
    const jobId = record.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
        throw bridgeError("INVALID_ARGUMENT", "job_id must be a non-empty string.");
    }
    const cursor = normalizeNonNegativeInteger(record.cursor, "cursor", 0);
    const maxBytes = normalizePositiveInteger(record.max_bytes, "max_bytes", DEFAULT_TAIL_MAX_BYTES, MAX_TAIL_BYTES);
    return { job_id: jobId, cursor, max_bytes: maxBytes };
}
export function normalizeInterruptJobPayload(payload) {
    const record = normalizeObjectPayload(payload, "interrupt_job payload");
    const jobId = record.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
        throw bridgeError("INVALID_ARGUMENT", "job_id must be a non-empty string.");
    }
    const signal = record.signal ?? "SIGTERM";
    if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        throw bridgeError("INVALID_ARGUMENT", "signal must be SIGTERM or SIGKILL.");
    }
    const killAfterSec = normalizeNonNegativeNumber(record.kill_after_sec, "kill_after_sec", DEFAULT_INTERRUPT_KILL_AFTER_SEC, MAX_INTERRUPT_KILL_AFTER_SEC);
    return { job_id: jobId, signal, kill_after_sec: killAfterSec };
}
function normalizeObjectPayload(payload, name) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw bridgeError("INVALID_ARGUMENT", `${name} must be an object.`);
    }
    return payload;
}
function normalizePositiveNumber(value, name, defaultValue, maxValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maxValue) {
        throw bridgeError("INVALID_ARGUMENT", `${name} must be a positive number no greater than ${maxValue}.`);
    }
    return value;
}
function normalizeNonNegativeNumber(value, name, defaultValue, maxValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maxValue) {
        throw bridgeError("INVALID_ARGUMENT", `${name} must be a non-negative number no greater than ${maxValue}.`);
    }
    return value;
}
function normalizePositiveInteger(value, name, defaultValue, maxValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value !== "number" ||
        !Number.isInteger(value) ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > maxValue) {
        throw bridgeError("INVALID_ARGUMENT", `${name} must be a positive integer no greater than ${maxValue}.`);
    }
    return value;
}
function normalizeNonNegativeInteger(value, name, defaultValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value !== "number" ||
        !Number.isInteger(value) ||
        !Number.isFinite(value) ||
        value < 0) {
        throw bridgeError("INVALID_ARGUMENT", `${name} must be a non-negative integer.`);
    }
    return value;
}
