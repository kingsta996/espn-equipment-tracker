#!/usr/bin/env python3
"""
wsc_laptop_agent — Browser-launch agent for the WSC self-service request portal.

Runs on each capture laptop (LAPTOP-A / LAPTOP-B). Polls the Supabase
`wsc_laptop_dispatches` table for pending rows assigned to this laptop, and
when a row's trigger_at falls due, opens the URL in the laptop's browser via
macOS `open` command. Flips the row to status='launched' with a launched_at
timestamp + result_log so the request portal + admin views can confirm.

Architecture mirror of cusa_relay.py for the Roku pipeline: long-lived poll
loop, single laptop identity, anon-key Supabase auth (the trust boundary is
that this script only runs on trusted laptops with credentialed browsers).

ENV VARS
  LAPTOP_ID            Required. 'LAPTOP-A' or 'LAPTOP-B'.
  SUPABASE_URL         Required. The CUSA Supabase project URL.
  SUPABASE_ANON_KEY    Required. The anon key for that project.
  BROWSER_APP          Optional. macOS app bundle name to open the URL in
                       (default: 'Google Chrome'). Use 'Safari', 'Microsoft
                       Edge', etc. if you've put the ESPN+ login state in
                       a different browser.
  POLL_INTERVAL_S      Optional. Seconds between Supabase polls (default 30).
  LEAD_TIME_S          Optional. How far ahead of trigger_at we'll fire to
                       absorb poll latency (default 5). Open slightly early
                       rather than late.

USAGE
  python3 wsc_laptop_agent.py              # long-running loop
  python3 wsc_laptop_agent.py --once       # one poll, then exit (cron-friendly)
  python3 wsc_laptop_agent.py --dry-run    # poll + print plan, don't open or update

Drop-in setup (per laptop):
  1. Copy .env.example to .env, fill in LAPTOP_ID + Supabase creds
  2. `set -a; source .env; set +a; python3 wsc_laptop_agent.py`
  3. Once happy, install the LaunchAgent plist (see README) so it survives login.

No third-party dependencies — stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def _env(name: str, default: str | None = None, required: bool = False) -> str:
    val = os.environ.get(name, default)
    if required and not val:
        print(f"FATAL: ${name} is required", file=sys.stderr)
        sys.exit(2)
    return val or ""


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    # Accept the trailing 'Z' Supabase emits.
    s2 = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s2)
    except ValueError:
        return None


class Agent:
    def __init__(self) -> None:
        self.laptop_id = _env("LAPTOP_ID", required=True).strip()
        if self.laptop_id not in ("LAPTOP-A", "LAPTOP-B"):
            print(f"FATAL: LAPTOP_ID must be LAPTOP-A or LAPTOP-B, got {self.laptop_id!r}", file=sys.stderr)
            sys.exit(2)
        self.supabase_url = _env("SUPABASE_URL", required=True).rstrip("/")
        self.anon_key = _env("SUPABASE_ANON_KEY", required=True)
        self.browser_app = _env("BROWSER_APP", "Google Chrome")
        self.poll_interval = int(_env("POLL_INTERVAL_S", "30"))
        self.lead_time = int(_env("LEAD_TIME_S", "5"))

    # ── Supabase REST helpers ───────────────────────────────────────────
    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self.anon_key,
            "Authorization": f"Bearer {self.anon_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def fetch_pending(self) -> list[dict[str, Any]]:
        # PostgREST: ?laptop_id=eq.LAPTOP-A&status=eq.pending&order=trigger_at.asc
        params = urlencode({
            "laptop_id": f"eq.{self.laptop_id}",
            "status": "eq.pending",
            "order": "trigger_at.asc",
            "select": "id,laptop_id,launch_url,trigger_at,kickoff_at,matchup_label,status",
        })
        url = f"{self.supabase_url}/rest/v1/wsc_laptop_dispatches?{params}"
        req = Request(url, headers=self._headers(), method="GET")
        try:
            with urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode("utf-8"))
        except HTTPError as e:
            body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            print(f"[fetch_pending] HTTP {e.code}: {body[:300]}", file=sys.stderr)
            return []
        except URLError as e:
            print(f"[fetch_pending] network error: {e}", file=sys.stderr)
            return []

    def patch_dispatch(self, dispatch_id: str, patch: dict[str, Any]) -> bool:
        params = urlencode({"id": f"eq.{dispatch_id}"})
        url = f"{self.supabase_url}/rest/v1/wsc_laptop_dispatches?{params}"
        body = json.dumps(patch).encode("utf-8")
        headers = dict(self._headers())
        headers["Prefer"] = "return=minimal"
        req = Request(url, data=body, headers=headers, method="PATCH")
        try:
            with urlopen(req, timeout=10) as r:
                # PostgREST returns 204 for return=minimal
                return 200 <= r.status < 300
        except HTTPError as e:
            body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            print(f"[patch_dispatch {dispatch_id}] HTTP {e.code}: {body[:300]}", file=sys.stderr)
            return False
        except URLError as e:
            print(f"[patch_dispatch {dispatch_id}] network error: {e}", file=sys.stderr)
            return False

    # ── Browser launch ──────────────────────────────────────────────────
    def open_url(self, url: str) -> tuple[bool, dict[str, Any]]:
        """Open `url` in the configured browser. Returns (ok, result_log)."""
        cmd = ["open", "-a", self.browser_app, url]
        try:
            cp = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            ok = cp.returncode == 0
            log = {
                "cmd": cmd,
                "returncode": cp.returncode,
                "stdout": (cp.stdout or "")[-500:],
                "stderr": (cp.stderr or "")[-500:],
                "browser_app": self.browser_app,
                "host": os.uname().nodename,
                "at": _iso_now(),
            }
            return ok, log
        except subprocess.TimeoutExpired:
            return False, {"cmd": cmd, "error": "timeout", "browser_app": self.browser_app, "at": _iso_now()}
        except FileNotFoundError:
            return False, {"cmd": cmd, "error": "`open` not found — agent must run on macOS", "at": _iso_now()}
        except Exception as e:
            return False, {"cmd": cmd, "error": str(e), "at": _iso_now()}

    # ── Main loop ───────────────────────────────────────────────────────
    def tick(self, dry_run: bool = False) -> int:
        """One poll. Returns count of dispatches launched (or would-launch in dry-run)."""
        rows = self.fetch_pending()
        if not rows:
            return 0

        now = datetime.now(timezone.utc)
        launched = 0
        for row in rows:
            trigger = _parse_iso(row.get("trigger_at", ""))
            if trigger is None:
                continue
            # Fire if trigger_at <= now + lead_time, so we open slightly
            # early instead of slightly late.
            seconds_until = (trigger - now).total_seconds()
            if seconds_until > self.lead_time:
                # Not due yet. Future polls will catch it.
                continue

            label = row.get("matchup_label") or "(no label)"
            url = row.get("launch_url", "")
            print(f"[fire] dispatch={row['id']} matchup={label!r} url={url}", file=sys.stderr)

            if dry_run:
                launched += 1
                continue

            ok, log = self.open_url(url)
            patch = {
                "status": "launched" if ok else "failed",
                "launched_at": _iso_now(),
                "result_log": log,
            }
            if self.patch_dispatch(row["id"], patch):
                launched += 1
            else:
                print(f"[fire] WARN failed to PATCH dispatch {row['id']}", file=sys.stderr)
        return launched

    def loop(self, dry_run: bool = False) -> None:
        print(f"[startup] laptop_id={self.laptop_id} poll={self.poll_interval}s lead={self.lead_time}s "
              f"browser={self.browser_app!r} dry_run={dry_run}", file=sys.stderr)
        while True:
            try:
                self.tick(dry_run=dry_run)
            except Exception as e:
                print(f"[tick] unexpected error: {e}", file=sys.stderr)
            time.sleep(self.poll_interval)


def main() -> None:
    p = argparse.ArgumentParser(description="WSC laptop browser-launch agent")
    p.add_argument("--once", action="store_true", help="Run one poll, then exit")
    p.add_argument("--dry-run", action="store_true", help="Print plan without opening browser or updating Supabase")
    args = p.parse_args()

    agent = Agent()
    if args.once:
        n = agent.tick(dry_run=args.dry_run)
        print(f"[once] {n} dispatch(es) {'would launch' if args.dry_run else 'launched'}", file=sys.stderr)
        return
    agent.loop(dry_run=args.dry_run)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[shutdown] interrupted", file=sys.stderr)
        sys.exit(0)
