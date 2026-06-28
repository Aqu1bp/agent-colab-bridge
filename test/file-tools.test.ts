import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBroker } from "../src/broker.js";
import { FakeRunner } from "../src/fake-runner.js";
import { MAX_FILE_CONTENT_BYTES, MAX_READ_FILE_BYTES } from "../src/protocol.js";
import { authFactory } from "./helpers.js";

async function createFileHarness(): Promise<{
  broker: SessionBroker;
  session: ReturnType<SessionBroker["createSession"]>;
  controllerAuth: ReturnType<typeof authFactory>;
  projectRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "colab-mcp-file-tools-"));
  const broker = new SessionBroker();
  const session = broker.createSession();
  const controllerAuth = authFactory(session.controllerToken, "controller_file");
  const runnerAuth = authFactory(session.runnerToken, "runner_file");
  new FakeRunner(broker, session.sessionId, runnerAuth, { projectRoot }).attach();

  return { broker, session, controllerAuth, projectRoot };
}

test("fake runner write_file and read_file round trip UTF-8 text", async () => {
  const harness = await createFileHarness();
  try {
    await mkdir(join(harness.projectRoot, "src"));

    const write = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "write_file",
      payload: { path: "src/hello.txt", content: "hello", mode: "overwrite" },
    });
    const writeResult = write.resultPayload as {
      path: string;
      bytes_written: number;
      mode: string;
    };

    assert.equal(write.state, "succeeded");
    assert.deepEqual(writeResult, {
      path: "src/hello.txt",
      bytes_written: 5,
      mode: "overwrite",
    });

    const read = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "read_file",
      payload: { path: "src/hello.txt" },
    });
    const readResult = read.resultPayload as {
      path: string;
      content: string;
      bytes_read: number;
      truncated: boolean;
    };

    assert.equal(read.state, "succeeded");
    assert.deepEqual(readResult, {
      path: "src/hello.txt",
      content: "hello",
      bytes_read: 5,
      truncated: false,
    });
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner rejects absolute paths, traversal, symlink targets, and symlink parents", async () => {
  const harness = await createFileHarness();
  try {
    await writeFile(join(harness.projectRoot, "real.txt"), "real", "utf8");
    await symlink("real.txt", join(harness.projectRoot, "link.txt"));
    await symlink(".", join(harness.projectRoot, "parent-link"));

    const absolute = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "read_file",
      payload: { path: "/etc/passwd" },
    });
    assert.equal(absolute.state, "failed");
    assert.equal(absolute.error?.code, "FORBIDDEN_PATH");

    const traversal = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "read_file",
      payload: { path: "../real.txt" },
    });
    assert.equal(traversal.state, "failed");
    assert.equal(traversal.error?.code, "FORBIDDEN_PATH");

    const symlinkRead = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "read_file",
      payload: { path: "link.txt" },
    });
    assert.equal(symlinkRead.state, "failed");
    assert.equal(symlinkRead.error?.code, "FORBIDDEN_PATH");

    const symlinkWrite = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "write_file",
      payload: { path: "link.txt", content: "replace", mode: "overwrite" },
    });
    assert.equal(symlinkWrite.state, "failed");
    assert.equal(symlinkWrite.error?.code, "FORBIDDEN_PATH");
    assert.equal(await readFile(join(harness.projectRoot, "real.txt"), "utf8"), "real");

    const symlinkCreateNew = await harness.broker.createCommand(
      harness.session.sessionId,
      harness.controllerAuth(),
      {
        type: "write_file",
        payload: { path: "link.txt", content: "replace", mode: "create_new" },
      },
    );
    assert.equal(symlinkCreateNew.state, "failed");
    assert.equal(symlinkCreateNew.error?.code, "FORBIDDEN_PATH");
    assert.equal(await readFile(join(harness.projectRoot, "real.txt"), "utf8"), "real");

    const symlinkParent = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "read_file",
      payload: { path: "parent-link/real.txt" },
    });
    assert.equal(symlinkParent.state, "failed");
    assert.equal(symlinkParent.error?.code, "FORBIDDEN_PATH");
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner create_new fails without overwriting existing files", async () => {
  const harness = await createFileHarness();
  try {
    const first = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "write_file",
      payload: { path: "config.txt", content: "first", mode: "create_new" },
    });
    assert.equal(first.state, "succeeded");

    const second = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "write_file",
      payload: { path: "config.txt", content: "second", mode: "create_new" },
    });
    assert.equal(second.state, "failed");
    assert.equal(second.error?.code, "INVALID_ARGUMENT");
    assert.equal(await readFile(join(harness.projectRoot, "config.txt"), "utf8"), "first");
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner append requires a regular file and appends text", async () => {
  const harness = await createFileHarness();
  try {
    await writeFile(join(harness.projectRoot, "notes.txt"), "hello", "utf8");

    const append = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "write_file",
      payload: { path: "notes.txt", content: " world", mode: "append" },
    });

    assert.equal(append.state, "succeeded");
    assert.equal(await readFile(join(harness.projectRoot, "notes.txt"), "utf8"), "hello world");
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner read_file returns truncation metadata", async () => {
  const harness = await createFileHarness();
  try {
    await writeFile(join(harness.projectRoot, "log.txt"), "abcdef", "utf8");

    const read = await harness.broker.createCommand(harness.session.sessionId, harness.controllerAuth(), {
      type: "read_file",
      payload: { path: "log.txt", max_bytes: 3 },
    });
    const result = read.resultPayload as {
      path: string;
      content: string;
      bytes_read: number;
      truncated: boolean;
    };

    assert.equal(read.state, "succeeded");
    assert.deepEqual(result, {
      path: "log.txt",
      content: "abc",
      bytes_read: 3,
      truncated: true,
    });
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});

test("fake runner enforces write and read size caps", async () => {
  const harness = await createFileHarness();
  try {
    const oversizedWrite = await harness.broker.createCommand(
      harness.session.sessionId,
      harness.controllerAuth(),
      {
        type: "write_file",
        payload: {
          path: "too-large.txt",
          content: "a".repeat(MAX_FILE_CONTENT_BYTES + 1),
          mode: "overwrite",
        },
      },
    );
    assert.equal(oversizedWrite.state, "failed");
    assert.equal(oversizedWrite.error?.code, "INVALID_ARGUMENT");

    await writeFile(join(harness.projectRoot, "small.txt"), "small", "utf8");
    const oversizedRead = await harness.broker.createCommand(
      harness.session.sessionId,
      harness.controllerAuth(),
      {
        type: "read_file",
        payload: { path: "small.txt", max_bytes: MAX_READ_FILE_BYTES + 1 },
      },
    );
    assert.equal(oversizedRead.state, "failed");
    assert.equal(oversizedRead.error?.code, "INVALID_ARGUMENT");
  } finally {
    await rm(harness.projectRoot, { recursive: true, force: true });
  }
});
