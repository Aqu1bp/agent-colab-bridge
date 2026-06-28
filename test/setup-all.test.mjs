import test from "node:test";
import assert from "node:assert/strict";
import {
  collectSetupAllPrerequisites,
  createSetupAllPlan,
  dryRunLines,
  loadSetupAllOptions,
  parseWorkerUrlFromWranglerOutput,
  resolveWorkerUrl,
} from "../scripts/setup-all.mjs";

test("setup:all dry run plans redacted commands and writes no secrets", async () => {
  const options = await loadSetupAllOptions({
    argv: [
      "--dry-run",
      "--admin-secret",
      "admin_secret",
      "--base-url",
      "https://bridge.test/",
      "--enable-dangerous-tools",
      "--colab-session",
      "named",
      "--gpu",
      "T4",
      "--project-root",
      "/content/project",
      "--smoke",
      "--config",
      "bridge.json",
      "--colab-config",
      "/tmp/colab-cli.json",
    ],
    env: {},
    cwd: "/tmp/repo",
    exists: () => false,
    generateSecret: () => "generated_secret",
  });

  const text = dryRunLines(options).join("\n");
  assert.match(text, /Dry run only/);
  assert.match(text, /npx --no-install wrangler secret put ADMIN_SECRET/);
  assert.match(text, /npx --no-install wrangler secret put COLAB_MCP_BRIDGE_ENABLE_DANGEROUS_TOOLS/);
  assert.match(text, /npx --no-install wrangler deploy/);
  assert.match(text, /POST https:\/\/bridge.test\/v1\/sessions/);
  assert.match(text, /COLAB_MCP_BRIDGE_RUNNER_TOKEN=<runner-token-redacted>/);
  assert.match(text, /npm run smoke:mcp -- --dangerous/);
  assert.match(text, /Local MCP config: \/tmp\/repo\/bridge.json/);
  assert.match(text, /--colab-config \/tmp\/colab-cli\.json/);
  assert.doesNotMatch(text, /admin_secret/);
  assert.doesNotMatch(text, /generated_secret/);
});

test("setup:all dry run can plan generated admin secret without printing it", async () => {
  const options = await loadSetupAllOptions({
    argv: ["--dry-run", "--no-bootstrap"],
    env: {},
    cwd: "/tmp/repo",
    exists: () => false,
    generateSecret: () => "generated_secret",
  });

  const text = dryRunLines(options).join("\n");
  assert.equal(options.adminSecret, "generated_secret");
  assert.equal(options.adminSecretGenerated, true);
  assert.match(text, /Admin secret: generated for real run \(redacted\)/);
  assert.match(text, /Worker URL: derived from Wrangler deploy output/);
  assert.match(text, /stdin: 0/);
  assert.doesNotMatch(text, /generated_secret/);
});

test("setup:all dry run ignores default local Worker URL unless config is explicit", async () => {
  const options = await loadSetupAllOptions({
    argv: ["--dry-run", "--no-bootstrap"],
    env: {},
    cwd: "/tmp/repo",
    exists: (path) => path.endsWith("/.config/codex-colab-bridge/config.json"),
    readTextFile: async () =>
      JSON.stringify({
        base_url: "https://private-worker.example.workers.dev",
        session_id: "sess_private",
        controller_token: "controller_private",
      }),
    generateSecret: () => "generated_secret",
  });

  const text = dryRunLines(options).join("\n");
  assert.equal(options.baseUrl, undefined);
  assert.match(text, /Worker URL: derived from Wrangler deploy output/);
  assert.doesNotMatch(text, /private-worker/);
});

test("setup:all dangerous tools require explicit flag or env", async () => {
  const options = await loadSetupAllOptions({
    argv: ["--dry-run", "--config", "bridge.json"],
    env: {},
    cwd: "/tmp/repo",
    exists: (path) => path === "/tmp/repo/bridge.json",
    readTextFile: async () => JSON.stringify({ enable_dangerous_tools: true }),
    generateSecret: () => "generated_secret",
  });
  const explicit = await loadSetupAllOptions({
    argv: ["--dry-run", "--enable-dangerous-tools"],
    env: {},
    cwd: "/tmp/repo",
    exists: () => false,
    generateSecret: () => "generated_secret",
  });

  assert.equal(options.enableDangerousTools, false);
  assert.equal(explicit.enableDangerousTools, true);
});

test("setup:all plan defaults to bootstrap and omits it when disabled", async () => {
  const defaultOptions = await loadSetupAllOptions({
    argv: [],
    env: {},
    cwd: "/tmp/repo",
    exists: () => false,
    generateSecret: () => "generated_secret",
  });
  const noBootstrapOptions = await loadSetupAllOptions({
    argv: ["--no-bootstrap"],
    env: {},
    cwd: "/tmp/repo",
    exists: () => false,
    generateSecret: () => "generated_secret",
  });

  assert.equal(defaultOptions.bootstrap, true);
  assert.ok(createSetupAllPlan(defaultOptions).some((step) => step.label === "Bootstrap Colab"));
  assert.equal(noBootstrapOptions.bootstrap, false);
  assert.equal(createSetupAllPlan(noBootstrapOptions).some((step) => step.label === "Bootstrap Colab"), false);
});

test("setup:all Worker URL parser handles common Wrangler output", () => {
  assert.equal(
    parseWorkerUrlFromWranglerOutput(`
      Total Upload: 12 KiB / gzip: 4 KiB
      Uploaded codex-colab-bridge
      Published codex-colab-bridge
        https://codex-colab-bridge.example.workers.dev
    `),
    "https://codex-colab-bridge.example.workers.dev",
  );
  assert.equal(
    parseWorkerUrlFromWranglerOutput("route: https://bridge.example.workers.dev/*"),
    "https://bridge.example.workers.dev",
  );
  assert.equal(
    parseWorkerUrlFromWranglerOutput("Version: https://dash.cloudflare.com/x\nhttps://real.worker.workers.dev"),
    "https://real.worker.workers.dev",
  );
});

test("setup:all Worker URL resolver prefers explicit base URL fallback", () => {
  assert.equal(
    resolveWorkerUrl({ baseUrl: "https://explicit.test/" }, "https://parsed.workers.dev"),
    "https://explicit.test",
  );
  assert.throws(() => resolveWorkerUrl({}, "no url here"), /Could not derive Worker URL/);
});

test("setup:all prerequisite package check accepts the published package name", async () => {
  const checks = await collectSetupAllPrerequisites(
    {
      cwd: "/tmp/repo",
      bootstrap: false,
    },
    {
      exists: (path) => path === "/tmp/repo/package.json",
      readTextFile: async () => JSON.stringify({ name: "codex-colab-bridge" }),
      runCommand: async () => ({ ok: true, code: 0 }),
      nodeVersion: "v20.0.0",
    },
  );

  assert.equal(checks.some((check) => check.status === "fail"), false);
  assert.ok(checks.some((check) => check.name === "package.json" && check.message.includes("codex-colab-bridge")));
});

test("setup:all prerequisite collection does not invoke Colab checks when bootstrap is disabled", async () => {
  const commands = [];
  await collectSetupAllPrerequisites(
    {
      cwd: "/tmp/repo",
      bootstrap: false,
    },
    {
      exists: (path) => path === "/tmp/repo/package.json",
      readTextFile: async () => JSON.stringify({ name: "codex-colab-bridge" }),
      runCommand: async (command) => {
        commands.push(command.join(" "));
        return { ok: true, code: 0 };
      },
      nodeVersion: "v20.0.0",
    },
  );

  assert.deepEqual(commands, ["npx --no-install wrangler --version"]);
});
