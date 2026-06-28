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
  assert.equal(toolByName("colab_run_shell")?.enabledByDefault, false);
  assert.equal(toolByName("colab_run_shell")?.annotations.destructiveHint, true);
});
