"""Reconnect a Colab runner after a Worker deploy.

Run this through google-colab-cli against an existing Colab session:

    uvx --from google-colab-cli colab exec -s agent-colab-bridge -f scripts/colab-reconnect-runner.py

It reads the bridge environment from the previously started runner process,
terminates that process if it still exists, and starts a fresh runner process.
No token values are printed.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(os.environ.get("COLAB_BRIDGE_PROJECT_ROOT", "/content/project"))
PID_PATH = PROJECT_ROOT / ".colab_mcp_runner.pid"
RUNNER_PATH = PROJECT_ROOT / "colab_runner.py"
LOG_PATH = PROJECT_ROOT / "colab_mcp_runner.log"
BRIDGE_ENV_KEYS = {
    "COLAB_BRIDGE_URL",
    "COLAB_BRIDGE_SESSION_ID",
    "COLAB_BRIDGE_RUNNER_TOKEN",
    "COLAB_BRIDGE_PROJECT_ROOT",
}


def read_runner_env() -> dict[str, str]:
    if not PID_PATH.exists():
        raise RuntimeError(f"Runner pid file is missing: {PID_PATH}")

    pid_text = PID_PATH.read_text(encoding="utf-8").strip()
    if not pid_text.isdecimal():
        raise RuntimeError(f"Runner pid file is invalid: {PID_PATH}")

    env_path = Path("/proc") / pid_text / "environ"
    raw = env_path.read_bytes()
    values: dict[str, str] = {}
    for item in raw.split(b"\0"):
        key, separator, value = item.partition(b"=")
        if not separator:
            continue
        decoded_key = key.decode("utf-8", errors="replace")
        if decoded_key in BRIDGE_ENV_KEYS:
            values[decoded_key] = value.decode("utf-8", errors="replace")

    missing = sorted(BRIDGE_ENV_KEYS - set(values))
    if missing:
        raise RuntimeError(f"Runner process environment is missing: {', '.join(missing)}")
    return values


def stop_existing_runner() -> None:
    if not PID_PATH.exists():
        return
    pid_text = PID_PATH.read_text(encoding="utf-8").strip()
    if not pid_text.isdecimal():
        return
    pid = int(pid_text)
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        os.kill(pid, signal.SIGTERM)


def start_runner(bridge_env: dict[str, str]) -> int:
    if not RUNNER_PATH.exists():
        raise RuntimeError(f"Runner file is missing: {RUNNER_PATH}")

    PROJECT_ROOT.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(bridge_env)
    env["COLAB_BRIDGE_PROJECT_ROOT"] = str(PROJECT_ROOT)
    env.setdefault("PYTHONUNBUFFERED", "1")

    log_handle = open(LOG_PATH, "ab", buffering=0)
    process = subprocess.Popen(
        [sys.executable, str(RUNNER_PATH)],
        cwd=str(PROJECT_ROOT),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    PID_PATH.write_text(str(process.pid), encoding="utf-8")
    return process.pid


def main() -> None:
    bridge_env = read_runner_env()
    stop_existing_runner()
    pid = start_runner(bridge_env)
    print(f"SESSION_ID={bridge_env['COLAB_BRIDGE_SESSION_ID']}")
    print(f"BRIDGE_URL={bridge_env['COLAB_BRIDGE_URL']}")
    print("RUNNER_STATUS=reconnect_requested")
    print("RUNNER_TOKEN=set")
    print(f"RUNNER_PID={pid}")
    print(f"RUNNER_LOG={LOG_PATH}")


if __name__ == "__main__":
    main()
