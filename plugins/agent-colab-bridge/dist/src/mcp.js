import { DEFAULT_JOB_LOG_BYTES, DEFAULT_READ_FILE_MAX_BYTES, DEFAULT_TAIL_MAX_BYTES, MAX_FILE_CONTENT_BYTES, MAX_JOB_LOG_BYTES, MAX_READ_FILE_BYTES, MAX_TAIL_BYTES, bridgeError, } from "./protocol.js";
const emptyObjectSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
};
const structuredOutputSchema = {
    type: "object",
    required: ["ok", "data", "error"],
    properties: {
        ok: { type: "boolean" },
        data: {},
        error: {
            anyOf: [
                { type: "null" },
                {
                    type: "object",
                    required: ["code", "message", "retryable"],
                    properties: {
                        code: { type: "string" },
                        message: { type: "string" },
                        retryable: { type: "boolean" },
                    },
                },
            ],
        },
    },
};
export const readOnlyRemoteAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};
export const dangerousRemoteAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};
export const localOperationalAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};
export const sessionRevocationAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};
export const readOnlyLocalOperationalAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};
export const toolDefinitions = [
    {
        name: "colab_status",
        description: "Return authenticated bridge and runner status.",
        inputSchema: emptyObjectSchema,
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_get_config_summary",
        description: "Return a sanitized summary of effective local bridge config without contacting the Worker.",
        inputSchema: emptyObjectSchema,
        outputSchema: structuredOutputSchema,
        annotations: readOnlyLocalOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_revoke_session",
        description: "Revoke the current bridge session through the Worker. This invalidates bridge tokens but does not stop the Colab runtime.",
        inputSchema: {
            type: "object",
            properties: {
                dry_run: { type: "boolean", default: false },
                confirm_revoke_session: { type: "boolean", default: false },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: sessionRevocationAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_runner_ping",
        description: "Run an authenticated ping through the connected Colab runner.",
        inputSchema: emptyObjectSchema,
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_gpu_status",
        description: "Run the fixed read-only GPU status probe in the connected Colab runner.",
        inputSchema: emptyObjectSchema,
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_doctor",
        description: "Run local Colab bridge prerequisite, config, and optional network diagnostics without requiring bridge config.",
        inputSchema: {
            type: "object",
            properties: {
                config: { type: "string" },
                base_url: { type: "string" },
                skip_network: { type: "boolean", default: false },
                require_network: { type: "boolean", default: false },
                timeout_sec: { type: "number", default: 120, minimum: 1, maximum: 300 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyLocalOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_list_sessions",
        description: "List local google-colab-cli sessions without requiring bridge config.",
        inputSchema: {
            type: "object",
            properties: {
                colab_config: { type: "string" },
                timeout_sec: { type: "number", default: 120, minimum: 1, maximum: 300 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyLocalOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_runtime_status",
        description: "Return google-colab-cli status for the named Colab session without requiring bridge config.",
        inputSchema: {
            type: "object",
            properties: {
                colab_session: { type: "string", default: "agent-colab-bridge" },
                colab_config: { type: "string" },
                timeout_sec: { type: "number", default: 120, minimum: 1, maximum: 300 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyLocalOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_runtime_url",
        description: "Return google-colab-cli URL for the named Colab session without requiring bridge config.",
        inputSchema: {
            type: "object",
            properties: {
                colab_session: { type: "string", default: "agent-colab-bridge" },
                colab_config: { type: "string" },
                timeout_sec: { type: "number", default: 120, minimum: 1, maximum: 300 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyLocalOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_upload_file",
        description: "Upload a local file to the named Colab session through google-colab-cli.",
        inputSchema: {
            type: "object",
            required: ["local_path", "remote_path"],
            properties: {
                local_path: { type: "string" },
                remote_path: { type: "string" },
                colab_session: { type: "string", default: "agent-colab-bridge" },
                colab_config: { type: "string" },
                timeout_sec: { type: "number", default: 300, minimum: 1, maximum: 1800 },
                dry_run: { type: "boolean", default: false },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: localOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_download_file",
        description: "Download a file from the named Colab session through google-colab-cli.",
        inputSchema: {
            type: "object",
            required: ["remote_path", "local_path"],
            properties: {
                remote_path: { type: "string" },
                local_path: { type: "string" },
                colab_session: { type: "string", default: "agent-colab-bridge" },
                colab_config: { type: "string" },
                timeout_sec: { type: "number", default: 300, minimum: 1, maximum: 1800 },
                dry_run: { type: "boolean", default: false },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: localOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_reconnect_runner",
        description: "Run the local google-colab-cli reconnect helper for an offline Colab runner without requiring the runner token locally.",
        inputSchema: {
            type: "object",
            properties: {
                colab_session: { type: "string", default: "agent-colab-bridge" },
                colab_config: { type: "string" },
                project_root: { type: "string" },
                timeout_sec: { type: "number", default: 60, minimum: 1, maximum: 300 },
                dry_run: { type: "boolean", default: false },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: localOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_setup_bridge",
        description: "Deploy/configure the bridge and optionally bootstrap a Colab runner from the installed plugin package, independent of the current workspace.",
        inputSchema: {
            type: "object",
            properties: {
                dry_run: { type: "boolean", default: false },
                confirm_remote_code_execution: { type: "boolean", default: false },
                base_url: { type: "string" },
                admin_secret: { type: "string" },
                enable_dangerous_tools: { type: "boolean", default: false },
                bootstrap: { type: "boolean", default: true },
                smoke: { type: "boolean", default: true },
                gpu: { type: "string", default: "T4" },
                colab_session: { type: "string", default: "agent-colab-bridge" },
                project_root: { type: "string", default: "/content/project" },
                colab_config: { type: "string" },
                config: { type: "string" },
                timeout_sec: { type: "number", default: 900, minimum: 1, maximum: 1800 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: localOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_runtime_options",
        description: "Return accelerator candidates reported by google-colab-cli. This is not a live capacity or account-quota guarantee.",
        inputSchema: {
            type: "object",
            properties: {
                colab_config: { type: "string" },
                timeout_sec: { type: "number", default: 120, minimum: 1, maximum: 300 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_stop_runtime",
        description: "Stop the named Colab runtime through google-colab-cli from the installed plugin package.",
        inputSchema: {
            type: "object",
            properties: {
                dry_run: { type: "boolean", default: false },
                confirm_runtime_stop: { type: "boolean", default: false },
                colab_session: { type: "string", default: "agent-colab-bridge" },
                colab_config: { type: "string" },
                timeout_sec: { type: "number", default: 120, minimum: 1, maximum: 300 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: localOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_recreate_runtime",
        description: "Stop the named Colab session, create a fresh bridge session, and bootstrap a runtime with the requested accelerator from the installed plugin package.",
        inputSchema: {
            type: "object",
            required: ["gpu"],
            properties: {
                gpu: { type: "string" },
                dry_run: { type: "boolean", default: false },
                confirm_runtime_recreation: { type: "boolean", default: false },
                skip_stop: { type: "boolean", default: false },
                smoke: { type: "boolean", default: true },
                enable_dangerous_tools: { type: "boolean" },
                colab_session: { type: "string", default: "agent-colab-bridge" },
                project_root: { type: "string", default: "/content/project" },
                colab_config: { type: "string" },
                config: { type: "string" },
                base_url: { type: "string" },
                admin_secret: { type: "string" },
                timeout_sec: { type: "number", default: 900, minimum: 1, maximum: 1800 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: localOperationalAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_run_shell",
        description: "Run a short foreground shell command in the connected Colab runner when explicitly enabled.",
        inputSchema: {
            type: "object",
            required: ["command"],
            properties: {
                command: { type: "string" },
                timeout_sec: { type: "number", default: 30, maximum: 120 },
                max_output_bytes: { type: "integer", default: 20480, maximum: 20480 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: dangerousRemoteAnnotations,
        enabledByDefault: false,
    },
    {
        name: "colab_run_python",
        description: "Run short foreground Python code in the connected Colab runner when explicitly enabled.",
        inputSchema: {
            type: "object",
            required: ["code"],
            properties: {
                code: { type: "string" },
                timeout_sec: { type: "number", default: 30, maximum: 120 },
                max_output_bytes: { type: "integer", default: 20480, maximum: 20480 },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: dangerousRemoteAnnotations,
        enabledByDefault: false,
    },
    {
        name: "colab_write_file",
        description: "Write a small UTF-8 text file under the Colab project root when explicitly enabled.",
        inputSchema: {
            type: "object",
            required: ["path", "content", "mode"],
            properties: {
                path: { type: "string" },
                content: { type: "string", maxLength: MAX_FILE_CONTENT_BYTES },
                mode: { enum: ["overwrite", "append", "create_new"] },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: dangerousRemoteAnnotations,
        enabledByDefault: false,
    },
    {
        name: "colab_read_file",
        description: "Read a small UTF-8 text file under the Colab project root.",
        inputSchema: {
            type: "object",
            required: ["path"],
            properties: {
                path: { type: "string" },
                max_bytes: {
                    type: "integer",
                    default: DEFAULT_READ_FILE_MAX_BYTES,
                    maximum: MAX_READ_FILE_BYTES,
                },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_start_job",
        description: "Start one background shell job in the connected Colab runner when explicitly enabled.",
        inputSchema: {
            type: "object",
            required: ["command"],
            properties: {
                command: { type: "string" },
                name: { type: "string" },
                max_log_bytes: {
                    type: "integer",
                    default: DEFAULT_JOB_LOG_BYTES,
                    maximum: MAX_JOB_LOG_BYTES,
                },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: dangerousRemoteAnnotations,
        enabledByDefault: false,
    },
    {
        name: "colab_tail_job",
        description: "Read bounded background job log events from the connected Colab runner.",
        inputSchema: {
            type: "object",
            required: ["job_id"],
            properties: {
                job_id: { type: "string" },
                cursor: { type: "integer", default: 0, minimum: 0 },
                max_bytes: {
                    type: "integer",
                    default: DEFAULT_TAIL_MAX_BYTES,
                    maximum: MAX_TAIL_BYTES,
                },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_list_jobs",
        description: "List runner-owned background job summaries from the connected Colab runner.",
        inputSchema: emptyObjectSchema,
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_job_status",
        description: "Return one runner-owned background job summary from the connected Colab runner.",
        inputSchema: {
            type: "object",
            required: ["job_id"],
            properties: {
                job_id: { type: "string" },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
    {
        name: "colab_interrupt_job",
        description: "Interrupt a background job process group in the connected Colab runner when explicitly enabled.",
        inputSchema: {
            type: "object",
            required: ["job_id"],
            properties: {
                job_id: { type: "string" },
                signal: { enum: ["SIGTERM", "SIGKILL"] },
                kill_after_sec: {
                    type: "number",
                    default: 5,
                    maximum: 30,
                },
            },
            additionalProperties: false,
        },
        outputSchema: structuredOutputSchema,
        annotations: dangerousRemoteAnnotations,
        enabledByDefault: false,
    },
];
const hiddenToolAliases = [
    {
        name: "colab_ping",
        description: "Backward-compatible alias for colab_runner_ping.",
        inputSchema: emptyObjectSchema,
        outputSchema: structuredOutputSchema,
        annotations: readOnlyRemoteAnnotations,
        enabledByDefault: true,
    },
];
export function toolByName(name) {
    return (toolDefinitions.find((tool) => tool.name === name) ??
        hiddenToolAliases.find((tool) => tool.name === name));
}
export function isEnabledDangerousExecutionTool(name) {
    return (name === "colab_run_shell" ||
        name === "colab_run_python" ||
        name === "colab_write_file" ||
        name === "colab_start_job" ||
        name === "colab_interrupt_job");
}
export function callToolSuccess(text, data) {
    return {
        content: [{ type: "text", text }],
        structuredContent: {
            ok: true,
            data,
            error: null,
        },
        isError: false,
    };
}
export function callToolError(error) {
    return {
        content: [{ type: "text", text: `${error.code}: ${error.message}` }],
        structuredContent: {
            ok: false,
            data: null,
            error,
        },
        isError: true,
    };
}
export function disabledToolResult(toolName, code = "TOOL_DISABLED") {
    return callToolError(bridgeError(code, `${toolName} is disabled by local policy.`, false));
}
