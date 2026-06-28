export class RunnerConnection {
    input;
    constructor(input) {
        this.input = input;
    }
    attach() {
        this.input.broker.attachRunner(this.input.sessionId, this.input.auth, this.input.metadata, (envelope) => this.input.transport.sendCommand(envelope), this.input.now);
    }
}
export class InMemoryRunnerTransport {
    handler;
    constructor(handler) {
        this.handler = handler;
    }
    sendCommand(envelope) {
        return this.handler(envelope);
    }
}
