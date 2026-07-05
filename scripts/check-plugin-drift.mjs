#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const pluginRoot = resolve(repoRoot, "plugins", "agent-colab-bridge");
const tempRoot = await mkdtemp(resolve(tmpdir(), "agent-colab-bridge-plugin-drift-"));
const beforeRoot = resolve(tempRoot, "before");

try {
  if (existsSync(pluginRoot)) {
    await cp(pluginRoot, beforeRoot, { recursive: true });
  }

  run("npm", ["run", "package:plugin"]);

  const diff = spawnSync("git", ["diff", "--no-index", "--quiet", beforeRoot, pluginRoot], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (diff.status === 0) {
    process.exit(0);
  }
  if (diff.status === 1) {
    process.stderr.write(
      "Generated plugin payload drifted. Run `npm run package:plugin` and commit plugins/agent-colab-bridge.\n",
    );
    process.exit(1);
  }
  process.exit(diff.status ?? 1);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
