#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseSmokeArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--dangerous") {
      flags.dangerous = true;
      continue;
    }
    if (arg === "--skip-gpu") {
      flags.skipGpu = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    const key = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const value = equalsIndex === -1 ? argv[++index] : arg.slice(equalsIndex + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[toCamelCase(key)] = value;
  }
  return flags;
}

export function plannedSmokeTools(options = {}) {
  const tools = ["colab_status"];
  if (!options.skipGpu) {
    tools.push("colab_gpu_status");
  }
  if (options.dangerous) {
    tools.push("colab_run_shell");
  }
  return tools;
}

async function run(options) {
  if (options.help) {
    console.log(helpText());
    return;
  }

  const client = new StdioMcpClient(options.serverPath ?? "dist/src/mcp-server.js");
  await client.start();
  try {
    await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "colab-mcp-smoke", version: "0.1.0" },
    });

    const tools = await client.request("tools/list");
    const toolNames = new Set((tools.tools ?? []).map((tool) => tool.name));
    for (const name of plannedSmokeTools(options)) {
      if (!toolNames.has(name)) {
        throw new Error(`MCP server did not advertise expected tool ${name}.`);
      }
    }

    const status = await callTool(client, "colab_status", {});
    printToolSummary("colab_status", status);
    if (status.isError) {
      throw new Error("colab_status failed.");
    }

    if (!options.skipGpu) {
      const gpu = await callTool(client, "colab_gpu_status", {});
      printToolSummary("colab_gpu_status", gpu);
      if (gpu.isError) {
        throw new Error("colab_gpu_status failed.");
      }
    }

    if (options.dangerous) {
      const shell = await callTool(client, "colab_run_shell", {
        command: "pwd && python --version",
        timeout_sec: 30,
        max_output_bytes: 8192,
      });
      printToolSummary("colab_run_shell", shell);
      if (shell.isError) {
        throw new Error("colab_run_shell failed.");
      }
    }

    console.log("MCP smoke passed.");
  } finally {
    await client.close();
  }
}

async function callTool(client, name, toolArguments) {
  return client.request("tools/call", {
    name,
    arguments: toolArguments,
  });
}

function printToolSummary(name, result) {
  const status = result?.isError ? "FAIL" : "PASS";
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  console.log(`${status} ${name}: ${text}`);
}

class StdioMcpClient {
  constructor(serverPath) {
    this.serverPath = serverPath;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn(process.execPath, [this.serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.stderr = "";
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
        this.handleLine(line);
      }
    })();

    this.child.on("exit", (code) => {
      const error = new Error(`MCP server exited with code ${code}.${this.stderr ? ` stderr: ${this.stderr}` : ""}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method, params) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("MCP server is not running."));
    }

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}.`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
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
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function helpText() {
  return `Usage: node scripts/smoke-mcp.mjs [flags]

Runs a local stdio MCP server against the configured deployed bridge and calls
real MCP tools. Build first, or run through npm:

  npm run smoke:mcp

Common flags:
  --dangerous    also call colab_run_shell with a short command
  --skip-gpu     skip colab_gpu_status`;
}

if (process.argv[1] === SCRIPT_PATH) {
  Promise.resolve(parseSmokeArgs(process.argv.slice(2)))
    .then(run)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
