# Contributing

Thanks for helping improve `agent-colab-bridge`.

## Development

Use Node.js 20 or newer and Python 3. CI pins Python 3.12 for the local runner
tests, so use Python 3.12 when you want the closest local match.

```bash
npm ci
npm run build
npm test
npm run package:plugin
```

The committed `plugins/agent-colab-bridge` directory is generated from source.
Do not edit it by hand; `npm test` runs the plugin packaging drift guard and
fails if `npm run package:plugin` would change the current generated payload.

Before opening a pull request, also run:

```bash
npm audit --audit-level=low
npm run check:package
```

Do not commit real Worker URLs, Cloudflare account identifiers, bridge session IDs,
admin secrets, controller tokens, runner tokens, Colab notebook output, local MCP
config, `.env` files, or generated caches.

## Security-Sensitive Changes

This project can enable remote code execution inside a user-controlled Colab VM.
Changes to authentication, authorization, command execution, file access, logging,
redaction, or setup flows should include tests that show the unsafe path fails
closed.

Report vulnerabilities privately through GitHub Security Advisories rather than
opening a public issue with exploitable details.
