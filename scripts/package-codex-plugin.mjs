#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outputRoot = resolve(repoRoot, "plugins", "codex-colab-bridge");
const requiredServer = resolve(repoRoot, "dist", "src", "mcp-server.js");

if (!existsSync(requiredServer)) {
  throw new Error("dist/src/mcp-server.js is missing. Run `npm run build` before packaging the Codex plugin.");
}

await removeOutput(outputRoot);
await mkdir(outputRoot, { recursive: true });

await copyDirectory(".codex-plugin", ".codex-plugin");
await copyDirectory("skills", "skills");
await copyDirectory("dist/src", "dist/src");
await copyDirectory("python", "python");
await copyFile(".mcp.json", ".mcp.json");
await copyFile("LICENSE", "LICENSE");
await copyFile("README.md", "README.md");
await copyFile("SECURITY.md", "SECURITY.md");
await copyFile("scripts/local-bridge-common.mjs", "scripts/local-bridge-common.mjs");
await copyFile("scripts/doctor.mjs", "scripts/doctor.mjs");
await copyFile("scripts/mcp-entry.mjs", "scripts/mcp-entry.mjs");
await copyFile("scripts/colab-reconnect-runner.py", "scripts/colab-reconnect-runner.py");
await copyFile("scripts/reconnect-runner.mjs", "scripts/reconnect-runner.mjs");
await copyFile("scripts/bootstrap-colab.mjs", "scripts/bootstrap-colab.mjs");
await copyFile("scripts/recreate-runtime.mjs", "scripts/recreate-runtime.mjs");
await copyFile("scripts/runtime-options.mjs", "scripts/runtime-options.mjs");
await copyFile("scripts/setup-all.mjs", "scripts/setup-all.mjs");
await copyFile("scripts/setup-bridge.mjs", "scripts/setup-bridge.mjs");
await copyFile("scripts/smoke-mcp.mjs", "scripts/smoke-mcp.mjs");
await copyFile("scripts/stop-runtime.mjs", "scripts/stop-runtime.mjs");
await writePluginWranglerConfig();

const sourcePackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const pluginPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  private: true,
  license: sourcePackage.license,
  type: sourcePackage.type,
  engines: sourcePackage.engines,
  scripts: {
    "bootstrap:colab": "node scripts/bootstrap-colab.mjs",
    doctor: "node scripts/doctor.mjs",
    "runner:reconnect": "node scripts/reconnect-runner.mjs",
    "runtime:options": "node scripts/runtime-options.mjs",
    "runtime:recreate": "node scripts/recreate-runtime.mjs",
    "runtime:stop": "node scripts/stop-runtime.mjs",
    "setup:all": "node scripts/setup-all.mjs",
    "setup:bridge": "node scripts/setup-bridge.mjs",
    "smoke:mcp": "node scripts/smoke-mcp.mjs",
  },
};
await writeFile(resolve(outputRoot, "package.json"), `${JSON.stringify(pluginPackage, null, 2)}\n`);

console.log(`Packaged Codex plugin at ${outputRoot}`);

async function removeOutput(path) {
  if (!existsSync(path)) {
    return;
  }
  const stat = lstatSync(path);
  await rm(path, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}

async function copyDirectory(from, to) {
  await cp(resolve(repoRoot, from), resolve(outputRoot, to), {
    recursive: true,
    force: true,
  });
}

async function copyFile(from, to) {
  const destination = resolve(outputRoot, to);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(repoRoot, from), destination, { force: true });
}

async function writePluginWranglerConfig() {
  const source = await readFile(resolve(repoRoot, "wrangler.toml"), "utf8");
  const pluginConfig = source.replace(/^main = "src\/worker\.ts"$/m, 'main = "dist/src/worker.js"');
  await writeFile(resolve(outputRoot, "wrangler.toml"), pluginConfig);
}
