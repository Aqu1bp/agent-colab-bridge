import { type AuthAttempt } from "./auth.js";
import {
  SessionBroker,
  type RunnerMetadata,
} from "./broker.js";
import { type CommandEnvelope, type ResultEnvelope } from "./protocol.js";

export interface RunnerTransport {
  sendCommand(envelope: CommandEnvelope): Promise<ResultEnvelope> | ResultEnvelope;
}

export interface RunnerConnectionInput {
  broker: SessionBroker;
  sessionId: string;
  auth: AuthAttempt;
  metadata: RunnerMetadata;
  transport: RunnerTransport;
  now?: Date;
}

export class RunnerConnection {
  constructor(private readonly input: RunnerConnectionInput) {}

  attach(): void {
    this.input.broker.attachRunner(
      this.input.sessionId,
      this.input.auth,
      this.input.metadata,
      (envelope) => this.input.transport.sendCommand(envelope),
      this.input.now,
    );
  }
}

export class InMemoryRunnerTransport implements RunnerTransport {
  constructor(
    private readonly handler: (envelope: CommandEnvelope) => Promise<ResultEnvelope> | ResultEnvelope,
  ) {}

  sendCommand(envelope: CommandEnvelope): Promise<ResultEnvelope> | ResultEnvelope {
    return this.handler(envelope);
  }
}
