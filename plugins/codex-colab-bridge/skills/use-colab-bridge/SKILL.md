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
- Python child processes default to `PYTHONUNBUFFERED=1`; still prefer `python -u ...` or `flush=True` when model progress logs must appear immediately.
- Keep generated files under `/content/project` unless the user explicitly asks for another location.
- Do not move datasets, checkpoints, or large logs through Cloudflare or MCP file tools. Use Google Drive, GCS, Hugging Face Hub, GitHub Releases, or `google-colab-cli upload/download`.
- Assume Colab VM deletion loses active processes and runner-owned job/log state.
- Do not try to change GPU type from inside the runner. Runtime settings require recreating the Colab runtime, which is destructive.

## Typical Flow

1. Call `colab_status`.
2. Call `colab_gpu_status` if GPU availability matters.
3. For short checks, call `colab_run_shell` with tight timeout and output caps.
4. For longer work, write or upload scripts, then call `colab_start_job`.
5. Tail logs with `colab_tail_job` using cursors instead of repeatedly dumping full logs.
6. Interrupt with `colab_interrupt_job` only when the user asks or the job is clearly runaway.

## Offline Runner

If `colab_status` says the runner is offline and the session was already
started by this repo's bootstrap, call `colab_reconnect_runner` as the safe
first recovery step. Then call `colab_status` again.

`colab_reconnect_runner` does not need the runner token locally and does not
depend on the offline runner. It runs `google-colab-cli` locally, reads the old
runner process environment inside the Colab VM, and starts a fresh runner
process. It only works if the Colab VM and old runner process environment still
exist.

If reconnect fails because the pid file, runner process, or process environment
is gone, recreate/bootstrap instead:

```bash
npm run setup:all -- --bootstrap --smoke
```

Use `npm run runtime:recreate -- --gpu <GPU|none> --yes --smoke` when the runtime
itself should be recreated or the accelerator should change.

Do not try to recover runner tokens from logs or chat.

## Runtime Settings

Changing GPU type, switching to CPU, or otherwise changing Colab runtime
settings is a local provisioning task, not an MCP runner command. From a source
checkout, use:

```bash
npm run runtime:recreate -- --gpu L4 --yes --smoke
```

To inspect supported accelerator candidates first, use:

```bash
npm run runtime:options
```

Treat that output as supported candidates from the installed Colab CLI, not a
live capacity or account-quota guarantee. Real availability is confirmed only
when Colab creates or recreates the runtime.

Use `--gpu none` for CPU. This stops the named Colab session unless
`--skip-stop` is passed, creates a fresh bridge session, bootstraps the runner,
and rewrites the local MCP config. Confirm with the user before running it,
because active Colab jobs, loaded models, temporary files outside durable
storage, and runner-owned job/log state are lost.
