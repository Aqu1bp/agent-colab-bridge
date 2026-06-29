# Contributing

Thanks for helping improve `codex-colab-bridge`.

## Development

Use Node.js 20 or newer.

```bash
npm ci
npm run build
npm test
```

Before opening a pull request, also run:

```bash
npm audit --audit-level=low
npm pack --dry-run
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
