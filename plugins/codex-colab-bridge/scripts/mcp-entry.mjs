#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = resolve(repoRoot, "dist", "src", "mcp-server.js");
const tscPath = resolve(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const lockPath = resolve(repoRoot, "package-lock.json");
const sourcePath = resolve(repoRoot, "src", "mcp-server.ts");

if (!existsSync(serverPath) && !existsSync(sourcePath)) {
  process.stderr.write(
    "codex-colab-bridge MCP server build output is missing from this plugin install. Reinstall the plugin or run `npm run package:plugin` from a source checkout.\n",
  );
  process.exit(1);
}

if (!existsSync(serverPath) && !existsSync(tscPath)) {
  const installArgs = existsSync(lockPath) ? ["ci", "--ignore-scripts"] : ["install", "--ignore-scripts"];
  const result = spawnSync("npm", installArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.stderr.write(
      `codex-colab-bridge MCP server dependencies are not installed, and \`npm ${installArgs.join(" ")}\` failed. Run \`npm install\` in the source checkout.\n`,
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
