# Agent Guidance

Use the Colab Bridge MCP tools only with Colab runtimes the user controls. The
bridge can perform remote code execution inside the Colab VM.

Start with local, safe checks:

- Call `colab_doctor` when local prerequisites, config shape, or network access
  are uncertain.
- Call `colab_get_config_summary` before assuming bridge configuration exists.
  It is local-only and redacts token values.
- Call `colab_setup_bridge` only after explicit user intent to set up the
  bridge. Set `confirm_remote_code_execution` only when the user accepts that
  setup enables code execution in Colab.
- Call `colab_reconnect_runner` when config exists but the runner is offline.
  It is the safe first recovery step before recreating a runtime.

Dangerous tools are remote code execution and are disabled until explicitly
enabled in both local policy and the Worker environment. Treat
`colab_run_shell`, `colab_run_python`, `colab_write_file`, `colab_start_job`,
and `colab_interrupt_job` as dangerous. Do not enable or use them without clear
user intent and a trusted Colab runtime.

Never print, request, or commit admin, controller, or runner token values. Keep
generated work under `/content/project` unless the user asks for another path.
Use `colab_upload_file` and `colab_download_file`, direct
`google-colab-cli upload/download`, Google Drive, GCS, Hugging Face Hub, or
GitHub Releases for large artifacts instead of moving them through Cloudflare.
