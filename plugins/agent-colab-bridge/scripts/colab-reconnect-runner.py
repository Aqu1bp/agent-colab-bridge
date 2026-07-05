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
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(os.environ.get("COLAB_BRIDGE_PROJECT_ROOT", "/content/project"))
PROC_ROOT = Path(os.environ.get("COLAB_BRIDGE_PROC_ROOT", "/proc"))
PID_PATH = PROJECT_ROOT / ".colab_mcp_runner.pid"
RUNNER_PATH = PROJECT_ROOT / "colab_runner.py"
LOG_PATH = PROJECT_ROOT / "colab_mcp_runner.log"
BRIDGE_ENV_KEYS = {
    "COLAB_BRIDGE_URL",
    "COLAB_BRIDGE_SESSION_ID",
    "COLAB_BRIDGE_RUNNER_TOKEN",
    "COLAB_BRIDGE_PROJECT_ROOT",
}


@dataclass(frozen=True)
class ProcessSnapshot:
    pid: int
    environ: dict[str, str]
    cmdline: list[str]
    starttime: str | None


def read_runner_pid() -> int:
    if not PID_PATH.exists():
        raise RuntimeError(f"Runner pid file is missing: {PID_PATH}")

    pid_text = PID_PATH.read_text(encoding="utf-8").strip()
    if not pid_text.isdecimal():
        raise RuntimeError(f"Runner pid file is invalid: {PID_PATH}")
    return int(pid_text)


def read_runner_env() -> dict[str, str]:
    pid = read_runner_pid()
    snapshot = read_process_snapshot(pid)
    if not is_expected_runner_process(snapshot):
        raise RuntimeError("Runner pid file does not point to the expected Colab bridge runner process.")
    missing = sorted(BRIDGE_ENV_KEYS - set(snapshot.environ))
    if missing:
        raise RuntimeError(f"Runner process environment is missing: {', '.join(missing)}")
    return {key: snapshot.environ[key] for key in BRIDGE_ENV_KEYS}

def read_process_snapshot(pid: int) -> ProcessSnapshot:
    process_path = PROC_ROOT / str(pid)
    return ProcessSnapshot(
        pid=pid,
        environ=read_proc_environ(process_path / "environ"),
        cmdline=read_proc_cmdline(process_path / "cmdline"),
        starttime=read_proc_starttime(process_path / "stat"),
    )


def read_proc_environ(env_path: Path) -> dict[str, str]:
    raw = env_path.read_bytes()
    values: dict[str, str] = {}
    for item in raw.split(b"\0"):
        key, separator, value = item.partition(b"=")
        if not separator:
            continue
        decoded_key = key.decode("utf-8", errors="replace")
        if decoded_key in BRIDGE_ENV_KEYS:
            values[decoded_key] = value.decode("utf-8", errors="replace")
    return values


def read_proc_cmdline(cmdline_path: Path) -> list[str]:
    raw = cmdline_path.read_bytes()
    return [
        item.decode("utf-8", errors="replace")
        for item in raw.split(b"\0")
        if item
    ]


def read_proc_starttime(stat_path: Path) -> str | None:
    try:
        raw = stat_path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None
    after_comm = raw.rsplit(") ", 1)
    if len(after_comm) != 2:
        return None
    fields = after_comm[1].split()
    return fields[19] if len(fields) > 19 else None


def is_expected_runner_process(snapshot: ProcessSnapshot) -> bool:
    if not BRIDGE_ENV_KEYS.issubset(snapshot.environ):
        return False
    expected_project_root = str(PROJECT_ROOT)
    if snapshot.environ.get("COLAB_BRIDGE_PROJECT_ROOT") != expected_project_root:
        return False
    if not snapshot.cmdline:
        return False
    expected_runner = str(RUNNER_PATH)
    normalized_cmdline = [str(Path(item)) if item.endswith(".py") else item for item in snapshot.cmdline]
    return expected_runner in normalized_cmdline or RUNNER_PATH.name in [Path(item).name for item in snapshot.cmdline]


def stop_existing_runner() -> None:
    if not PID_PATH.exists():
        return
    try:
        pid = read_runner_pid()
        snapshot = read_process_snapshot(pid)
    except (FileNotFoundError, RuntimeError):
        return
    if not is_expected_runner_process(snapshot):
        raise RuntimeError("Refusing to stop process from pid file because it is not the expected runner.")
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
