"""Colab runner skeleton for the Colab MCP Bridge.

This runner connects outbound from Colab to:

    GET {bridge_url}/v1/sessions/{session_id}/runner/ws

Authentication is header-based. Do not put runner tokens in query strings or
logs. This slice intentionally handles only fixed bridge command types such as
``gpu_status``; it must not execute arbitrary shell, Python, file, or job
commands received from the bridge.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any


PROJECT_ROOT = "/content/project"


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
    if command_type != "gpu_status":
        return result_envelope(
            envelope,
            ok=False,
            payload={},
            error={
                "code": "INVALID_ARGUMENT",
                "message": "Unsupported runner command in this build slice.",
                "retryable": False,
            },
        )

    return result_envelope(envelope, ok=True, payload=asdict(gpu_status()))


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
