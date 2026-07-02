#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const serverPath = resolve(packageRoot, "dist", "src", "mcp-server.js");
const command = process.argv[2];

if (command === "mcp") {
  await runMcp();
} else {
  process.stderr.write(helpText());
  process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 1);
}

async function runMcp() {
  if (!existsSync(serverPath)) {
    process.stderr.write(
      "agent-colab-bridge MCP server build output is missing from this package. Reinstall the package or run `npm run build` from a source checkout.\n",
    );
    process.exit(1);
  }

  const { runStdioMcpServer } = await import(pathToFileURL(serverPath).href);
  await runStdioMcpServer();
}

function helpText() {
  return `Usage: agent-colab-bridge <command>

Commands:
  mcp    Start the stdio MCP server
`;
}
