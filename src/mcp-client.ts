import { randomUUID } from "node:crypto";
import { bridgeError, type BridgeError } from "./protocol.js";
import { type BridgeHttpHandler } from "./http.js";
import { type LocalBridgeConfig } from "./mcp-config.js";

export interface BridgeHttpEnvelope<TData = unknown> {
  ok: boolean;
  data: TData | null;
  error: BridgeError | null;
}

export interface BridgeCommandData {
  session_id: string;
  command_id: string;
  type: string;
  state: string;
  result_payload: unknown | null;
  error: BridgeError | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  runner_instance_id: string | null;
  state_history: string[];
}

export interface BridgeHttpClientOptions {
  handler?: BridgeHttpHandler;
  fetch?: typeof fetch;
  now?: () => Date;
  nonceFactory?: () => string;
}

export class BridgeHttpClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: LocalBridgeConfig,
    private readonly options: BridgeHttpClientOptions = {},
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async getStatus(): Promise<BridgeHttpEnvelope> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/status`);
  }

  async createPingCommand(): Promise<BridgeHttpEnvelope<BridgeCommandData>> {
    return this.request<BridgeCommandData>(
      "POST",
      `/v1/sessions/${encodeURIComponent(this.config.sessionId)}/commands`,
      { type: "ping" },
    );
  }

  private async request<TData>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<BridgeHttpEnvelope<TData>> {
    const headers = new Headers({
      Authorization: `Bearer ${this.config.controllerToken}`,
      "X-Bridge-Timestamp": (this.options.now?.() ?? new Date()).toISOString(),
      "X-Bridge-Nonce": this.options.nonceFactory?.() ?? `mcp_${randomUUID().replaceAll("-", "")}`,
    });

    let requestBody: string | undefined;
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

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      return {
        ok: false,
        data: null,
        error: bridgeError("INTERNAL_ERROR", "Bridge HTTP response was not valid JSON.", false),
      };
    }

    if (!isBridgeHttpEnvelope<TData>(envelope)) {
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

function isBridgeHttpEnvelope<TData>(value: unknown): value is BridgeHttpEnvelope<TData> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    "data" in record &&
    (record.error === null || isBridgeError(record.error))
  );
}

function isBridgeError(value: unknown): value is BridgeError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean"
  );
}
