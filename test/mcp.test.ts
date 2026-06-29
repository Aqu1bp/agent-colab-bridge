import test from "node:test";
import assert from "node:assert/strict";
import {
  callToolSuccess,
  disabledToolResult,
  toolByName,
  toolDefinitions,
} from "../src/mcp.js";

test("MCP success result uses content, structuredContent, and isError", () => {
  const result = callToolSuccess("Runner connected.", { runner_connected: true });

  assert.deepEqual(result.content, [{ type: "text", text: "Runner connected." }]);
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.data, { runner_connected: true });
  assert.equal(result.structuredContent.error, null);
  assert.equal(result.isError, false);
});

test("disabled dangerous tool result shape is MCP call result error", () => {
  const result = disabledToolResult("colab_run_shell");

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.data, null);
  assert.equal(result.structuredContent.error?.code, "TOOL_DISABLED");
  assert.equal(result.content[0]?.text.startsWith("TOOL_DISABLED:"), true);
});

test("tool metadata declares annotations and output schemas", () => {
  assert.equal(toolDefinitions.length > 0, true);
  for (const tool of toolDefinitions) {
    assert.equal(typeof tool.inputSchema, "object");
    assert.equal(typeof tool.outputSchema, "object");
    assert.equal(tool.annotations.openWorldHint, true);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.idempotentHint, "boolean");
  }

  assert.equal(toolByName("colab_status")?.enabledByDefault, true);
  assert.equal(toolByName("colab_get_config_summary")?.enabledByDefault, true);
  assert.equal(toolByName("colab_get_config_summary")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_revoke_session")?.enabledByDefault, true);
  assert.equal(toolByName("colab_revoke_session")?.annotations.readOnlyHint, false);
  assert.equal(toolByName("colab_revoke_session")?.annotations.destructiveHint, true);
  assert.equal(toolByName("colab_runner_ping")?.enabledByDefault, true);
  assert.equal(toolByName("colab_runner_ping")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_ping")?.enabledByDefault, true);
  assert.equal(toolDefinitions.some((tool) => tool.name === "colab_ping"), false);
  assert.equal(toolByName("colab_gpu_status")?.enabledByDefault, true);
  assert.equal(toolByName("colab_gpu_status")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_doctor")?.enabledByDefault, true);
  assert.equal(toolByName("colab_doctor")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_list_sessions")?.enabledByDefault, true);
  assert.equal(toolByName("colab_list_sessions")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_runtime_status")?.enabledByDefault, true);
  assert.equal(toolByName("colab_runtime_status")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_runtime_url")?.enabledByDefault, true);
  assert.equal(toolByName("colab_runtime_url")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_upload_file")?.enabledByDefault, true);
  assert.equal(toolByName("colab_upload_file")?.annotations.readOnlyHint, false);
  assert.equal(toolByName("colab_upload_file")?.annotations.destructiveHint, false);
  assert.equal(toolByName("colab_download_file")?.enabledByDefault, true);
  assert.equal(toolByName("colab_download_file")?.annotations.readOnlyHint, false);
  assert.equal(toolByName("colab_download_file")?.annotations.destructiveHint, false);
  assert.equal(toolByName("colab_reconnect_runner")?.enabledByDefault, true);
  assert.equal(toolByName("colab_reconnect_runner")?.annotations.readOnlyHint, false);
  assert.equal(toolByName("colab_reconnect_runner")?.annotations.destructiveHint, false);
  assert.equal(toolByName("colab_setup_bridge")?.enabledByDefault, true);
  assert.equal(toolByName("colab_setup_bridge")?.annotations.readOnlyHint, false);
  assert.equal(toolByName("colab_runtime_options")?.enabledByDefault, true);
  assert.equal(toolByName("colab_runtime_options")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_stop_runtime")?.enabledByDefault, true);
  assert.equal(toolByName("colab_stop_runtime")?.annotations.readOnlyHint, false);
  assert.equal(toolByName("colab_recreate_runtime")?.enabledByDefault, true);
  assert.equal(toolByName("colab_recreate_runtime")?.annotations.readOnlyHint, false);
  assert.equal(toolByName("colab_run_shell")?.enabledByDefault, false);
  assert.equal(toolByName("colab_run_shell")?.annotations.destructiveHint, true);
  assert.equal(toolByName("colab_write_file")?.enabledByDefault, false);
  assert.equal(toolByName("colab_write_file")?.annotations.destructiveHint, true);
  assert.equal(toolByName("colab_read_file")?.enabledByDefault, true);
  assert.equal(toolByName("colab_read_file")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_read_file")?.annotations.idempotentHint, true);
  assert.equal(toolByName("colab_start_job")?.enabledByDefault, false);
  assert.equal(toolByName("colab_start_job")?.annotations.destructiveHint, true);
  assert.equal(toolByName("colab_list_jobs")?.enabledByDefault, true);
  assert.equal(toolByName("colab_list_jobs")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_job_status")?.enabledByDefault, true);
  assert.equal(toolByName("colab_job_status")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_tail_job")?.enabledByDefault, true);
  assert.equal(toolByName("colab_tail_job")?.annotations.readOnlyHint, true);
  assert.equal(toolByName("colab_tail_job")?.annotations.idempotentHint, true);
  assert.equal(toolByName("colab_interrupt_job")?.enabledByDefault, false);
  assert.equal(toolByName("colab_interrupt_job")?.annotations.destructiveHint, true);
});
