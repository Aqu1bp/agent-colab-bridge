"""Colab runner for Agent Colab Bridge.

This runner connects outbound from Colab to:

    GET {bridge_url}/v1/sessions/{session_id}/runner/ws

Authentication is header-based. Do not put runner tokens in query strings or
logs. Shell and Python foreground commands are intentionally dangerous and are
expected to be gated by local controller policy before they reach the runner.
File writes and background job start/interrupt are also expected to be gated
before they reach the runner.
"""

from __future__ import annotations

import asyncio
import codecs
import errno
import json
import ntpath
import os
import posixpath
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = os.environ.get("COLAB_BRIDGE_PROJECT_ROOT", "/content/project")
DEFAULT_FOREGROUND_TIMEOUT_SEC = 30
MAX_FOREGROUND_TIMEOUT_SEC = 120
DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024
MAX_OUTPUT_BYTES = 20 * 1024
DEFAULT_READ_FILE_MAX_BYTES = 20 * 1024
MAX_FILE_CONTENT_BYTES = 1024 * 1024
MAX_READ_FILE_BYTES = 1024 * 1024
DEFAULT_JOB_LOG_BYTES = 200 * 1024
MAX_JOB_LOG_BYTES = 200 * 1024
DEFAULT_TAIL_MAX_BYTES = 20 * 1024
MAX_TAIL_BYTES = 200 * 1024
DEFAULT_INTERRUPT_KILL_AFTER_SEC = 5
MAX_INTERRUPT_KILL_AFTER_SEC = 30


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


@dataclass(frozen=True)
class WriteFileResult:
    path: str
    bytes_written: int
    mode: str


@dataclass(frozen=True)
class ReadFileResult:
    path: str
    content: str
    bytes_read: int
    truncated: bool


@dataclass(frozen=True)
class StartJobResult:
    job_id: str
    status: str
    started_at: str


@dataclass(frozen=True)
class JobLogEvent:
    cursor: int
    stream: str
    text: str
    at: str


@dataclass(frozen=True)
class TailJobResult:
    job_id: str
    status: str
    next_cursor: int
    events: list[JobLogEvent]
    truncated: bool
    exit_code: int | None


@dataclass(frozen=True)
class InterruptJobResult:
    job_id: str
    status: str
    exit_code: int | None
    interrupted_at: str


class RunnerCommandError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        retryable: bool = False,
        payload: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.bridge_error = {
            "code": code,
            "message": message,
            "retryable": retryable,
        }
        self.payload = payload or {}


class JobLogRing:
    def __init__(self, max_bytes: int):
        self.max_bytes = max_bytes
        self.events: list[dict[str, Any]] = []
        self.next_cursor = 1
        self.total_bytes = 0

    def add(self, stream: str, text: str) -> None:
        for chunk in split_utf8_text_by_bytes(text, self.max_event_bytes()):
            self._add_event(stream, chunk)

    def tail(self, cursor: int, max_bytes: int) -> tuple[int, list[JobLogEvent], bool]:
        oldest_cursor = self.events[0]["cursor"] if self.events else None
        if oldest_cursor is not None and cursor < oldest_cursor - 1:
            raise RunnerCommandError(
                "CURSOR_EXPIRED",
                "Background job log cursor has expired.",
                payload={"oldest_cursor": oldest_cursor},
            )

        events: list[JobLogEvent] = []
        total = 0
        truncated = False
        for event in [item for item in self.events if item["cursor"] > cursor]:
            next_total = total + event["bytes"]
            if events and next_total > max_bytes:
                truncated = True
                break
            events.append(
                JobLogEvent(
                    cursor=event["cursor"],
                    stream=event["stream"],
                    text=event["text"],
                    at=event["at"],
                )
            )
            total = next_total
            if next_total > max_bytes:
                truncated = True
                break

        next_cursor = events[-1].cursor if events else max(cursor, self.next_cursor - 1)
        return next_cursor, events, truncated

    def _add_event(self, stream: str, text: str) -> None:
        byte_count = len(text.encode("utf-8"))
        self.events.append(
            {
                "cursor": self.next_cursor,
                "stream": stream,
                "text": text,
                "at": now_iso(),
                "bytes": byte_count,
            }
        )
        self.next_cursor += 1
        self.total_bytes += byte_count
        self._compact()

    def _compact(self) -> None:
        dropped_bytes = 0
        while self.total_bytes > self.max_bytes and len(self.events) > 1:
            removed = self.events.pop(0)
            self.total_bytes -= removed["bytes"]
            if removed["stream"] != "log_dropped":
                dropped_bytes += removed["bytes"]

        if dropped_bytes:
            self._add_log_dropped_event(dropped_bytes)

    def _add_log_dropped_event(self, dropped_bytes: int) -> None:
        text = f"Dropped {dropped_bytes} bytes from background job log ring."
        byte_count = len(text.encode("utf-8"))
        self.events.append(
            {
                "cursor": self.next_cursor,
                "stream": "log_dropped",
                "text": text,
                "at": now_iso(),
                "bytes": byte_count,
            }
        )
        self.next_cursor += 1
        self.total_bytes += byte_count
        while self.total_bytes > self.max_bytes and len(self.events) > 1:
            removed = self.events.pop(0)
            self.total_bytes -= removed["bytes"]

    def max_event_bytes(self) -> int:
        return max(64, min(16 * 1024, self.max_bytes // 4))


def split_utf8_text_by_bytes(text: str, max_bytes: int) -> list[str]:
    if len(text.encode("utf-8")) <= max_bytes:
        return [text]

    chunks: list[str] = []
    current = ""
    current_bytes = 0
    for char in text:
        char_bytes = len(char.encode("utf-8"))
        if current and current_bytes + char_bytes > max_bytes:
            chunks.append(current)
            current = ""
            current_bytes = 0
        current += char
        current_bytes += char_bytes
    if current:
        chunks.append(current)
    return chunks


class BackgroundJob:
    def __init__(
        self,
        job_id: str,
        process: asyncio.subprocess.Process,
        max_log_bytes: int,
        name: str | None = None,
    ):
        self.job_id = job_id
        self.name = name
        self.process = process
        self.started_at = now_iso()
        self.status = "running"
        self.exit_code: int | None = None
        self.interrupted_at: str | None = None
        self.log_ring = JobLogRing(max_log_bytes)
        self.stdout_task = asyncio.create_task(self._read_stream("stdout", process.stdout))
        self.stderr_task = asyncio.create_task(self._read_stream("stderr", process.stderr))
        self.done_task = asyncio.create_task(self._watch_process())

    async def _read_stream(self, stream: str, reader: asyncio.StreamReader | None) -> None:
        if reader is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                remaining = decoder.decode(b"", final=True)
                if remaining:
                    self.log_ring.add(stream, remaining)
                return
            text = decoder.decode(chunk)
            if text:
                self.log_ring.add(stream, text)

    async def _watch_process(self) -> None:
        await self.process.wait()
        await asyncio.gather(self.stdout_task, self.stderr_task, return_exceptions=True)
        self.exit_code = self.process.returncode
        self.status = "interrupted" if self.interrupted_at else "exited"
        global ACTIVE_JOB_ID
        if ACTIVE_JOB_ID == self.job_id:
            ACTIVE_JOB_ID = None

    def summary(self, active: bool) -> dict[str, Any]:
        result: dict[str, Any] = {
            "job_id": self.job_id,
            "status": self.status,
            "started_at": self.started_at,
            "exit_code": self.exit_code,
            "interrupted_at": self.interrupted_at,
            "active": active,
        }
        if self.name is not None:
            result["name"] = self.name
        return result

    def tail(self, cursor: int, max_bytes: int) -> TailJobResult:
        try:
            next_cursor, events, truncated = self.log_ring.tail(cursor, max_bytes)
        except RunnerCommandError as error:
            error.payload = {"job_id": self.job_id, **error.payload}
            raise
        return TailJobResult(
            job_id=self.job_id,
            status=self.status,
            next_cursor=next_cursor,
            events=events,
            truncated=truncated,
            exit_code=self.exit_code,
        )

    async def interrupt(self, payload: dict[str, Any]) -> InterruptJobResult:
        interrupted_at = self.interrupted_at or now_iso()
        if self.status == "running":
            self.interrupted_at = interrupted_at
            send_process_group_signal(self.process, getattr(signal, payload["signal"]))
            if payload["signal"] == "SIGTERM":
                try:
                    await asyncio.wait_for(asyncio.shield(self.done_task), timeout=payload["kill_after_sec"])
                except asyncio.TimeoutError:
                    send_process_group_signal(self.process, signal.SIGKILL)
            try:
                await asyncio.wait_for(asyncio.shield(self.done_task), timeout=5)
            except asyncio.TimeoutError:
                pass

        return InterruptJobResult(
            job_id=self.job_id,
            status=self.status,
            exit_code=self.exit_code,
            interrupted_at=interrupted_at,
        )


JOBS: dict[str, BackgroundJob] = {}
ACTIVE_JOB_ID: str | None = None


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
    if command_type == "ping":
        return result_envelope(envelope, ok=True, payload={"ok": True, "pong": True})

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

    if command_type == "write_file":
        try:
            payload = normalize_write_file_payload(envelope.get("payload", {}))
            result = write_file(payload)
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        except RunnerCommandError as error:
            return command_error_result(envelope, error)
        except OSError:
            return command_error_result(envelope, RunnerCommandError("INTERNAL_ERROR", "File command failed."))
        return result_envelope(envelope, ok=True, payload=asdict(result))

    if command_type == "read_file":
        try:
            payload = normalize_read_file_payload(envelope.get("payload", {}))
            result = read_file(payload)
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        except RunnerCommandError as error:
            return command_error_result(envelope, error)
        except OSError:
            return command_error_result(envelope, RunnerCommandError("INTERNAL_ERROR", "File command failed."))
        return result_envelope(envelope, ok=True, payload=asdict(result))

    if command_type == "start_job":
        try:
            payload = normalize_start_job_payload(envelope.get("payload", {}))
            result = await start_job(payload)
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        except RunnerCommandError as error:
            return command_error_result(envelope, error)
        return result_envelope(envelope, ok=True, payload=asdict(result))

    if command_type == "list_jobs":
        try:
            payload = normalize_list_jobs_payload(envelope.get("payload", {}))
            result = list_jobs(payload)
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        return result_envelope(envelope, ok=True, payload=result)

    if command_type == "job_status":
        try:
            payload = normalize_job_status_payload(envelope.get("payload", {}))
            result = job_status(payload)
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        except RunnerCommandError as error:
            return command_error_result(envelope, error)
        return result_envelope(envelope, ok=True, payload=result)

    if command_type == "tail_job":
        try:
            payload = normalize_tail_job_payload(envelope.get("payload", {}))
            result = tail_job(payload)
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        except RunnerCommandError as error:
            return command_error_result(envelope, error)
        return result_envelope(envelope, ok=True, payload=asdict(result))

    if command_type == "interrupt_job":
        try:
            payload = normalize_interrupt_job_payload(envelope.get("payload", {}))
            result = await interrupt_job(payload)
        except ValueError as error:
            return invalid_argument_result(envelope, str(error))
        except RunnerCommandError as error:
            return command_error_result(envelope, error)
        return result_envelope(envelope, ok=True, payload=asdict(result))

    return invalid_argument_result(envelope, "Unsupported runner command in this build slice.")


def command_error_result(envelope: dict[str, Any], error: RunnerCommandError) -> dict[str, Any]:
    return result_envelope(envelope, ok=False, payload=error.payload, error=error.bridge_error)


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


def normalize_write_file_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("write_file payload must be an object.")

    path = payload.get("path")
    if not isinstance(path, str) or path == "":
        raise ValueError("path must be a non-empty string.")

    content = payload.get("content")
    if not isinstance(content, str):
        raise ValueError("content must be a string.")

    bytes_written = len(content.encode("utf-8"))
    if bytes_written > MAX_FILE_CONTENT_BYTES:
        raise ValueError(f"content must be no larger than {MAX_FILE_CONTENT_BYTES} bytes.")

    mode = payload.get("mode")
    if mode not in {"overwrite", "append", "create_new"}:
        raise ValueError("mode must be one of overwrite, append, or create_new.")

    return {"path": path, "content": content, "mode": mode}


def normalize_read_file_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("read_file payload must be an object.")

    path = payload.get("path")
    if not isinstance(path, str) or path == "":
        raise ValueError("path must be a non-empty string.")

    max_bytes = payload.get("max_bytes", DEFAULT_READ_FILE_MAX_BYTES)
    if (
        not isinstance(max_bytes, int)
        or isinstance(max_bytes, bool)
        or max_bytes <= 0
        or max_bytes > MAX_READ_FILE_BYTES
    ):
        raise ValueError(f"max_bytes must be a positive integer no greater than {MAX_READ_FILE_BYTES}.")

    return {"path": path, "max_bytes": max_bytes}


def normalize_start_job_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("start_job payload must be an object.")

    command = payload.get("command")
    if not isinstance(command, str) or command == "":
        raise ValueError("command must be a non-empty string.")

    name = payload.get("name")
    if name is not None and not isinstance(name, str):
        raise ValueError("name must be a string.")

    max_log_bytes = payload.get("max_log_bytes", DEFAULT_JOB_LOG_BYTES)
    if (
        not isinstance(max_log_bytes, int)
        or isinstance(max_log_bytes, bool)
        or max_log_bytes <= 0
        or max_log_bytes > MAX_JOB_LOG_BYTES
    ):
        raise ValueError(f"max_log_bytes must be a positive integer no greater than {MAX_JOB_LOG_BYTES}.")

    normalized = {"command": command, "max_log_bytes": max_log_bytes}
    if name is not None:
        normalized["name"] = name
    return normalized


def normalize_tail_job_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("tail_job payload must be an object.")

    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or job_id == "":
        raise ValueError("job_id must be a non-empty string.")

    cursor = payload.get("cursor", 0)
    if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
        raise ValueError("cursor must be a non-negative integer.")

    max_bytes = payload.get("max_bytes", DEFAULT_TAIL_MAX_BYTES)
    if (
        not isinstance(max_bytes, int)
        or isinstance(max_bytes, bool)
        or max_bytes <= 0
        or max_bytes > MAX_TAIL_BYTES
    ):
        raise ValueError(f"max_bytes must be a positive integer no greater than {MAX_TAIL_BYTES}.")

    return {"job_id": job_id, "cursor": cursor, "max_bytes": max_bytes}


def normalize_list_jobs_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("list_jobs payload must be an object.")

    if len(payload) > 0:
        raise ValueError("list_jobs payload must not include properties.")

    return {}


def normalize_job_status_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("job_status payload must be an object.")

    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or job_id == "":
        raise ValueError("job_id must be a non-empty string.")

    return {"job_id": job_id}


def normalize_interrupt_job_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("interrupt_job payload must be an object.")

    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or job_id == "":
        raise ValueError("job_id must be a non-empty string.")

    interrupt_signal = payload.get("signal", "SIGTERM")
    if interrupt_signal not in {"SIGTERM", "SIGKILL"}:
        raise ValueError("signal must be SIGTERM or SIGKILL.")

    kill_after_sec = payload.get("kill_after_sec", DEFAULT_INTERRUPT_KILL_AFTER_SEC)
    if (
        not isinstance(kill_after_sec, (int, float))
        or isinstance(kill_after_sec, bool)
        or kill_after_sec < 0
        or kill_after_sec > MAX_INTERRUPT_KILL_AFTER_SEC
    ):
        raise ValueError(
            f"kill_after_sec must be a non-negative number no greater than {MAX_INTERRUPT_KILL_AFTER_SEC}."
        )

    return {
        "job_id": job_id,
        "signal": interrupt_signal,
        "kill_after_sec": float(kill_after_sec),
    }


async def run_shell(payload: dict[str, Any]) -> ForegroundResult:
    ensure_project_root()
    process = await asyncio.create_subprocess_shell(
        payload["command"],
        cwd=PROJECT_ROOT,
        env=child_process_env(),
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
            "-u",
            temp_path,
            cwd=PROJECT_ROOT,
            env=child_process_env(),
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


async def start_job(payload: dict[str, Any]) -> StartJobResult:
    ensure_project_root()
    global ACTIVE_JOB_ID
    if ACTIVE_JOB_ID is not None:
        active_job = JOBS.get(ACTIVE_JOB_ID)
        if active_job is not None and active_job.status == "running":
            raise RunnerCommandError(
                "JOB_ALREADY_RUNNING",
                "A background job is already running.",
                payload={"job_id": active_job.job_id},
            )

    process = await asyncio.create_subprocess_shell(
        payload["command"],
        cwd=PROJECT_ROOT,
        env=child_process_env(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    job_id = f"job_{uuid.uuid4().hex}"
    job = BackgroundJob(job_id, process, payload["max_log_bytes"], payload.get("name"))
    JOBS[job_id] = job
    ACTIVE_JOB_ID = job_id
    return StartJobResult(job_id=job_id, status="running", started_at=job.started_at)


def list_jobs(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "jobs": [
            job.summary(ACTIVE_JOB_ID == job.job_id and job.status == "running")
            for job in JOBS.values()
        ]
    }


def job_status(payload: dict[str, Any]) -> dict[str, Any]:
    job = JOBS.get(payload["job_id"])
    if job is None:
        raise RunnerCommandError(
            "JOB_NOT_FOUND",
            "Background job was not found.",
            payload={"job_id": payload["job_id"]},
        )
    return job.summary(ACTIVE_JOB_ID == job.job_id and job.status == "running")


def tail_job(payload: dict[str, Any]) -> TailJobResult:
    job = JOBS.get(payload["job_id"])
    if job is None:
        raise RunnerCommandError(
            "JOB_NOT_FOUND",
            "Background job was not found.",
            payload={"job_id": payload["job_id"]},
        )
    return job.tail(payload["cursor"], payload["max_bytes"])


async def interrupt_job(payload: dict[str, Any]) -> InterruptJobResult:
    job = JOBS.get(payload["job_id"])
    if job is None:
        raise RunnerCommandError(
            "JOB_NOT_FOUND",
            "Background job was not found.",
            payload={"job_id": payload["job_id"]},
        )
    return await job.interrupt(payload)


def write_file(payload: dict[str, Any]) -> WriteFileResult:
    content = payload["content"]
    bytes_written = len(content.encode("utf-8"))
    if bytes_written > MAX_FILE_CONTENT_BYTES:
        raise RunnerCommandError("INVALID_ARGUMENT", f"content must be no larger than {MAX_FILE_CONTENT_BYTES} bytes.")

    relative_path, target_path = resolve_safe_project_path(payload["path"], create_parents=True)

    target_stat = lstat_or_none(target_path)
    if payload["mode"] == "append":
        if target_stat is not None:
            assert_regular_file_target(target_stat)
        fd = open_no_follow(target_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
        with os.fdopen(fd, "a", encoding="utf-8") as file:
            file.write(content)
        return WriteFileResult(path=relative_path, bytes_written=bytes_written, mode=payload["mode"])

    if target_stat is not None and stat.S_ISLNK(target_stat.st_mode):
        raise RunnerCommandError("FORBIDDEN_PATH", "symlink targets are not allowed.")
    if payload["mode"] == "create_new" and target_stat is not None:
        raise RunnerCommandError("INVALID_ARGUMENT", "create_new target already exists.")
    if payload["mode"] == "overwrite" and target_stat is not None:
        assert_regular_file_target(target_stat)

    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=target_path.parent,
            prefix=f".{target_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())
            temp_path = temp_file.name

        if payload["mode"] == "create_new":
            try:
                os.link(temp_path, target_path)
            except FileExistsError:
                raise RunnerCommandError("INVALID_ARGUMENT", "create_new target already exists.")
        else:
            os.replace(temp_path, target_path)
            temp_path = None
    finally:
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass

    return WriteFileResult(path=relative_path, bytes_written=bytes_written, mode=payload["mode"])


def read_file(payload: dict[str, Any]) -> ReadFileResult:
    relative_path, target_path = resolve_safe_project_path(payload["path"])
    target_stat = lstat_or_none(target_path)
    if target_stat is None:
        raise RunnerCommandError("INVALID_ARGUMENT", "read target does not exist.")
    assert_regular_file_target(target_stat)

    fd = open_no_follow(target_path, os.O_RDONLY)
    with os.fdopen(fd, "rb") as file:
        raw = file.read(payload["max_bytes"] + 1)

    accepted = raw[: payload["max_bytes"]]
    return ReadFileResult(
        path=relative_path,
        content=accepted.decode("utf-8", errors="replace"),
        bytes_read=len(accepted),
        truncated=len(raw) > payload["max_bytes"],
    )


def resolve_safe_project_path(input_path: str, create_parents: bool = False) -> tuple[str, Path]:
    relative_path = normalize_relative_project_path(input_path)
    ensure_project_root()

    root = Path(PROJECT_ROOT)
    root_stat = os.lstat(root)
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        raise RunnerCommandError("FORBIDDEN_PATH", "project root must be a real directory.")

    segments = relative_path.split("/")
    current = root
    for segment in segments[:-1]:
        current = current / segment
        parent_stat = lstat_or_none(current)
        if parent_stat is None:
            if not create_parents:
                raise RunnerCommandError("INVALID_ARGUMENT", "parent directory does not exist.")
            try:
                os.mkdir(current)
            except FileExistsError:
                pass
            parent_stat = lstat_or_none(current)
        if parent_stat is None:
            raise RunnerCommandError("INVALID_ARGUMENT", "parent directory does not exist.")
        if stat.S_ISLNK(parent_stat.st_mode):
            raise RunnerCommandError("FORBIDDEN_PATH", "parent directory symlinks are not allowed.")
        if not stat.S_ISDIR(parent_stat.st_mode):
            raise RunnerCommandError("INVALID_ARGUMENT", "parent path is not a directory.")

    return relative_path, root.joinpath(*segments)


def normalize_relative_project_path(input_path: str) -> str:
    converted = input_path.replace("\\", "/")
    if converted.strip() == "" or "\0" in converted:
        raise RunnerCommandError("FORBIDDEN_PATH", "path must be a non-empty relative path.")
    if posixpath.isabs(converted) or ntpath.isabs(input_path):
        raise RunnerCommandError("FORBIDDEN_PATH", "absolute paths are not allowed.")
    if ".." in converted.split("/"):
        raise RunnerCommandError("FORBIDDEN_PATH", "path traversal is not allowed.")

    normalized = posixpath.normpath(converted)
    if (
        normalized in {"", ".", ".."}
        or normalized.startswith("../")
        or ".." in normalized.split("/")
    ):
        raise RunnerCommandError("FORBIDDEN_PATH", "path must resolve under the project root.")

    return normalized


def lstat_or_none(path: Path) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def assert_regular_file_target(target_stat: os.stat_result) -> None:
    if stat.S_ISLNK(target_stat.st_mode):
        raise RunnerCommandError("FORBIDDEN_PATH", "symlink targets are not allowed.")
    if not stat.S_ISREG(target_stat.st_mode):
        raise RunnerCommandError("INVALID_ARGUMENT", "target must be a regular file.")


def open_no_follow(path: Path, flags: int) -> int:
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(path, flags | no_follow, 0o666)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise RunnerCommandError("FORBIDDEN_PATH", "symlink targets are not allowed.")
        raise


def ensure_project_root() -> None:
    Path(PROJECT_ROOT).mkdir(parents=True, exist_ok=True)


def child_process_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


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
    send_process_group_signal(process, signal.SIGKILL)


def send_process_group_signal(process: asyncio.subprocess.Process, target_signal: int) -> None:
    if process.pid is None:
        return
    try:
        os.killpg(process.pid, target_signal)
    except ProcessLookupError:
        return
    except PermissionError:
        try:
            os.kill(process.pid, target_signal)
        except ProcessLookupError:
            return


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
    url = runner_websocket_url(bridge_url, session_id)
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
        heartbeat_task = asyncio.create_task(send_heartbeats(websocket, session_id, runner_id))
        try:
            async for message in websocket:
                envelope = json.loads(message)
                response = await handle_command(envelope)
                await websocket.send(json.dumps(response))
        finally:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)


def runner_websocket_url(bridge_url: str, session_id: str) -> str:
    base = bridge_url.rstrip("/")
    if base.startswith("https://"):
        base = f"wss://{base[len('https://'):]}"
    elif base.startswith("http://"):
        base = f"ws://{base[len('http://'):]}"
    elif not base.startswith(("wss://", "ws://")):
        raise ValueError("COLAB_BRIDGE_URL must start with https://, http://, wss://, or ws://")

    return f"{base}/v1/sessions/{session_id}/runner/ws"


async def send_heartbeats(websocket: Any, session_id: str, runner_id: str) -> None:
    while True:
        await asyncio.sleep(15)
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 1,
                    "kind": "heartbeat",
                    "session_id": session_id,
                    "runner_instance_id": runner_id,
                    "sent_at": now_iso(),
                }
            )
        )


if __name__ == "__main__":
    asyncio.run(
        connect_and_run(
            bridge_url=os.environ["COLAB_BRIDGE_URL"],
            session_id=os.environ["COLAB_BRIDGE_SESSION_ID"],
            runner_token=os.environ["COLAB_BRIDGE_RUNNER_TOKEN"],
        )
    )
