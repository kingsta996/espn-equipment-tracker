#!/usr/bin/env python3
"""CUSA Highlight Worker — main entry point.

Polls highlight_requests for Approved jobs, atomically claims them via
claim_next_highlight_job RPC (FOR UPDATE SKIP LOCKED, multi-worker safe),
runs the configured handler, and marks Complete or Failed.

A heartbeat thread bumps last_heartbeat_at every HEARTBEAT_INTERVAL_SECONDS
while a job is in-flight so the stale-job sweeper does not reset it.

Graceful shutdown (Ctrl-C) marks the worker as 'shutdown' in the registry.
Closing the terminal window without Ctrl-C may leave the worker as 'active'
until the periodic stale sweep flips it to 'stale'.
"""

from __future__ import annotations

import atexit
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

# Allow `python cusa_highlight_worker.py` from inside the worker/ dir
THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from dotenv import load_dotenv  # noqa: E402

# Load .env BEFORE importing anything that reads env vars
load_dotenv(THIS_DIR / ".env")

from lib import disk_manager, logger, registry, supabase_client  # noqa: E402
from handlers.stub_handler import StubHandler  # noqa: E402


# ── Config from env ──────────────────────────────────────────────
def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, "").strip() or default)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, "").strip() or default)
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    raw = (os.environ.get(key, "") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


WORKER_HOST = (os.environ.get("WORKER_HOST", "").strip() or os.uname().nodename).strip()
MAX_CONCURRENT_JOBS = _env_int("WORKER_MAX_CONCURRENT_JOBS", 1)
POLL_INTERVAL = _env_int("POLL_INTERVAL_SECONDS", 30)
HEARTBEAT_INTERVAL = _env_int("HEARTBEAT_INTERVAL_SECONDS", 30)
STALE_SWEEP_MINUTES = _env_int("STALE_SWEEP_INTERVAL_MINUTES", 5)
KEEP_SOURCE_ON_FAILURE_HOURS = _env_int("KEEP_SOURCE_ON_FAILURE_HOURS", 24)
MAX_TEMP_DISK_GB = _env_float("MAX_TEMP_DISK_GB", 100.0)


# ── Heartbeat thread ─────────────────────────────────────────────
class HeartbeatThread(threading.Thread):
    """Bumps last_heartbeat_at every HEARTBEAT_INTERVAL seconds until stopped."""

    def __init__(self, request_id: str, interval_seconds: int):
        super().__init__(name=f"heartbeat-{request_id}", daemon=True)
        self.request_id = request_id
        self.interval = interval_seconds
        self._stop = threading.Event()

    def run(self) -> None:
        # Beat once immediately so heartbeat-age starts fresh
        self._beat()
        while not self._stop.wait(self.interval):
            self._beat()

    def _beat(self) -> None:
        try:
            supabase_client.heartbeat(self.request_id)
        except Exception as e:
            sys.stderr.write(f"[heartbeat {self.request_id}] failed: {e}\n")

    def stop(self) -> None:
        self._stop.set()


# ── Lifecycle ────────────────────────────────────────────────────
_shutdown_called = False


def graceful_shutdown(*_args) -> None:
    global _shutdown_called
    if _shutdown_called:
        return
    _shutdown_called = True
    sys.stdout.write("\n[worker] graceful shutdown — marking shutdown in registry\n")
    sys.stdout.flush()
    try:
        registry.mark_shutdown(WORKER_HOST)
    except Exception as e:
        sys.stderr.write(f"[worker] mark_shutdown failed: {e}\n")
    sys.exit(0)


def print_banner(temp_dir: Path) -> None:
    free_gb = disk_manager.get_free_gb(temp_dir)
    bar = "─" * 64
    print(bar)
    print(f"  CUSA Highlight Worker")
    print(f"  Host:           {WORKER_HOST}")
    print(f"  Started at:     {datetime.now(timezone.utc).isoformat()}")
    print(f"  Temp dir:       {temp_dir}")
    print(f"  Free disk:      {free_gb:.2f} GB")
    print(f"  Max concurrent: {MAX_CONCURRENT_JOBS}")
    print(f"  Poll interval:  {POLL_INTERVAL}s")
    print(f"  Heartbeat:      {HEARTBEAT_INTERVAL}s")
    print(f"  Stale sweep:    every {STALE_SWEEP_MINUTES} min")
    print(f"  Handler:        StubHandler (Session A — replace in Session B)")
    print(bar)
    sys.stdout.flush()


# ── Main loop ────────────────────────────────────────────────────
def process_one_job(request: dict) -> None:
    request_id = request["id"]
    logger.log_info(
        request_id,
        f"Worker {WORKER_HOST} claimed job (jersey #{request.get('jersey_number')} "
        f"{request.get('jersey_color')}, file {request.get('box_file_id')})",
    )

    heartbeat_thread = HeartbeatThread(request_id, HEARTBEAT_INTERVAL)
    heartbeat_thread.start()

    try:
        handler = StubHandler()
        result = handler.process(
            request,
            heartbeat_callback=lambda: supabase_client.heartbeat(request_id),
        )
        supabase_client.mark_complete(
            request_id,
            output_box_folder_id=result["output_box_folder_id"],
            output_clip_count=result["output_clip_count"],
            output_metadata=result.get("output_metadata") or {},
        )
        logger.log_info(
            request_id,
            f"Job complete — output_box_folder_id={result['output_box_folder_id']}, "
            f"clip_count={result['output_clip_count']}",
        )
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        try:
            supabase_client.mark_failed(request_id, err)
        except Exception as inner:
            sys.stderr.write(f"[worker] mark_failed also failed: {inner}\n")
        logger.log_error(
            request_id,
            f"Job failed: {err}",
            {"exception": str(e), "type": type(e).__name__},
        )
    finally:
        heartbeat_thread.stop()
        heartbeat_thread.join(timeout=5)


def main() -> None:
    # Set up signal handlers and atexit FIRST so any later failure still cleans up.
    signal.signal(signal.SIGINT, graceful_shutdown)
    signal.signal(signal.SIGTERM, graceful_shutdown)
    atexit.register(graceful_shutdown)

    temp_dir = disk_manager.get_temp_dir()
    print_banner(temp_dir)
    logger.configure(WORKER_HOST)

    try:
        registry.register_worker(WORKER_HOST, max_concurrent_jobs=MAX_CONCURRENT_JOBS)
    except Exception as e:
        sys.stderr.write(f"[worker] register_worker failed: {e}\n")
        raise

    # Initial maintenance
    try:
        reset = supabase_client.sweep_stale(STALE_SWEEP_MINUTES)
        if reset:
            print(f"[worker] startup sweep: reset {reset} stale job(s)")
    except Exception as e:
        sys.stderr.write(f"[worker] startup sweep failed: {e}\n")

    try:
        deleted = disk_manager.cleanup_old_files(KEEP_SOURCE_ON_FAILURE_HOURS)
        if deleted:
            print(f"[worker] startup cleanup: deleted {deleted} old temp file(s)")
    except Exception as e:
        sys.stderr.write(f"[worker] startup cleanup failed: {e}\n")

    current_job_count = 0
    last_sweep_at = time.monotonic()
    last_seen_at = 0.0

    while True:
        try:
            now = time.monotonic()

            # Heartbeat the registry roughly every poll, but also force one
            # at startup by initialising last_seen_at = 0.
            if now - last_seen_at > HEARTBEAT_INTERVAL:
                try:
                    registry.update_last_seen(WORKER_HOST, current_job_count)
                except Exception as e:
                    sys.stderr.write(f"[worker] update_last_seen failed: {e}\n")
                last_seen_at = now

            # Concurrency cap (v1 is single-threaded, but the check is here so
            # Session B can parallelize without changing the loop shape).
            if current_job_count >= MAX_CONCURRENT_JOBS:
                time.sleep(POLL_INTERVAL)
                continue

            request = supabase_client.claim_next_job(WORKER_HOST)
            if not request:
                # Periodic stale sweep + stale-worker classification while idle
                if (now - last_sweep_at) >= (STALE_SWEEP_MINUTES * 60):
                    try:
                        reset = supabase_client.sweep_stale(STALE_SWEEP_MINUTES)
                        if reset:
                            print(f"[worker] periodic sweep: reset {reset} stale job(s)")
                    except Exception as e:
                        sys.stderr.write(f"[worker] periodic sweep failed: {e}\n")
                    try:
                        n = registry.mark_stale_workers(STALE_SWEEP_MINUTES)
                        if n:
                            print(f"[worker] marked {n} worker(s) stale")
                    except Exception as e:
                        sys.stderr.write(f"[worker] mark_stale_workers failed: {e}\n")
                    last_sweep_at = now
                time.sleep(POLL_INTERVAL)
                continue

            current_job_count += 1
            try:
                process_one_job(request)
            finally:
                current_job_count -= 1
                try:
                    registry.update_last_seen(WORKER_HOST, current_job_count)
                except Exception as e:
                    sys.stderr.write(f"[worker] update_last_seen (post-job) failed: {e}\n")

        except KeyboardInterrupt:
            graceful_shutdown()
            break
        except Exception as e:
            sys.stderr.write(f"[worker] main loop error: {e}\n")
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
