import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const pluginRoot = resolve("plugins", "codex-colab-bridge");

test("Codex marketplace plugin payload is a real packaged directory", async () => {
  assert.equal(existsSync(pluginRoot), true);
  assert.equal(lstatSync(pluginRoot).isSymbolicLink(), false);
  assert.equal(existsSync(resolve(pluginRoot, ".codex-plugin", "plugin.json")), true);
  assert.equal(existsSync(resolve(pluginRoot, ".mcp.json")), true);
  assert.equal(existsSync(resolve(pluginRoot, "dist", "src", "mcp-server.js")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "mcp-entry.mjs")), true);

  const entries = await readdir(pluginRoot);
  assert.equal(entries.includes(".git"), false);
  assert.equal(entries.includes("node_modules"), false);
  assert.equal(entries.includes("src"), false);
  assert.equal(entries.includes("test"), false);
});
