import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

test("root package exposes the generic MCP CLI command", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));

  assert.equal(packageJson.bin?.["agent-colab-bridge"], "bin/agent-colab-bridge.mjs");
  assert.ok(packageJson.files.includes("bin/"));
  assert.ok(packageJson.files.includes("dist/src/"));

  const bin = await readFile(resolve("bin", "agent-colab-bridge.mjs"), "utf8");
  assert.match(bin, /command === "mcp"/);
  assert.doesNotMatch(bin, /spawn(Sync)?/);
});

test("npm package payload includes the root MCP entry files", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  const [pack] = JSON.parse(stdout);
  const files = new Set(pack.files.map((file) => file.path));

  assert.ok(files.has("bin/agent-colab-bridge.mjs"));
  assert.ok(files.has("dist/src/mcp-server.js"));
  assert.ok(files.has("dist/src/mcp.js"));
  assert.ok(files.has("dist/src/mcp-config.js"));
  assert.ok(files.has("scripts/mcp-entry.mjs"));
  assert.ok(files.has("plugins/agent-colab-bridge/dist/src/mcp-server.js"));
});

test("generic MCP CLI stdout is JSON-RPC only", async () => {
  const client = new StdioClient(process.execPath, [resolve("bin", "agent-colab-bridge.mjs"), "mcp"]);
  await client.start();
  try {
    await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "distribution-test", version: "0" },
    });
    const tools = await client.request("tools/list");
    assert.ok(tools.tools.some((tool) => tool.name === "colab_get_config_summary"));

    for (const line of client.stdoutLines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    await client.close();
  }
});

test("docs include Claude Code, Cursor, and OpenCode MCP snippets", async () => {
  const docs = `${await readFile(resolve("README.md"), "utf8")}\n${await readFile(resolve("docs", "mcp-clients.md"), "utf8")}\n${await readFile(resolve("AGENTS.md"), "utf8")}`;

  assert.match(docs, /claude mcp add --transport stdio colab-bridge -- npx -y agent-colab-bridge mcp/);
  assert.match(docs, /"type": "stdio"/);
  assert.match(docs, /"command": "npx"/);
  assert.match(docs, /"args": \["-y", "agent-colab-bridge", "mcp"\]/);
  assert.match(docs, /"type": "local"/);
  assert.match(docs, /"command": \["npx", "-y", "agent-colab-bridge", "mcp"\]/);
  assert.match(docs, /"enabled": true/);
  assert.match(docs, /colab_doctor/);
  assert.match(docs, /colab_get_config_summary/);
  assert.match(docs, /colab_setup_bridge/);
  assert.match(docs, /colab_reconnect_runner/);
  assert.match(docs, /Dangerous tools are remote code execution and are disabled until explicitly\s+enabled/);
});

class StdioClient {
  constructor(command, args) {
    this.command = command;
    this.args = args;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutLines = [];
    this.stderr = "";
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    const lines = createInterface({ input: this.child.stdout });
    this.reader = (async () => {
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        this.stdoutLines.push(line);
        this.handleLine(line);
      }
    })();

    this.child.on("exit", (code) => {
      const error = new Error(`MCP server exited with code ${code}.${this.stderr ? ` stderr: ${this.stderr}` : ""}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}.${this.stderr ? ` stderr: ${this.stderr}` : ""}`));
      }, 10_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timeout });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      throw new Error(`stdout line was not JSON: ${line}`);
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  async close() {
    if (!this.child) {
      return;
    }
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await Promise.race([
      this.reader?.catch(() => undefined),
      new Promise((resolveClose) => setTimeout(resolveClose, 1_000)),
    ]);
  }
}
