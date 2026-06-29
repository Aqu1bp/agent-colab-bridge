import { randomUUID } from "node:crypto";
import { bridgeError, } from "./protocol.js";
export class BridgeHttpClient {
    config;
    options;
    baseUrl;
    constructor(config, options = {}) {
        this.config = config;
        this.options = options;
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    }
    async getStatus() {
        return this.request("GET", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/status`);
    }
    async revokeSession() {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/revoke`);
    }
    async createPingCommand() {
        return this.createRunnerPingCommand();
    }
    async createRunnerPingCommand() {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "ping" });
    }
    async createGpuStatusCommand() {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "gpu_status" });
    }
    async createRunShellCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "run_shell", payload });
    }
    async createRunPythonCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "run_python", payload });
    }
    async createWriteFileCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "write_file", payload });
    }
    async createReadFileCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "read_file", payload });
    }
    async createStartJobCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "start_job", payload });
    }
    async createListJobsCommand() {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "list_jobs" });
    }
    async createJobStatusCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "job_status", payload });
    }
    async createTailJobCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "tail_job", payload });
    }
    async createInterruptJobCommand(payload) {
        return this.request("POST", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`, { type: "interrupt_job", payload });
    }
    async request(method, path, body) {
        const headers = new Headers({
            Authorization: `Bearer ${this.config.controllerToken}`,
            "X-Bridge-Timestamp": (this.options.now?.() ?? new Date()).toISOString(),
            "X-Bridge-Nonce": this.options.nonceFactory?.() ?? `mcp_${randomUUID().replaceAll("-", "")}`,
        });
        let requestBody;
        if (body !== undefined) {
            headers.set("content-type", "application/json");
            requestBody = JSON.stringify(body);
        }
        const request = new Request(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: requestBody,
        });
        const response = this.options.handler
            ? await this.options.handler(request)
            : await (this.options.fetch ?? fetch)(request);
        let envelope;
        try {
            envelope = await response.json();
        }
        catch {
            return {
                ok: false,
                data: null,
                error: bridgeError("INTERNAL_ERROR", "Bridge HTTP response was not valid JSON.", false),
            };
        }
        if (!isBridgeHttpEnvelope(envelope)) {
            return {
                ok: false,
                data: null,
                error: bridgeError("INTERNAL_ERROR", "Bridge HTTP response had an invalid envelope.", false),
            };
        }
        if (!response.ok && envelope.ok) {
            return {
                ok: false,
                data: null,
                error: bridgeError("INTERNAL_ERROR", "Bridge HTTP response status did not match its envelope.", false),
            };
        }
        return envelope;
    }
}
function isBridgeHttpEnvelope(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (typeof record.ok === "boolean" &&
        "data" in record &&
        (record.error === null || isBridgeError(record.error)));
}
function isBridgeError(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (typeof record.code === "string" &&
        typeof record.message === "string" &&
        typeof record.retryable === "boolean");
}
