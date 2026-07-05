import test from "node:test";
import assert from "node:assert/strict";
import { BrokerError, SessionBroker } from "../src/broker.js";
import { verifyToken } from "../src/auth.js";
import { fixedAuth } from "./helpers.js";

test("invalid controller token cannot read status", () => {
  const broker = new SessionBroker();
  const session = broker.createSession();

  assert.throws(
    () => broker.getStatus(session.sessionId, fixedAuth("wrong-token", "bad-controller")),
    (error) => error instanceof BrokerError && error.bridgeError.code === "UNAUTHORIZED",
  );
});

test("nonce replay is rejected for controller requests", () => {
  const broker = new SessionBroker();
  const session = broker.createSession();
  const auth = fixedAuth(session.controllerToken, "same-nonce");

  broker.getStatus(session.sessionId, auth);

  assert.throws(
    () => broker.getStatus(session.sessionId, auth),
    (error) => error instanceof BrokerError && error.bridgeError.code === "REPLAY_DETECTED",
  );
});

test("stale auth timestamp is rejected", () => {
  const broker = new SessionBroker();
  const session = broker.createSession();

  assert.throws(
    () =>
      broker.getStatus(session.sessionId, {
        token: session.controllerToken,
        timestamp: new Date("2020-01-01T00:00:00.000Z").toISOString(),
        nonce: "stale",
      }),
    (error) => error instanceof BrokerError && error.bridgeError.code === "UNAUTHORIZED",
  );
});

test("repeated auth failures are rate limited", () => {
  const broker = new SessionBroker(undefined, undefined, {
    authFailureLimit: 2,
    authFailureWindowMs: 60_000,
  });
  const session = broker.createSession(new Date("2026-06-29T00:00:00.000Z"));
  const now = new Date("2026-06-29T00:00:01.000Z");

  for (const nonce of ["bad_1", "bad_2"]) {
    assert.throws(
      () =>
        broker.getStatus(
          session.sessionId,
          {
            token: "wrong-token",
            timestamp: now.toISOString(),
            nonce,
          },
          now,
        ),
      (error) => error instanceof BrokerError && error.bridgeError.code === "UNAUTHORIZED",
    );
  }

  assert.throws(
    () =>
      broker.getStatus(
        session.sessionId,
        {
          token: "wrong-token",
          timestamp: now.toISOString(),
          nonce: "bad_3",
        },
        now,
      ),
    (error) => error instanceof BrokerError && error.bridgeError.code === "RATE_LIMITED",
  );
});

test("legacy token hashes remain accepted for existing sessions", () => {
  const codexHash = "34acb5b1c9a7fd9ac1bb3f26a3a073959e9cb1e256830d4126f042e037e02c2f";
  const originalHash = "da4608d728ed65be9258ececf328786342c4ca1128f4c016f8cf104b8a94997b";

  assert.equal(verifyToken("br_legacy", codexHash), true);
  assert.equal(verifyToken("br_legacy", originalHash), true);
});
