import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBroker } from "../src/broker.js";
import { FakeRunner } from "../src/fake-runner.js";
import { type CommandRow } from "../src/protocol.js";
import { authFactory } from "./helpers.js";

async function createJobHarness(): Promise<{
  broker: SessionBroker;
  session: ReturnType<SessionBroker["createSession"]>;
  controllerAuth: ReturnType<typeof authFactory>;
  projectRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "colab-mcp-background-jobs-"));
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller_job");
  const runnerAuth = authFactory(session.runnerToken, "runner_job");
  new FakeRunner(broker, session.sessionId, runnerAuth, { projectRoot }).attach();

  return { broker, session, controllerAuth, projectRoot };
}

test("fake runner starts a background job and tails logs incrementally", async () => {
  const harness = await createJobHarness();
  try {
    const script = "console.log('first'); setTimeout(() => console.log('second'), 80);";
    const start = await createJobCommand(harness, "start_job", {
      command: nodeCommand(script),
    });
    const startResult = start.resultPayload as { job_id: string; status: string };

    assert.equal(start.state, "succeeded");
    assert.equal(startResult.status, "running");

    const firstTail = await waitForTail(harness, startResult.job_id, 0, (result) =>
      result.events.some((event) => event.text.includes("first")),
    );
    assert.equal(firstTail.state, "succeeded");
    const firstPayload = firstTail.resultPayload as TailPayload;
    assert.equal(firstPayload.events.some((event) => event.text.includes("first")), true);

    const secondTail = await waitForTail(harness, startResult.job_id, firstPayload.next_cursor, (result) =>
      result.events.some((event) => event.text.includes("second")),
    );
    const secondPayload = secondTail.resultPayload as TailPayload;
    assert.equal(secondPayload.events.some((event) => event.text.includes("first")), false);
    assert.equal(secondPayload.events.some((event) => event.text.includes("second")), true);

    const finalTail = await waitForTail(harness, startResult.job_id, 0, (result) => result.status === "exited");
    const finalPayload = finalTail.resultPayload as TailPayload;
    assert.equal(finalPayload.status, "exited");
    assert.equal(finalPayload.exit_code, 0);
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner background jobs inherit unbuffered Python environment", async () => {
  const harness = await createJobHarness();
  try {
    const start = await createJobCommand(harness, "start_job", {
      command: nodeCommand("console.log(process.env.PYTHONUNBUFFERED)"),
    });
    const startResult = start.resultPayload as { job_id: string; status: string };

    assert.equal(start.state, "succeeded");
    assert.equal(startResult.status, "running");

    const tail = await waitForTail(harness, startResult.job_id, 0, (result) =>
      result.events.some((event) => event.text.includes("1")),
    );
    const payload = tail.resultPayload as TailPayload;
    assert.equal(payload.events.some((event) => event.text.includes("1")), true);
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner lists job summaries without log text", async () => {
  const harness = await createJobHarness();
  let jobId: string | null = null;
  try {
    const start = await createJobCommand(harness, "start_job", {
      command: nodeCommand("console.log('secret-log-text'); setInterval(() => {}, 1000);"),
      name: "summary-job",
    });
    const startResult = start.resultPayload as { job_id: string; status: string };
    jobId = startResult.job_id;
    assert.equal(start.state, "succeeded");

    await waitForTail(harness, startResult.job_id, 0, (result) =>
      result.events.some((event) => event.text.includes("secret-log-text")),
    );

    const list = await createJobCommand(harness, "list_jobs", {});
    const listPayload = list.resultPayload as { jobs: JobSummary[] };
    assert.equal(list.state, "succeeded");
    assert.equal(listPayload.jobs.length, 1);
    assertJobSummary(listPayload.jobs[0], {
      jobId: startResult.job_id,
      status: "running",
      active: true,
      name: "summary-job",
    });

    const status = await createJobCommand(harness, "job_status", {
      job_id: startResult.job_id,
    });
    assert.equal(status.state, "succeeded");
    assertJobSummary(status.resultPayload as JobSummary, {
      jobId: startResult.job_id,
      status: "running",
      active: true,
      name: "summary-job",
    });

    assert.equal(JSON.stringify(list.resultPayload).includes("secret-log-text"), false);
    assert.equal(JSON.stringify(status.resultPayload).includes("secret-log-text"), false);
    assert.equal("events" in (status.resultPayload as Record<string, unknown>), false);

    const missing = await createJobCommand(harness, "job_status", {
      job_id: "job_missing",
    });
    assert.equal(missing.state, "failed");
    assert.equal(missing.error?.code, "JOB_NOT_FOUND");
    assert.deepEqual(missing.resultPayload, { job_id: "job_missing" });
  } finally {
    if (jobId) {
      await createJobCommand(harness, "interrupt_job", {
        job_id: jobId,
        signal: "SIGKILL",
        kill_after_sec: 0,
      });
    }
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner rejects a second active background job", async () => {
  const harness = await createJobHarness();
  try {
    const start = await createJobCommand(harness, "start_job", {
      command: nodeCommand("setInterval(() => {}, 1000);"),
    });
    const startResult = start.resultPayload as { job_id: string };
    assert.equal(start.state, "succeeded");

    const duplicate = await createJobCommand(harness, "start_job", {
      command: nodeCommand("console.log('nope')"),
    });
    assert.equal(duplicate.state, "failed");
    assert.equal(duplicate.error?.code, "JOB_ALREADY_RUNNING");
    assert.deepEqual(duplicate.resultPayload, { job_id: startResult.job_id });

    await createJobCommand(harness, "interrupt_job", {
      job_id: startResult.job_id,
      signal: "SIGKILL",
      kill_after_sec: 0,
    });
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner interrupts a long-running background job", async () => {
  const harness = await createJobHarness();
  try {
    const start = await createJobCommand(harness, "start_job", {
      command: nodeCommand("setInterval(() => console.log('tick'), 50);"),
    });
    const startResult = start.resultPayload as { job_id: string };

    await waitForTail(harness, startResult.job_id, 0, (result) =>
      result.events.some((event) => event.text.includes("tick")),
    );

    const interrupt = await createJobCommand(harness, "interrupt_job", {
      job_id: startResult.job_id,
      signal: "SIGKILL",
      kill_after_sec: 0,
    });
    const result = interrupt.resultPayload as {
      job_id: string;
      status: string;
      exit_code: number | null;
      interrupted_at: string;
    };

    assert.equal(interrupt.state, "succeeded");
    assert.equal(result.job_id, startResult.job_id);
    assert.equal(result.status, "interrupted");
    assert.equal(typeof result.interrupted_at, "string");
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner expires old cursors when the job log ring compacts", async () => {
  const harness = await createJobHarness();
  try {
    const start = await createJobCommand(harness, "start_job", {
      command: nodeCommand("for (let i = 0; i < 80; i++) console.log('line-' + i.toString().padStart(2, '0'));"),
      max_log_bytes: 128,
    });
    const startResult = start.resultPayload as { job_id: string };

    await sleep(200);
    const expired = await createJobCommand(harness, "tail_job", {
      job_id: startResult.job_id,
      cursor: 0,
      max_bytes: 1024,
    });

    assert.equal(expired.state, "failed");
    assert.equal(expired.error?.code, "CURSOR_EXPIRED");
    assert.equal(typeof (expired.resultPayload as { oldest_cursor?: unknown }).oldest_cursor, "number");
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

type JobHarness = Awaited<ReturnType<typeof createJobHarness>>;

interface TailPayload {
  job_id: string;
  status: string;
  next_cursor: number;
  events: Array<{ cursor: number; stream: string; text: string; at: string }>;
  truncated: boolean;
  exit_code: number | null;
}

interface JobSummary {
  job_id: string;
  status: string;
  started_at: string;
  exit_code: number | null;
  interrupted_at: string | null;
  active: boolean;
  name?: string;
}

async function createJobCommand(
  harness: JobHarness,
  type: "start_job" | "list_jobs" | "job_status" | "tail_job" | "interrupt_job",
  payload: unknown,
): Promise<CommandRow> {
  return harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
    type,
    payload,
  });
}

function assertJobSummary(
  summary: JobSummary | undefined,
  expected: { jobId: string; status: string; active: boolean; name?: string },
): void {
  assert.ok(summary);
  assert.equal(summary.job_id, expected.jobId);
  assert.equal(summary.status, expected.status);
  assert.equal(typeof summary.started_at, "string");
  assert.equal(summary.exit_code, null);
  assert.equal(summary.interrupted_at, null);
  assert.equal(summary.active, expected.active);
  assert.equal(summary.name, expected.name);
  assert.equal("events" in summary, false);
  assert.equal("stdout" in summary, false);
  assert.equal("stderr" in summary, false);
  assert.equal("text" in summary, false);
}

async function waitForTail(
  harness: JobHarness,
  jobId: string,
  cursor: number,
  predicate: (payload: TailPayload) => boolean,
): Promise<CommandRow> {
  const deadline = Date.now() + 2500;
  let last: CommandRow | null = null;
  while (Date.now() < deadline) {
    last = await createJobCommand(harness, "tail_job", {
      job_id: jobId,
      cursor,
      max_bytes: 4096,
    });
    if (last.state === "succeeded" && predicate(last.resultPayload as TailPayload)) {
      return last;
    }
    await sleep(25);
  }

  assert.fail(`Timed out waiting for tail payload; last=${JSON.stringify(last?.resultPayload)}`);
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
