# Security Policy

## Remote Code Execution Warning

`codex-colab-bridge` can execute code in a user-controlled Colab VM. Dangerous
tools such as shell execution, Python execution, file writes, background job
start, and job interrupt must be enabled intentionally. Do not enable them for a
runtime that contains secrets or mounted storage you would not allow remote
commands to access.

## Supported Versions

This repository is pre-release. Until the first stable release, security fixes
are expected to land on the default branch.

## Reporting A Vulnerability

Report suspected vulnerabilities privately to the repository maintainers. Do not
open a public issue with exploitable details, real tokens, session IDs, Worker
URLs, account identifiers, or notebook output containing secrets.

Please include:

- Affected commit or version.
- Impact and prerequisites.
- Minimal reproduction steps using placeholder tokens and URLs.
- Whether the issue exposed credentials, command execution, logs, or artifacts.

## Operator Guidance

- Keep admin, controller, runner, cloud, notebook, and model-registry tokens
  private.
- Prefer short-lived and least-privilege credentials.
- Revoke bridge sessions after use or after suspicious activity.
- Do not mount Google Drive unless the active run requires it.
- Do not transfer large artifacts, checkpoints, datasets, or package caches
  through Cloudflare.
- Rotate any token that may have been visible to Colab code or logs.
