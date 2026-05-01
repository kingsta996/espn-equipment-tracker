"""Supabase wrapper for the highlight worker.

Uses the service-role key (bypasses RLS by design — the worker is trusted
infrastructure on a Mac controlled by CUSA). Never use the anon key here.
"""

from __future__ import annotations

import os
from typing import Optional

from supabase import Client, create_client


_client: Optional[Client] = None


def get_client() -> Client:
    """Lazy-init the Supabase client using SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY."""
    global _client
    if _client is None:
        url = os.environ.get("SUPABASE_URL", "").strip()
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the worker .env"
            )
        _client = create_client(url, key)
    return _client


def claim_next_job(worker_host: str) -> Optional[dict]:
    """Atomically claim the next Approved job via the claim_next_highlight_job RPC.

    Returns the claimed row as a dict, or None if no work is available.
    The RPC sets status='Processing', processing_started_at=now(),
    last_heartbeat_at=now(), worker_host=<this host>.
    """
    res = get_client().rpc("claim_next_highlight_job", {"p_worker_host": worker_host}).execute()
    data = res.data
    if data is None:
        return None
    # Postgres function returning a composite type comes back as a dict (or
    # sometimes a list with one dict, depending on supabase-py version).
    if isinstance(data, list):
        if not data:
            return None
        row = data[0]
    else:
        row = data
    # An empty composite (no row claimed) shows up as a dict with all-None fields
    # or as None for the id. Treat that as "no work".
    if not row or row.get("id") is None:
        return None
    return row


def heartbeat(request_id: str) -> None:
    """Update last_heartbeat_at = now() for the given request."""
    get_client().table("highlight_requests").update({
        "last_heartbeat_at": "now()",
    }).eq("id", request_id).execute()


def mark_complete(
    request_id: str,
    output_box_folder_id: str,
    output_clip_count: int,
    output_metadata: Optional[dict] = None,
) -> None:
    """Mark a job complete with its output artifacts."""
    get_client().table("highlight_requests").update({
        "status": "Complete",
        "processing_completed_at": "now()",
        "output_box_folder_id": output_box_folder_id,
        "output_clip_count": output_clip_count,
        "output_metadata": output_metadata or {},
        "error_message": None,
    }).eq("id", request_id).execute()


def mark_failed(request_id: str, error_message: str) -> None:
    """Mark a job failed with an error message."""
    get_client().table("highlight_requests").update({
        "status": "Failed",
        "processing_completed_at": "now()",
        "error_message": (error_message or "")[:4000],
    }).eq("id", request_id).execute()


def sweep_stale(stale_minutes: int = 5) -> int:
    """Call sweep_stale_highlight_jobs RPC. Returns number of jobs reset."""
    res = get_client().rpc(
        "sweep_stale_highlight_jobs", {"p_stale_minutes": stale_minutes}
    ).execute()
    data = res.data
    if isinstance(data, list):
        return int(data[0]) if data else 0
    if isinstance(data, dict):
        # Some supabase-py versions wrap scalars
        return int(next(iter(data.values()), 0))
    try:
        return int(data or 0)
    except (TypeError, ValueError):
        return 0
