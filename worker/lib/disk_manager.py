"""Disk management — temp dir, free space, cleanup, quota.

This module is a stub in v1: the stub_handler doesn't actually download any
files, so these helpers aren't exercised end-to-end. They exist so Session B
can wire the real CV pipeline in without changing the public API.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Optional


class DiskQuotaExceeded(RuntimeError):
    """Raised when the temp dir size exceeds MAX_TEMP_DISK_GB."""


def _temp_path() -> Path:
    raw = os.environ.get("WORKER_TEMP_DIR", "/tmp/cusa_highlights")
    return Path(raw).expanduser()


def get_temp_dir() -> Path:
    """Return the worker's temp directory, creating it if needed.

    Raises if the directory cannot be created or is not writable.
    """
    p = _temp_path()
    p.mkdir(parents=True, exist_ok=True)
    if not os.access(p, os.W_OK):
        raise PermissionError(f"Worker temp dir {p} is not writable")
    return p


def get_free_gb(path: Optional[Path] = None) -> float:
    """Return free disk space at `path` (default: temp dir) in GB."""
    target = path if path is not None else get_temp_dir()
    usage = shutil.disk_usage(target)
    return usage.free / (1024 ** 3)


def check_space_for(needed_bytes: int, path: Optional[Path] = None) -> bool:
    """Return True if there's room for needed_bytes plus a 10% safety margin."""
    target = path if path is not None else get_temp_dir()
    usage = shutil.disk_usage(target)
    return usage.free >= int(needed_bytes * 1.10)


def cleanup_file(path: Path) -> None:
    """Safely delete a file, swallowing FileNotFoundError."""
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass


def cleanup_old_files(retention_hours: int) -> int:
    """Delete files in the temp dir older than retention_hours. Returns count.

    Walks recursively. Only removes regular files (leaves directories alone so
    the tree structure built by Session B stays intact).
    """
    if retention_hours <= 0:
        return 0
    cutoff = time.time() - (retention_hours * 3600)
    deleted = 0
    root = get_temp_dir()
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                deleted += 1
        except FileNotFoundError:
            pass
        except OSError:
            # File in use, permission denied, etc. — skip and continue.
            pass
    return deleted


def get_temp_dir_size_gb() -> float:
    """Return total size of the temp dir tree in GB."""
    total = 0
    for path in get_temp_dir().rglob("*"):
        if path.is_file():
            try:
                total += path.stat().st_size
            except FileNotFoundError:
                pass
    return total / (1024 ** 3)


def assert_within_quota(max_gb: float) -> None:
    """Raise DiskQuotaExceeded if temp dir size exceeds max_gb."""
    size_gb = get_temp_dir_size_gb()
    if size_gb > max_gb:
        raise DiskQuotaExceeded(
            f"Temp dir size {size_gb:.2f} GB exceeds quota {max_gb:.2f} GB"
        )
