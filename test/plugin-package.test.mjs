import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const pluginRoot = resolve("plugins", "codex-colab-bridge");

test("Codex marketplace plugin payload is a real packaged directory", async () => {
  assert.equal(existsSync(pluginRoot), true);
  assert.equal(lstatSync(pluginRoot).isSymbolicLink(), false);
  assert.equal(existsSync(resolve(pluginRoot, ".codex-plugin", "plugin.json")), true);
  assert.equal(existsSync(resolve(pluginRoot, ".mcp.json")), true);
  assert.equal(existsSync(resolve(pluginRoot, "AGENTS.md")), true);
  assert.equal(existsSync(resolve(pluginRoot, "docs", "mcp-clients.md")), true);
  assert.equal(existsSync(resolve(pluginRoot, "dist", "src", "mcp-server.js")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "mcp-entry.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "local-bridge-common.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "setup-all.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "setup-bridge.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "bootstrap-colab.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "runtime-options.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "recreate-runtime.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "stop-runtime.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "smoke-mcp.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "reconnect-runner.mjs")), true);
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "colab-reconnect-runner.py")), true);
  assert.equal(existsSync(resolve(pluginRoot, "python", "colab_runner.py")), true);
  assert.equal(existsSync(resolve(pluginRoot, "wrangler.toml")), true);

  const packageJson = JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts?.["setup:all"], "node scripts/setup-all.mjs");
  assert.equal(packageJson.scripts?.["smoke:mcp"], "node scripts/smoke-mcp.mjs");
  assert.equal(packageJson.scripts?.["runtime:stop"], "node scripts/stop-runtime.mjs");
  assert.equal(packageJson.scripts?.["runner:reconnect"], "node scripts/reconnect-runner.mjs");

  const wranglerToml = await readFile(resolve(pluginRoot, "wrangler.toml"), "utf8");
  assert.match(wranglerToml, /^main = "dist\/src\/worker\.js"$/m);

  const entries = await readdir(pluginRoot);
  assert.equal(entries.includes(".git"), false);
  assert.equal(entries.includes("node_modules"), false);
  assert.equal(entries.includes("src"), false);
  assert.equal(entries.includes("test"), false);
});

test("Codex plugin packager includes doctor script for local MCP diagnostics", async () => {
  const packager = await readFile(resolve("scripts", "package-codex-plugin.mjs"), "utf8");

  assert.match(packager, /copyFile\("scripts\/doctor\.mjs", "scripts\/doctor\.mjs"\)/);
  assert.match(packager, /copyFile\("AGENTS\.md", "AGENTS\.md"\)/);
  assert.match(packager, /copyDirectory\("docs", "docs"\)/);
  assert.match(packager, /doctor: "node scripts\/doctor\.mjs"/);
});

test("Codex plugin MCP entrypoint keeps install and build recovery off stdout", async () => {
  const entrypoint = await readFile(resolve(pluginRoot, "scripts", "mcp-entry.mjs"), "utf8");

  assert.doesNotMatch(entrypoint, /stdio: "inherit"/);
  assert.match(entrypoint, /stdio: \["ignore", "pipe", "pipe"\]/);
  assert.match(entrypoint, /process\.stderr\.write\(stdout\)/);
});
