import { createResultEnvelope, type CommandEnvelope, type ResultEnvelope } from "./protocol.js";
import { type AuthAttempt } from "./auth.js";
import { type SessionBroker } from "./broker.js";

export interface FakeRunnerOptions {
  runnerInstanceId?: string;
  kernelStartedAt?: string;
  runnerStartedAt?: string;
}

export class FakeRunner {
  readonly runnerInstanceId: string;
  readonly kernelStartedAt: string;
  readonly runnerStartedAt: string;

  constructor(
    private readonly broker: SessionBroker,
    private readonly sessionId: string,
    private readonly runnerAuthFactory: () => AuthAttempt,
    options: FakeRunnerOptions = {},
  ) {
    this.runnerInstanceId = options.runnerInstanceId ?? "runner_fake";
    this.kernelStartedAt = options.kernelStartedAt ?? new Date("2026-06-28T10:00:00.000Z").toISOString();
    this.runnerStartedAt = options.runnerStartedAt ?? new Date("2026-06-28T10:00:01.000Z").toISOString();
  }

  attach(now = new Date()): void {
    this.broker.attachRunner(
      this.sessionId,
      this.runnerAuthFactory(),
      {
        runnerInstanceId: this.runnerInstanceId,
        kernelStartedAt: this.kernelStartedAt,
        runnerStartedAt: this.runnerStartedAt,
      },
      (envelope) => this.handle(envelope),
      now,
    );
  }

  async handle(envelope: CommandEnvelope): Promise<ResultEnvelope> {
    this.broker.acknowledgeCommand(this.sessionId, this.runnerAuthFactory(), envelope.command_id);

    if (envelope.type === "ping") {
      return createResultEnvelope({
        command: envelope,
        ok: true,
        payload: { ok: true, pong: true },
      });
    }

    return createResultEnvelope({
      command: envelope,
      ok: true,
      payload: {
        session_id: this.sessionId,
        runner_connected: true,
        runner_instance_id: this.runnerInstanceId,
        kernel_started_at: this.kernelStartedAt,
        runner_started_at: this.runnerStartedAt,
      },
    });
  }
}
