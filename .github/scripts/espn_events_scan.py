#!/usr/bin/env python3
"""
espn_events_scan.py — pull CUSA football + MBB + WBB events from ESPN's
public API and upsert into wsc_espn_events via the SECURITY DEFINER RPC.

ESPN's `?groups=12` filter is inconsistent across sports (works for FB,
returns Ivy League for MBB), so we hardcode the CUSA member-school team
IDs (ESPN team IDs are universal across sports for a given school) and
query each team's full schedule. Events involving two CUSA teams will
show up in both schedules — we dedupe by ESPN event id.

Run locally:
  SUPABASE_URL=... SUPABASE_ANON_KEY=... ESPN_SCAN_TOKEN=... \\
    python3 espn_events_scan.py --sport all --season 2025 --dry-run
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
from typing import Iterable

import requests

# CUSA member schools (2025–26 academic year). ESPN team IDs are stable
# across sports for the same school. Update this list when membership
# changes — adding a school here will start including their games in the
# next scan. There's no "remove old game" sweep, so departed schools'
# historical events stay in wsc_espn_events (which is the right behavior
# for an audit trail).
CUSA_TEAM_IDS: list[tuple[str, int]] = [
    ("Florida International",      2229),
    ("Jacksonville State",         55),
    ("Kennesaw State",             338),
    ("Liberty",                    2335),
    ("Louisiana Tech",             2348),
    ("Middle Tennessee",           2393),
    ("New Mexico State",           166),
    ("Sam Houston",                2534),
    ("UTEP",                       2638),
    ("Western Kentucky",           98),
    # Joining 2025–26 (verify IDs once they're scheduled):
    ("Delaware",                   48),
    ("Missouri State",             2623),
]
CUSA_TEAM_ID_SET = {tid for _, tid in CUSA_TEAM_IDS}

# Sport configs. Each tuple: (key, ESPN sport, ESPN league)
SPORTS: list[tuple[str, str, str]] = [
    ("football",          "football",   "college-football"),
    ("mens-basketball",   "basketball", "mens-college-basketball"),
    ("womens-basketball", "basketball", "womens-college-basketball"),
]

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports"
HTTP_TIMEOUT_S = 12
PER_REQUEST_PAUSE_S = 0.15   # be nice to ESPN — ~6 req/sec ceiling


def current_season(sport_key: str) -> int:
    """ESPN season conventions:
    - Football: season N runs Aug N – Jan N+1 → use the year that contains the
      kickoff. Aug-Dec → year, Jan-Jul → previous year.
    - Basketball: season N (per ESPN) is the year of the title game (March of
      year N), i.e. the 2025–26 season is reported as 2026."""
    today = dt.date.today()
    if sport_key == "football":
        if today.month >= 8:
            return today.year
        # Jan-Jul → still finishing previous fall's season for postseason/
        # off-season queries.
        return today.year - 1
    # basketball
    if today.month >= 7:
        return today.year + 1
    return today.year


def fetch_team_schedule(sport: str, league: str, team_id: int, season: int) -> list[dict]:
    url = f"{ESPN_BASE}/{sport}/{league}/teams/{team_id}/schedule"
    try:
        r = requests.get(url, params={"season": season}, timeout=HTTP_TIMEOUT_S)
    except Exception as e:
        print(f"  ! fetch failed for {team_id} {sport}/{league}: {e}", flush=True)
        return []
    if not r.ok:
        print(f"  ! HTTP {r.status_code} for {team_id} {sport}/{league}", flush=True)
        return []
    try:
        data = r.json()
    except Exception:
        return []
    return data.get("events") or []


def normalize_event(raw: dict, sport_key: str, league_slug: str, season: int) -> dict | None:
    """Map ESPN's schedule-event shape to a wsc_espn_events_upsert row.
    Returns None if the event can't be parsed (missing team / kickoff)."""
    espn_id = raw.get("id") or raw.get("uid")
    if not espn_id:
        return None
    kickoff = raw.get("date")
    if not kickoff:
        return None
    name = raw.get("name") or raw.get("shortName") or ""
    short_name = raw.get("shortName") or name

    # competitions[0].competitors: 2 entries, home and away.
    comps = (raw.get("competitions") or [{}])[0]
    competitors = comps.get("competitors") or []
    home = away = {}
    for c in competitors:
        if c.get("homeAway") == "home":
            home = c
        else:
            away = c
    home_team = (home.get("team") or {}).get("displayName", "")
    home_id   = str((home.get("team") or {}).get("id", "")) or None
    away_team = (away.get("team") or {}).get("displayName", "")
    away_id   = str((away.get("team") or {}).get("id", "")) or None

    home_is_cusa = bool(home_id) and int(home_id) in CUSA_TEAM_ID_SET
    away_is_cusa = bool(away_id) and int(away_id) in CUSA_TEAM_ID_SET

    # Status: ESPN's type.state is one of 'pre' | 'in' | 'post'.
    status_state = (((comps.get("status") or {}).get("type") or {}).get("state") or "pre")
    status = {"pre": "scheduled", "in": "in", "post": "post"}.get(status_state, "scheduled")

    # Broadcast networks (e.g. ESPN+, ESPNU, CBSSN).
    broadcasts = comps.get("broadcasts") or []
    bc_names: list[str] = []
    for b in broadcasts:
        for n in (b.get("names") or []):
            if n and n not in bc_names:
                bc_names.append(n)

    season_obj = raw.get("season") or {}
    season_year = int(season_obj.get("year") or season)
    season_type = int(season_obj.get("type") or 2)

    return {
        "espn_event_id":  str(espn_id),
        "sport":          sport_key,
        "league_slug":    league_slug,
        "season_year":    season_year,
        "season_type":    season_type,
        "name":           name,
        "short_name":     short_name,
        "home_team":      home_team,
        "home_team_id":   home_id,
        "home_is_cusa":   home_is_cusa,
        "away_team":      away_team,
        "away_team_id":   away_id,
        "away_is_cusa":   away_is_cusa,
        "kickoff_at":     kickoff,
        "status":         status,
        "broadcast":      bc_names,
        "raw":            raw,
    }


UPSERT_BATCH_SIZE = 100  # ≤8s PostgREST anon-role statement_timeout per call

def upsert(supabase_url: str, anon_key: str, token: str, events: list[dict]) -> dict:
    """Bulk upsert in batches. Supabase's anon role has an 8-second
    statement_timeout; even the set-based ON CONFLICT form can exceed
    that for 600+ events when the table is empty (first-time inserts +
    index updates). Batching keeps each RPC call well under the cap and
    gives us per-batch progress visibility in the action log."""
    url = f"{supabase_url.rstrip('/')}/rest/v1/rpc/wsc_espn_events_upsert"
    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
        "Content-Type": "application/json",
    }
    totals = {"inserted": 0, "updated": 0, "total": 0, "batches": 0}
    for start in range(0, len(events), UPSERT_BATCH_SIZE):
        chunk = events[start:start + UPSERT_BATCH_SIZE]
        body = {"p_token": token, "p_events": chunk}
        r = requests.post(url, headers=headers, data=json.dumps(body), timeout=30)
        if not r.ok:
            raise RuntimeError(
                f"upsert RPC {r.status_code} on batch {totals['batches']+1} "
                f"({start}..{start+len(chunk)}): {r.text[:400]}"
            )
        res = r.json() or {}
        totals["inserted"] += int(res.get("inserted") or 0)
        totals["updated"]  += int(res.get("updated") or 0)
        totals["total"]    += int(res.get("total") or len(chunk))
        totals["batches"] += 1
        print(f"  batch {totals['batches']}: {res}")
    return totals


def scan(sport_keys: Iterable[str], season_override: int | None, dry_run: bool) -> int:
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    anon_key     = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    token        = os.environ.get("ESPN_SCAN_TOKEN", "").strip()
    if not supabase_url or not anon_key:
        print("FATAL: SUPABASE_URL + SUPABASE_ANON_KEY env vars required", file=sys.stderr)
        return 2
    if not dry_run and not token:
        print("FATAL: ESPN_SCAN_TOKEN required (or pass --dry-run)", file=sys.stderr)
        return 2

    all_events: dict[str, dict] = {}     # espn_event_id → row dict
    per_sport_counts: dict[str, int] = {}

    for sport_key, sport, league in SPORTS:
        if sport_key not in sport_keys:
            continue
        season = season_override or current_season(sport_key)
        print(f"[{sport_key}] season {season} — querying {len(CUSA_TEAM_IDS)} CUSA teams")
        sport_count = 0
        for school_name, team_id in CUSA_TEAM_IDS:
            raw_events = fetch_team_schedule(sport, league, team_id, season)
            for raw in raw_events:
                row = normalize_event(raw, sport_key, league, season)
                if row is None:
                    continue
                # First-write wins, subsequent passes update only if the row
                # is *more complete* — but our normalize is deterministic, so
                # first wins is fine.
                all_events.setdefault(row["espn_event_id"], row)
                sport_count += 1
            time.sleep(PER_REQUEST_PAUSE_S)
        per_sport_counts[sport_key] = sport_count
        print(f"[{sport_key}] {sport_count} raw events across all teams (pre-dedup)")

    print(f"\nTotal unique events after dedup: {len(all_events)}")
    for sport_key, n in per_sport_counts.items():
        print(f"  {sport_key:20s}  {n:>5d} raw")

    if not all_events:
        print("Nothing to upsert.")
        return 0

    if dry_run:
        # Print the first few events so we can sanity-check what we'd send.
        sample = list(all_events.values())[:4]
        print("\nDry run — sample of first 4 events:")
        for e in sample:
            print(f"  {e['espn_event_id']}  {e['sport']:18s}  {e['short_name']:50s}  {e['kickoff_at']}  cusa(home={e['home_is_cusa']},away={e['away_is_cusa']})")
        return 0

    # Real upsert. Send in one call (the RPC is bulk-aware).
    payload = list(all_events.values())
    res = upsert(supabase_url, anon_key, token, payload)
    print(f"\nUpsert result: {res}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sport", default="all",
                    help="all | football | mens-basketball | womens-basketball")
    ap.add_argument("--season", default="",
                    help="Optional season override (int). Empty = current season.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Fetch + log only; do not call the upsert RPC.")
    args = ap.parse_args()

    all_keys = {k for k, _, _ in SPORTS}
    if args.sport == "all":
        sport_keys = all_keys
    elif args.sport in all_keys:
        sport_keys = {args.sport}
    else:
        print(f"FATAL: unknown --sport '{args.sport}'", file=sys.stderr)
        sys.exit(2)

    season_override = int(args.season) if args.season.strip() else None
    sys.exit(scan(sport_keys, season_override, args.dry_run))


if __name__ == "__main__":
    main()
