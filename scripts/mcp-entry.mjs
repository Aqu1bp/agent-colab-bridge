#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = resolve(repoRoot, "dist", "src", "mcp-server.js");
const tscPath = resolve(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

if (!existsSync(serverPath) && !existsSync(tscPath)) {
  const result = spawnSync("npm", ["ci", "--ignore-scripts"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.stderr.write(
      "codex-colab-bridge MCP server dependencies are not installed, and `npm ci --ignore-scripts` failed. Run `npm install` in the plugin checkout.\n",
    );
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(serverPath)) {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.stderr.write(
      "codex-colab-bridge MCP server is not built, and `npm run build` failed. Run `npm install && npm run build` in the plugin checkout.\n",
    );
    process.exit(result.status ?? 1);
  }
}

const { runStdioMcpServer } = await import(pathToFileURL(serverPath).href);
await runStdioMcpServer();
