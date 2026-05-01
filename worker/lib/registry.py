"""Worker registry — upsert + heartbeat + shutdown lifecycle.

Each running worker has a row in highlight_worker_registry keyed by hostname.
The registry is what the admin Workers tab reads, and what mark_stale_workers
(called periodically by any worker) flips to 'stale' if last_seen_at is too old.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from . import supabase_client


def register_worker(worker_host: str, max_concurrent_jobs: int = 1, details: Optional[dict] = None) -> None:
    """Upsert this worker into the registry as 'active' with started_at=now()."""
    now = datetime.now(timezone.utc).isoformat()
    supabase_client.get_client().table("highlight_worker_registry").upsert({
        "worker_host": worker_host,
        "started_at": now,
        "last_seen_at": now,
        "status": "active",
        "max_concurrent_jobs": max_concurrent_jobs,
        "current_job_count": 0,
        "details": details or {},
    }).execute()


def update_last_seen(worker_host: str, current_job_count: int) -> None:
    """Bump last_seen_at = now() and refresh current_job_count.

    Also flips status back to 'active' in case the worker was previously marked
    'stale' by another worker's sweep but has now returned.
    """
    supabase_client.get_client().table("highlight_worker_registry").update({
        "last_seen_at": "now()",
        "current_job_count": current_job_count,
        "status": "active",
    }).eq("worker_host", worker_host).execute()


def mark_shutdown(worker_host: str) -> None:
    """Mark this worker 'shutdown' on graceful exit (atexit / SIGINT / SIGTERM)."""
    supabase_client.get_client().table("highlight_worker_registry").update({
        "status": "shutdown",
        "last_seen_at": "now()",
        "current_job_count": 0,
    }).eq("worker_host", worker_host).execute()


def mark_stale_workers(stale_minutes: int = 5) -> int:
    """Flip any 'active' worker whose last_seen_at is older than the threshold to 'stale'.

    Returns the number of workers reclassified. Safe to call from multiple workers
    concurrently — the update is idempotent.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=stale_minutes)).isoformat()
    res = (
        supabase_client.get_client()
        .table("highlight_worker_registry")
        .update({"status": "stale"})
        .eq("status", "active")
        .lt("last_seen_at", cutoff)
        .execute()
    )
    rows = res.data or []
    return len(rows)
