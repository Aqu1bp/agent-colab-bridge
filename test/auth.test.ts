import test from "node:test";
import assert from "node:assert/strict";
import { BrokerError, SessionBroker } from "../src/broker.js";
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
