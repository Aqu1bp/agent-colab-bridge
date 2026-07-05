#!/usr/bin/env node
import { execFile } from "node:child_process";
import { basename } from "node:path/posix";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const forbiddenRules = [
  {
    reason: "Python bytecode or cache",
    matches: (path, parts) => parts.includes("__pycache__") || /\.(pyc|pyo)$/i.test(path),
  },
  {
    reason: "dependency directory",
    matches: (_path, parts) => parts.includes("node_modules"),
  },
  {
    reason: "OS metadata",
    matches: (path) => [".DS_Store", "Thumbs.db"].includes(basename(path)),
  },
  {
    reason: "environment file",
    matches: (path) => {
      const name = basename(path);
      return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
    },
  },
  {
    reason: "local config",
    matches: (path, parts) =>
      parts.includes(".config") ||
      parts.includes(".wrangler") ||
      basename(path) === ".dev.vars" ||
      basename(path).endsWith(".local.json") ||
      basename(path).endsWith(".local.toml"),
  },
  {
    reason: "log file",
    matches: (path) => /\.(log|log\.\d+)$/i.test(path) || ["npm-debug.log", "yarn-error.log", "pnpm-debug.log"].includes(basename(path)),
  },
  {
    reason: "generated cache or coverage",
    matches: (_path, parts) =>
      parts.some((part) =>
        [
          ".cache",
          ".mypy_cache",
          ".next",
          ".nyc_output",
          ".parcel-cache",
          ".pytest_cache",
          ".ruff_cache",
          ".turbo",
          "coverage",
        ].includes(part),
      ),
  },
  {
    reason: "VCS metadata",
    matches: (_path, parts) => parts.includes(".git"),
  },
];

// Inspect the current tree without invoking prepack. `npm test` runs the plugin
// drift guard immediately before this check so generated payloads stay fresh.
const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  maxBuffer: 4 * 1024 * 1024,
});

let packResults;
try {
  packResults = JSON.parse(stdout);
} catch (error) {
  throw new Error(`Unable to parse npm pack JSON output: ${error.message}\n${stdout}`);
}

const [pack] = packResults;
if (!pack?.files) {
  throw new Error("npm pack did not return a file list.");
}

const violations = [];
for (const file of pack.files) {
  const path = file.path;
  const parts = path.split("/");
  for (const rule of forbiddenRules) {
    if (rule.matches(path, parts)) {
      violations.push({ path, reason: rule.reason });
    }
  }
}

if (violations.length > 0) {
  console.error("Forbidden files would be included in the npm package:");
  for (const { path, reason } of violations) {
    console.error(`- ${path} (${reason})`);
  }
  console.error("\nInspect with: npm pack --dry-run --ignore-scripts --json");
  process.exit(1);
}

console.log(`Package contents check passed: ${pack.files.length} files inspected.`);
