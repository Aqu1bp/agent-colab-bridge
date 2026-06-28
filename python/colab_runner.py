"""Colab runner skeleton for the Colab MCP Bridge.

This runner connects outbound from Colab to:

    GET {bridge_url}/v1/sessions/{session_id}/runner/ws

Authentication is header-based. Do not put runner tokens in query strings or
logs. Shell and Python foreground commands are intentionally dangerous and are
expected to be gated by local controller policy before they reach the runner.
This slice still does not implement file or background job commands.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = "/content/project"
DEFAULT_FOREGROUND_TIMEOUT_SEC = 30
MAX_FOREGROUND_TIMEOUT_SEC = 120
DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024
MAX_OUTPUT_BYTES = 20 * 1024


@dataclass(frozen=True)
class GpuInfo:
    index: int
    name: str
    memory_total_mb: int | None
    memory_used_mb: int | None
    utilization_gpu_percent: int | None


@dataclass(frozen=True)
class GpuStatus:
    available: bool
    source: str
    gpus: list[GpuInfo]
    raw: str


@dataclass(frozen=True)
class ForegroundResult:
    stdout: str
    stderr: str
    exit_code: int | None
    duration_ms: int
    timed_out: bool
    truncated: bool


def runner_instance_id() -> str:
    return f"runner_{uuid.uuid4().hex}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_mib(value: str) -> int | None:
    cleaned = value.strip().replace("MiB", "").strip()
    try:
        return int(cleaned)
    except ValueError:
        return None


def parse_percent(value: str) -> int | None:
    cleaned = value.strip().replace("%", "").strip()
    try:
        return int(cleaned)
    except ValueError:
        return None


def gpu_status() -> GpuStatus:
    """Run only the fixed GPU status probe."""

    query = [
        "nvidia-smi",
        "--query-gpu=name,memory.total,memory.used,utilization.gpu",
        "--format=csv,noheader",
    ]
    try:
        completed = subprocess.run(
            query,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        raw = completed.stdout.strip()
        gpus: list[GpuInfo] = []
        for index, line in enumerate(raw.splitlines()):
            parts = [part.strip() for part in line.split(",")]
            if len(parts) != 4:
                continue
            gpus.append(
                GpuInfo(
                    index=index,
                    name=parts[0],
                    memory_total_mb=parse_mib(parts[1]),
                    memory_used_mb=parse_mib(parts[2]),
                    utilization_gpu_percent=parse_percent(parts[3]),
                )
            )
        return GpuStatus(available=bool(gpus), source="nvidia-smi", gpus=gpus, raw=raw)
    except (FileNotFoundError, subprocess.SubprocessError):
        return torch_gpu_status()


def torch_gpu_status() -> GpuStatus:
    try:
        import torch  # type: ignore
    except Exception as error:  # pragma: no cover - depends on Colab runtime.
        return GpuStatus(available=False, source="none", gpus=[], raw=str(error))

    if not torch.cuda.is_available():
        return GpuStatus(available=False, source="torch", gpus=[], raw="torch.cuda.is_available() == False")

    gpus: list[GpuInfo] = []
    for index in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(index)
        memory_used = torch.cuda.memory_allocated(index) // (1024 * 1024)
        gpus.append(
            GpuInfo(
                index=index,
                name=props.name,
                memory_total_mb=props.total_memory // (1024 * 1024),
                memory_used_mb=int(memory_used),
                utilization_gpu_percent=None,
            )
        )
    return GpuStatus(available=bool(gpus), source="torch", gpus=gpus, raw=json.dumps([asdict(gpu) for gpu in gpus]))


async def handle_command(envelope: dict[str, Any]) -> dict[str, Any]:
    command_type = envelope.get("type")
    if command_type == "gpu_status":
        return result_envelope(envelope, ok=True, payload=asdict(gpu_status()))

    if command_type == "run_shell":
        try:
            payload = normalize_foreground_payload(command_type, envelope.get("payload", {}))
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        return result_envelope(envelope, ok=True, payload=asdict(await run_shell(payload)))

    if command_type == "run_python":
        try:
            payload = normalize_foreground_payload(command_type, envelope.get("payload", {}))
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        return result_envelope(envelope, ok=True, payload=asdict(await run_python(payload)))

    return invalid_argument_result(envelope, "Unsupported runner command in this build slice.")


def invalid_argument_result(envelope: dict[str, Any], message: str) -> dict[str, Any]:
    return result_envelope(
        envelope,
        ok=False,
        payload={},
        error={
            "code": "INVALID_ARGUMENT",
            "message": message,
            "retryable": False,
        },
    )


def normalize_foreground_payload(command_type: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Foreground command payload must be an object.")

    source_name = "command" if command_type == "run_shell" else "code"
    source = payload.get(source_name)
    if not isinstance(source, str) or source == "":
        raise ValueError(f"{source_name} must be a non-empty string.")

    timeout_sec = payload.get("timeout_sec", DEFAULT_FOREGROUND_TIMEOUT_SEC)
    if (
        not isinstance(timeout_sec, (int, float))
        or isinstance(timeout_sec, bool)
        or timeout_sec <= 0
        or timeout_sec > MAX_FOREGROUND_TIMEOUT_SEC
    ):
        raise ValueError(f"timeout_sec must be positive and no greater than {MAX_FOREGROUND_TIMEOUT_SEC}.")

    max_output_bytes = payload.get("max_output_bytes", DEFAULT_MAX_OUTPUT_BYTES)
    if (
        not isinstance(max_output_bytes, int)
        or isinstance(max_output_bytes, bool)
        or max_output_bytes <= 0
        or max_output_bytes > MAX_OUTPUT_BYTES
    ):
        raise ValueError(f"max_output_bytes must be a positive integer no greater than {MAX_OUTPUT_BYTES}.")

    normalized = {
        source_name: source,
        "timeout_sec": float(timeout_sec),
        "max_output_bytes": max_output_bytes,
    }
    return normalized


async def run_shell(payload: dict[str, Any]) -> ForegroundResult:
    ensure_project_root()
    process = await asyncio.create_subprocess_shell(
        payload["command"],
        cwd=PROJECT_ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    return await collect_process(process, payload["timeout_sec"], payload["max_output_bytes"])


async def run_python(payload: dict[str, Any]) -> ForegroundResult:
    ensure_project_root()
    temp_dir = Path(PROJECT_ROOT) / ".colab_mcp_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".py", dir=temp_dir, delete=False) as temp_file:
        temp_file.write(payload["code"])
        temp_path = temp_file.name

    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            temp_path,
            cwd=PROJECT_ROOT,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        return await collect_process(process, payload["timeout_sec"], payload["max_output_bytes"])
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def ensure_project_root() -> None:
    Path(PROJECT_ROOT).mkdir(parents=True, exist_ok=True)


async def collect_process(
    process: asyncio.subprocess.Process,
    timeout_sec: float,
    max_output_bytes: int,
) -> ForegroundResult:
    started_at = time.monotonic()
    stdout_parts: list[bytes] = []
    stderr_parts: list[bytes] = []
    remaining = max_output_bytes
    truncated = False
    timed_out = False

    async def read_stream(stream: asyncio.StreamReader | None, parts: list[bytes]) -> None:
        nonlocal remaining, truncated
        if stream is None:
            return
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                return
            if remaining <= 0:
                truncated = True
                continue
            accepted = chunk[:remaining]
            remaining -= len(accepted)
            parts.append(accepted)
            if len(accepted) < len(chunk):
                truncated = True

    stdout_task = asyncio.create_task(read_stream(process.stdout, stdout_parts))
    stderr_task = asyncio.create_task(read_stream(process.stderr, stderr_parts))

    try:
        await asyncio.wait_for(process.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        timed_out = True
        kill_process_group(process)
        await process.wait()
    finally:
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    return ForegroundResult(
        stdout=b"".join(stdout_parts).decode("utf-8", errors="replace"),
        stderr=b"".join(stderr_parts).decode("utf-8", errors="replace"),
        exit_code=None if timed_out else process.returncode,
        duration_ms=max(0, round((time.monotonic() - started_at) * 1000)),
        timed_out=timed_out,
        truncated=truncated,
    )


def kill_process_group(process: asyncio.subprocess.Process) -> None:
    if process.pid is None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except PermissionError:
        process.kill()


def result_envelope(
    command: dict[str, Any],
    *,
    ok: bool,
    payload: dict[str, Any],
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = {
        "protocol_version": command.get("protocol_version", 1),
        "session_id": command["session_id"],
        "command_id": command["command_id"],
        "message_id": f"msg_{uuid.uuid4().hex}",
        "reply_to": command["message_id"],
        "kind": "result",
        "type": f"{command['type']}_result",
        "sent_at": now_iso(),
        "ok": ok,
        "payload": payload,
    }
    if error is not None:
        result["error"] = error
    return result


async def connect_and_run(
    *,
    bridge_url: str,
    session_id: str,
    runner_token: str,
    instance_id: str | None = None,
) -> None:
    """Outbound WebSocket loop shape.

    The production notebook bootstrap should call this with secrets read from
    notebook-local state. This function imports the optional ``websockets``
    package lazily so unit tests can import this module without that dependency.
    """

    import websockets  # type: ignore

    runner_id = instance_id or runner_instance_id()
    url = f"{bridge_url.rstrip('/')}/v1/sessions/{session_id}/runner/ws"
    headers = {
        "Authorization": f"Bearer {runner_token}",
        "X-Bridge-Timestamp": now_iso(),
        "X-Bridge-Nonce": f"runner_{uuid.uuid4().hex}",
        "X-Bridge-Runner-Instance-Id": runner_id,
        "X-Bridge-Kernel-Started-At": now_iso(),
        "X-Bridge-Runner-Started-At": now_iso(),
    }

    try:
        websocket_context = websockets.connect(url, additional_headers=headers)
    except TypeError:  # pragma: no cover - depends on installed websockets version.
        websocket_context = websockets.connect(url, extra_headers=headers)

    async with websocket_context as websocket:
        async for message in websocket:
            envelope = json.loads(message)
            response = await handle_command(envelope)
            await websocket.send(json.dumps(response))


if __name__ == "__main__":
    asyncio.run(
        connect_and_run(
            bridge_url=os.environ["COLAB_BRIDGE_URL"],
            session_id=os.environ["COLAB_BRIDGE_SESSION_ID"],
            runner_token=os.environ["COLAB_BRIDGE_RUNNER_TOKEN"],
        )
    )
