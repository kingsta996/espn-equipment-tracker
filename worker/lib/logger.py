"""Worker logging — writes to highlight_processing_log AND stdout."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Optional

from . import supabase_client


_worker_host: Optional[str] = None


def configure(worker_host: str) -> None:
    """Stash the worker host so every log entry is tagged with it."""
    global _worker_host
    _worker_host = worker_host


def _stdout(level: str, message: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    host = _worker_host or "?"
    sys.stdout.write(f"[{ts}] [{level:<5}] [{host}] {message}\n")
    sys.stdout.flush()


def _insert(request_id: Optional[str], level: str, message: str, details: Optional[dict]) -> None:
    try:
        supabase_client.get_client().table("highlight_processing_log").insert({
            "request_id": request_id,
            "worker_host": _worker_host,
            "level": level,
            "message": message[:4000],
            "details": details,
        }).execute()
    except Exception as e:  # never let log writes break the pipeline
        sys.stderr.write(f"[logger] failed to insert log row: {e}\n")


def log_info(request_id: Optional[str], message: str, details: Optional[dict] = None) -> None:
    _stdout("info", message)
    _insert(request_id, "info", message, details)


def log_warn(request_id: Optional[str], message: str, details: Optional[dict] = None) -> None:
    _stdout("warn", message)
    _insert(request_id, "warn", message, details)


def log_error(request_id: Optional[str], message: str, details: Optional[dict] = None) -> None:
    _stdout("error", message)
    _insert(request_id, "error", message, details)
