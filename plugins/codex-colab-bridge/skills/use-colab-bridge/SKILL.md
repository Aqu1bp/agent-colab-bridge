---
name: "use-colab-bridge"
description: "Use when the user asks Codex to run work on Google Colab, use a Colab GPU, train/evaluate models remotely, inspect Colab GPU status, or manage long-running Colab jobs through the Codex Colab Bridge MCP tools."
---

# Use Colab Bridge

Use the Codex Colab Bridge tools only for Colab runtimes the user controls. The bridge gives Codex remote code execution inside the Colab VM, so treat shell, Python, file-write, job-start, and interrupt tools as dangerous.

## Safety Rules

- Never print, request, or persist admin, controller, or runner token values in chat or repo files.
- Before running commands, call `colab_status`. If the runner is offline, tell the user to run the setup or reconnect flow.
- Prefer `colab_gpu_status` for GPU inspection instead of ad hoc `nvidia-smi` unless more detail is needed.
- Use `colab_run_shell` or `colab_run_python` only for short foreground checks.
- Use `colab_start_job`, `colab_tail_job`, and `colab_interrupt_job` for long training/eval jobs.
- Keep generated files under `/content/project` unless the user explicitly asks for another location.
- Do not move datasets, checkpoints, or large logs through Cloudflare or MCP file tools. Use Google Drive, GCS, Hugging Face Hub, GitHub Releases, or `google-colab-cli upload/download`.
- Assume Colab VM deletion loses active processes and runner-owned job/log state.

## Typical Flow

1. Call `colab_status`.
2. Call `colab_gpu_status` if GPU availability matters.
3. For short checks, call `colab_run_shell` with tight timeout and output caps.
4. For longer work, write or upload scripts, then call `colab_start_job`.
5. Tail logs with `colab_tail_job` using cursors instead of repeatedly dumping full logs.
6. Interrupt with `colab_interrupt_job` only when the user asks or the job is clearly runaway.

## Offline Runner

If `colab_status` says the runner is offline and the session was already
started by this repo's bootstrap, ask the user to reconnect the runner first:

```bash
uvx --from google-colab-cli colab exec -s codex-colab-bridge -f scripts/colab-reconnect-runner.py
```

If the bridge session, local config, or Worker deployment should be recreated,
ask the user to rerun setup:

```bash
npm run setup:all -- --smoke
```

Do not try to recover runner tokens from logs or chat.
