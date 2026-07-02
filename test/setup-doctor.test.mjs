import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeBridgeConfig,
  parseLocalConfigShape,
  redactObject,
  redactSecret,
  unwrapSessionResponse,
  writeBridgeConfig,
} from "../scripts/local-bridge-common.mjs";
import {
  bootstrapCommandArgs,
  bootstrapEnv,
  bootstrapGuidanceLines,
  createBridgeSession,
  loadSetupOptions,
  setupSummaryLines,
} from "../scripts/setup-bridge.mjs";
import {
  collectDoctorChecks,
  formatDoctorCheck,
  formatDoctorJson,
  loadDoctorOptions,
  nodeVersionCheck,
} from "../scripts/doctor.mjs";
import {
  parseSmokeArgs,
  plannedSmokeTools,
} from "../scripts/smoke-mcp.mjs";

const session = {
  sessionId: "sess_test",
  controllerToken: "controller_secret",
  runnerToken: "runner_secret",
  expiresAt: "2026-06-28T20:00:00.000Z",
};

test("setup options accept URL/admin inputs and preserve existing dangerous-tool policy", async () => {
  const options = await loadSetupOptions({
    argv: ["--config", "bridge.json", "--bootstrap", "--colab-session", "named", "--gpu", "none"],
    env: {
      COLAB_MCP_BRIDGE_BASE_URL: "https://bridge.test/",
      COLAB_MCP_BRIDGE_ADMIN_SECRET: "admin_secret",
    },
    cwd: "/tmp/repo",
    exists: (path) => path === "/tmp/repo/bridge.json",
    readTextFile: async () =>
      JSON.stringify({
        session_id: "old_session",
        controller_token: "old_controller",
        enable_dangerous_tools: true,
      }),
  });

  assert.equal(options.baseUrl, "https://bridge.test");
  assert.equal(options.adminSecret, "admin_secret");
  assert.equal(options.configPath, "/tmp/repo/bridge.json");
  assert.equal(options.bootstrap, true);
  assert.equal(options.colabSession, "named");
  assert.equal(options.gpu, "none");
  assert.equal(options.enableDangerousTools, true);
});

test("setup config merge writes controller token but never persists runner token", () => {
  const config = mergeBridgeConfig(
    {
      worker_url: "https://old.test",
      workerUrl: "https://old-alias.test",
      baseUrl: "https://old-base.test",
      admin_secret: "old_admin",
      adminSecret: "old_admin_alias",
      controllerToken: "old_controller_alias",
      runner_token: "old_runner",
      runnerToken: "old_runner_alias",
      other_setting: "kept",
    },
    session,
    { baseUrl: "https://bridge.test", enableDangerousTools: false },
  );

  assert.deepEqual(config, {
    other_setting: "kept",
    base_url: "https://bridge.test",
    session_id: "sess_test",
    controller_token: "controller_secret",
    enable_dangerous_tools: false,
  });
  assert.equal("runner_token" in config, false);
  assert.equal("runnerToken" in config, false);
  assert.equal("admin_secret" in config, false);
  assert.equal("adminSecret" in config, false);
  assert.equal("controllerToken" in config, false);
  assert.equal("worker_url" in config, false);
  assert.equal("workerUrl" in config, false);
  assert.equal("baseUrl" in config, false);
});

test("setup config writer creates private config files", async () => {
  const calls = [];
  await writeBridgeConfig(
    "/tmp/config.json",
    { base_url: "https://bridge.test" },
    {
      makeDir: async (path, options) => {
        calls.push({ mkdir: path, options });
      },
      writeTextFile: async (path, text, options) => {
        calls.push({ path, text, options });
      },
      chmodFile: async (path, mode) => {
        calls.push({ path, chmod: mode });
      },
    },
  );

  assert.deepEqual(calls[0], { mkdir: "/tmp", options: { recursive: true, mode: 0o700 } });
  assert.deepEqual(calls[1].options, { mode: 0o600 });
  assert.deepEqual(calls[2], { path: "/tmp/config.json", chmod: 0o600 });
});

test("setup user-facing lines and bootstrap command guidance redact all secrets", () => {
  const options = {
    baseUrl: "https://bridge.test",
    adminSecret: "admin_secret",
    configPath: "/tmp/config.json",
    enableDangerousTools: false,
    colabSession: "named",
    projectRoot: "/content/project",
    passthrough: ["--quiet"],
  };

  const text = [
    ...setupSummaryLines(options, session),
    ...bootstrapGuidanceLines(options, session),
  ].join("\n");

  assert.match(text, /Admin secret: set \(redacted\)/);
  assert.match(text, /Controller token: set \(redacted\)/);
  assert.match(text, /Runner token: set \(redacted\)/);
  assert.doesNotMatch(text, /admin_secret/);
  assert.doesNotMatch(text, /controller_secret/);
  assert.doesNotMatch(text, /runner_secret/);
  assert.match(text, /COLAB_MCP_BRIDGE_RUNNER_TOKEN='<runner-token-redacted>'/);
});

test("bootstrap invocation passes runner token through env, not command arguments", () => {
  const options = {
    baseUrl: "https://bridge.test",
    colabSession: "named",
    gpu: "T4",
    projectRoot: "/content/project",
    colabConfig: "/tmp/colab.json",
    passthrough: ["--quiet"],
  };
  const command = bootstrapCommandArgs(options);
  const env = bootstrapEnv(options, session, {});

  assert.deepEqual(command, [
    "scripts/bootstrap-colab.mjs",
    "--colab-session",
    "named",
    "--gpu",
    "T4",
    "--project-root",
    "/content/project",
    "--colab-config",
    "/tmp/colab.json",
    "--",
    "--quiet",
  ]);
  assert.equal(command.includes("runner_secret"), false);
  assert.equal(env.COLAB_MCP_BRIDGE_RUNNER_TOKEN, "runner_secret");
  assert.equal(env.COLAB_MCP_BRIDGE_CONTROLLER_TOKEN, "controller_secret");
});

test("createBridgeSession unwraps Worker envelopes without printing or persisting tokens", async () => {
  const created = await createBridgeSession(
    { baseUrl: "https://bridge.test", adminSecret: "admin_secret" },
    {
      fetchFn: async (url, init) => {
        assert.equal(url, "https://bridge.test/v1/sessions");
        assert.equal(init.headers.Authorization, "Bearer admin_secret");
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              session_id: "sess_test",
              controller_token: "controller_secret",
              runner_token: "runner_secret",
              expires_at: "2026-06-28T20:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      },
    },
  );

  assert.deepEqual(created, session);
  assert.deepEqual(unwrapSessionResponse({ data: created }), session);
});

test("createBridgeSession redacts sensitive fields from failure details", async () => {
  await assert.rejects(
    () =>
      createBridgeSession(
        { baseUrl: "https://bridge.test", adminSecret: "admin_secret" },
        {
          fetchFn: async () =>
            new Response(
              JSON.stringify({
                error: {
                  adminSecret: "admin_secret",
                  controller_token: "controller_secret",
                  runner_token: "runner_secret",
                },
              }),
              { status: 500 },
            ),
        },
      ),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.doesNotMatch(error.message, /admin_secret/);
      assert.doesNotMatch(error.message, /controller_secret/);
      assert.doesNotMatch(error.message, /runner_secret/);
      assert.match(error.message, /set \(redacted\)/);
      return true;
    },
  );
});

test("redaction helpers sanitize token, secret, and authorization fields", () => {
  assert.equal(redactSecret("admin_secret"), "set (redacted)");
  assert.equal(redactSecret(""), "unset");
  assert.deepEqual(redactObject({
    controller_token: "controller_secret",
    adminSecret: "admin_secret",
    nested: { Authorization: "Bearer token" },
    keep: "visible",
  }), {
    controller_token: "set (redacted)",
    adminSecret: "set (redacted)",
    nested: { Authorization: "set (redacted)" },
    keep: "visible",
  });
});

test("doctor pure checks classify node versions and config shape", () => {
  assert.equal(nodeVersionCheck("v20.0.0").status, "pass");
  assert.equal(nodeVersionCheck("v18.19.0").status, "fail");
  assert.deepEqual(parseLocalConfigShape({
    worker_url: "https://bridge.test/",
    session_id: "sess_test",
    controller_token: "controller_secret",
    enable_dangerous_tools: "yes",
  }), {
    baseUrl: "https://bridge.test",
    sessionId: "sess_test",
    controllerToken: "controller_secret",
    enableDangerousTools: true,
  });
});

test("doctor collection stays offline with injected command and fetch helpers", async () => {
  const commandCalls = [];
  const fetchCalls = [];
  const files = new Map([
    ["/tmp/repo/package.json", JSON.stringify({ name: "agent-colab-bridge" })],
    ["/tmp/repo/node_modules", ""],
    [
      "/tmp/repo/config.json",
      JSON.stringify({
        base_url: "https://bridge.test",
        session_id: "sess_test",
        controller_token: "controller_secret",
      }),
    ],
  ]);
  const checks = await collectDoctorChecks(
    {
      configPath: "/tmp/repo/config.json",
      cwd: "/tmp/repo",
      skipNetwork: false,
      requireNetwork: true,
    },
    {
      exists: (path) => files.has(path),
      readTextFile: async (path) => files.get(path),
      runCommand: async (command) => {
        commandCalls.push(command.join(" "));
        return { ok: true, code: 0 };
      },
      fetchFn: async (url, init = {}) => {
        fetchCalls.push({ url, headers: init.headers ?? {} });
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ ok: true, data: { status: "ok" } }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ ok: true, data: { runner_connected: false } }),
          { status: 200 },
        );
      },
    },
  );

  assert.ok(commandCalls.some((command) => command.startsWith("uvx --version")));
  assert.ok(fetchCalls.some((call) => call.url === "https://bridge.test/health"));
  assert.ok(fetchCalls.some((call) => call.headers.Authorization === "Bearer controller_secret"));
  assert.equal(checks.some((check) => check.status === "fail"), false);
  const formatted = checks.map(formatDoctorCheck).join("\n");
  assert.match(formatted, /PASS local config:/);
  assert.doesNotMatch(formatted, /controller_secret/);
});

test("doctor JSON output is parseable and summarizes checks", () => {
  const options = loadDoctorOptions({
    argv: ["--json", "--config", "bridge.json", "--base-url", "https://bridge.test/", "--skip-network"],
    env: {},
    cwd: "/tmp/repo",
  });
  assert.equal(options.json, true);
  assert.equal(options.configPath, "/tmp/repo/bridge.json");
  assert.equal(options.baseUrl, "https://bridge.test");
  assert.equal(options.skipNetwork, true);

  const json = formatDoctorJson([
    { status: "pass", name: "node", message: "Node is supported." },
    { status: "warn", name: "local config", message: "No local MCP config found." },
    { status: "fail", name: "worker health", message: "Worker health failed." },
  ]);
  const parsed = JSON.parse(json);

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.summary, { pass: 1, warn: 1, fail: 1 });
  assert.deepEqual(parsed.checks[0], {
    status: "pass",
    name: "node",
    message: "Node is supported.",
  });
});

test("MCP smoke planning keeps dangerous tool opt-in", () => {
  assert.deepEqual(plannedSmokeTools({}), ["colab_status", "colab_gpu_status"]);
  assert.deepEqual(plannedSmokeTools({ dangerous: true }), [
    "colab_status",
    "colab_gpu_status",
    "colab_run_shell",
  ]);
  assert.deepEqual(plannedSmokeTools(parseSmokeArgs(["--dangerous", "--skip-gpu"])), [
    "colab_status",
    "colab_run_shell",
  ]);
});
