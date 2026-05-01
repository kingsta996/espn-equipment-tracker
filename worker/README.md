# CUSA Highlight Worker

Python worker that polls Supabase for Approved highlight requests, runs the
configured handler, and reports results back. Multi-worker safe by design:
job claiming is atomic via the `claim_next_highlight_job` Postgres RPC
(`FOR UPDATE SKIP LOCKED`), and a heartbeat thread keeps the stale-job
sweeper from resetting in-flight work.

In **Session A** (this session) the worker uses `StubHandler` — it fakes a
12-second job and returns a placeholder Box folder ID. In **Session B** the
stub is replaced by the real CV pipeline (download from Box → jersey OCR
→ clip cutting → upload to Box).

---

## First-time setup

```bash
cd "/Users/keithking/Movies/ESPN Equipment Tracker/worker"
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Then edit `.env` and fill in:

- `SUPABASE_URL` — from Supabase dashboard → **Project Settings → API**
- `SUPABASE_SERVICE_ROLE_KEY` — same place. **Never** the anon key — the
  worker bypasses RLS by design.

Make the launcher executable (one-time):

```bash
chmod +x run_worker.command
```

---

## Running

Two equivalent ways:

1. **Double-click `run_worker.command`** in Finder. It activates the venv
   and starts the worker in a Terminal window.
2. **From a terminal:** `source venv/bin/activate && python cusa_highlight_worker.py`

You should see a banner with hostname, temp dir, free GB, and concurrency
settings. The worker registers itself in `highlight_worker_registry`
(visible in Supabase Table Editor and in the Workers tab of
`highlight-admin.html`) and starts polling every `POLL_INTERVAL_SECONDS`.

**Stopping:** press **Ctrl-C** in the terminal. The worker marks itself
`shutdown` in the registry on the way out.

> **Caveat (macOS):** closing the Terminal window via the red close button
> does NOT reliably deliver SIGTERM. If that happens, the worker row stays
> `active` until the periodic stale sweep flips it to `stale` (after
> `last_seen_at` exceeds 5 minutes). Always prefer Ctrl-C.

---

## Multi-machine setup (Phase 2)

The architecture is designed for this from day one — there's nothing to
retrofit. To add a second worker:

1. Clone the repo on the second Mac (or shared NAS volume — the worker only
   needs Supabase access, not Box yet).
2. Run the same setup steps as above.
3. **If hostnames could collide**, set `WORKER_HOST` in that machine's
   `.env` to a unique string (e.g. `studio-mac-2`). Otherwise the worker
   defaults to `os.uname().nodename`, which is usually unique.
4. Set `WORKER_MAX_CONCURRENT_JOBS` higher on machines with more CPU/RAM.
   The stub doesn't honor this (it's still single-threaded inside one
   process), but Session B's real handler will run multiple jobs in
   parallel up to that cap.
5. Both machines share the same `highlight_requests` queue and use
   `claim_next_highlight_job` to safely claim distinct jobs — there is no
   shared state file, no lock file, no coordinator.

---

## Disk management

The worker writes any source/intermediate files to `WORKER_TEMP_DIR`
(default `/tmp/cusa_highlights`). Knobs in `.env`:

| Variable | Default | What it does |
|---|---|---|
| `WORKER_TEMP_DIR` | `/tmp/cusa_highlights` | Where downloads & intermediate files go. Move to a bigger drive by changing this and restarting. |
| `KEEP_SOURCE_ON_SUCCESS` | `false` | If true, source files are left on disk after a successful job (useful while debugging). |
| `KEEP_SOURCE_ON_FAILURE_HOURS` | `24` | After a failure, source files are kept this many hours so you can inspect them, then auto-deleted on the next worker start. |
| `MAX_TEMP_DISK_GB` | `100` | Quota cap. Session B raises `DiskQuotaExceeded` if temp dir size exceeds this. |

**Migrating temp dir to a bigger drive:** stop the worker (Ctrl-C),
edit `WORKER_TEMP_DIR` in `.env`, restart. No other config changes needed
— files in the old location are not migrated automatically; clean them up
by hand if you care.

In v1 (this session) the StubHandler does not actually use disk_manager;
the module exists so Session B can wire it in.

---

## Polling cadence

| Variable | Default | Notes |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `30` | How often the worker checks for new Approved jobs when idle. |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | How often a heartbeat thread bumps `last_heartbeat_at` while a job is in flight. Keep < 5 minutes (the stale threshold). |
| `STALE_SWEEP_INTERVAL_MINUTES` | `5` | How often each idle worker runs the stale-job sweep + stale-worker classification. |

---

## Verifying it works

1. With the worker running, open `highlight-admin.html` and switch to the
   **Workers** tab. You should see your hostname with status `active` and
   a fresh `last_seen_at`.
2. Submit a test request via `highlight.html`.
3. Approve it from the Pending tab in `highlight-admin.html`.
4. Within `POLL_INTERVAL_SECONDS`, the worker terminal should log
   `claimed job…`, run six 2-second heartbeat cycles, and finish with
   `Job complete`.
5. The admin UI's Active tab will show the row briefly, then it'll move
   to the Complete tab with `output_box_folder_id=STUB_FOLDER_12345` and
   `clip_count=0`.

> **Note:** clicking **Get Share Link** on a stub-completed row will fail
> because `STUB_FOLDER_12345` is not a real Box folder. That's expected
> in v1 — share-link minting works once Session B's real handler returns
> a real folder ID.
