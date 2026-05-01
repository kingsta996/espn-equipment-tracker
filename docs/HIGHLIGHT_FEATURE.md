# Highlight Request — architecture, schema, and runbook

The Highlight Request feature lets CUSA staff request automated player-specific
highlight clips from a Box game film by jersey number and color. Approved
requests are claimed by a Python worker on a CUSA Mac, which produces a Box
folder of clips and surfaces a 30-day shared link in the admin UI.

This document describes everything in **Phase 1** (Session A): the web layer,
the admin queue, the Netlify Function, the Python worker scaffold, and the
multi-worker design that makes it safe to add more machines later. The actual
computer vision pipeline arrives in **Phase 2** (Session B).

---

## User journey

1. **Staff member** opens [`highlight.html`](../highlight.html) and submits a
   request: their name + email, the Box file ID of the game film, the
   player's jersey number and color, and optional context (team, game,
   notes). The form inserts a row into `highlight_requests` with
   `status='Pending'`.
2. **Admin** (Keith / Kelly) opens [`highlight-admin.html`](../highlight-admin.html),
   reviews the Pending tab in real time (Supabase Realtime), and either:
   - **Approves** the request → status flips to `Approved`. The next
     idle worker will claim it.
   - **Declines** with an optional reason → status flips to `Declined`.
3. **Worker** on a CUSA Mac polls Supabase, atomically claims the next
   `Approved` job (`status='Processing'`, `worker_host` stamped), runs the
   handler, and writes the output:
   - On success: `status='Complete'`, `output_box_folder_id`,
     `output_clip_count`, `output_metadata`.
   - On failure: `status='Failed'`, `error_message`.
4. **Admin** sees the row move to the Complete (or Failed) tab in real time.
   For Complete rows, clicking **Get Share Link** mints a 30-day Box shared
   link on the output folder and opens it in a new tab — that's the URL
   shared with the requester.

---

## Component inventory

| Component | Path | Role |
|---|---|---|
| Submission page | [`highlight.html`](../highlight.html) | Public form, anyone-can-submit. Inserts to `highlight_requests` with anon key. |
| Admin queue | [`highlight-admin.html`](../highlight-admin.html) | Password-gated (admin_users). Six tabs (Pending / Active / Complete / Failed / Workers / All), Realtime on requests + worker_registry. |
| Netlify Function | [`netlify/functions/box-highlights.js`](../netlify/functions/box-highlights.js) | Action dispatcher: approve, decline, retry, force_reset, sweep_stale, delete, get_share_link. Mints Box shared links via `box-node-sdk`. |
| SQL migration | [`supabase/migrations/highlight_requests.sql`](../supabase/migrations/highlight_requests.sql) | Tables, indexes, RPCs, Realtime publication. |
| Hub tile | [`hub.html`](../hub.html) / [`index.html`](../index.html) | Linked card on the Production Hub landing page. |
| Worker | [`worker/`](../worker/) | Python multi-worker-safe job processor with StubHandler in v1. |

---

## Data flow

```
[Staff/User]                                                    [Admin = Keith]
     │                                                                │
     │ 1. Submit form                                                 │
     ▼                                                                │
[highlight.html] ────insert (status='Pending')──▶ [Supabase]          │
                                                       │              │
                                                       │ Realtime     │
                                                       ▼              │
                                              [highlight-admin.html]──┘
                                                       │ 2. Approve
                                                       │
                                                       ▼
                                            [box-highlights Function]
                                                       │
                                                       │ status='Approved'
                                                       ▼
                                                  [Supabase]
                                                       │
                                                       │ Polling
                                                       ▼
                                       [Python Worker on Keith's Mac]
                                                       │
                                                       │ 3. Atomic claim
                                                       │    (FOR UPDATE SKIP LOCKED)
                                                       │    status='Processing'
                                                       │
                                                       │ 4. Download from Box (Session B)
                                                       │ 5. CV pipeline (Session B)
                                                       │ 6. Upload clips to Box (Session B)
                                                       ▼
                                                  [Supabase]
                                                       │ status='Complete'
                                                       │ output_box_folder_id set
                                                       ▼
                                              [highlight-admin.html]
                                                       │ 7. Get share link
                                                       ▼
                                            [box-highlights Function]
                                                       │
                                                       ▼
                                              [Box shared link URL]
```

---

## Schema

All defined in [`supabase/migrations/highlight_requests.sql`](../supabase/migrations/highlight_requests.sql).

### `highlight_requests`

The single source of truth for a request through its full lifecycle.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `submitted_at` | timestamptz | Defaults to `now()`. |
| `requester_email` | text NOT NULL | Phase 3 will validate against `schools.auth_email`. |
| `requester_name` | text | |
| `requester_school` | text | Free text in v1; populated from `conference_schools` dropdown. |
| `box_file_id` | text NOT NULL | The Box file ID of the source game film. |
| `box_file_name` | text | Optional, helps admin recognize the file. |
| `jersey_number` | text NOT NULL | Text, not int — leading zeros matter. |
| `jersey_color` | text NOT NULL | White / Navy / Red / Black / Gray / Color (other). |
| `team` | text | Optional. |
| `game_context` | text | Optional, e.g. "WKU vs Liberty 2025-10-12". |
| `notes` | text | Optional. The Function appends admin notes here on approve. |
| `status` | text NOT NULL | Pending / Approved / Processing / Complete / Failed / Declined. |
| `approved_by` | text | Admin email recorded on approve or decline. |
| `approved_at` | timestamptz | |
| `declined_reason` | text | |
| `declined_at` | timestamptz | |
| `processing_started_at` | timestamptz | Set by `claim_next_highlight_job` RPC. |
| `processing_completed_at` | timestamptz | Set by `mark_complete` / `mark_failed`. |
| `worker_host` | text | Which worker claimed the job. |
| `last_heartbeat_at` | timestamptz | Bumped by the worker's heartbeat thread. Used by stale sweeper. |
| `output_box_folder_id` | text | Set by the worker when complete. Used by `get_share_link`. |
| `output_clip_count` | int | Set by the worker. |
| `output_metadata` | jsonb | Worker-defined extras. |
| `error_message` | text | Set when status='Failed' or by force_reset / sweep. |

Indexes: `(status)`, `(submitted_at desc)`, partial index on `(last_heartbeat_at) where status='Processing'`.

RLS: anon can insert + select + update (matches the rest of the project's
public-by-default RLS posture; the Function uses the service-role key for
sensitive operations).

### `highlight_processing_log`

Append-only log of worker activity for a request.

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `request_id` | uuid FK | `on delete cascade` from `highlight_requests`. |
| `worker_host` | text | |
| `level` | text | `info` / `warn` / `error`. Constrained by check. |
| `message` | text NOT NULL | |
| `details` | jsonb | Optional. |
| `logged_at` | timestamptz | |

### `highlight_worker_registry`

One row per machine that has ever started a worker. Keyed by hostname.

| Column | Type | Notes |
|---|---|---|
| `worker_host` | text PK | `os.uname().nodename` by default; override via `WORKER_HOST`. |
| `started_at` | timestamptz | |
| `last_seen_at` | timestamptz | Updated every poll. |
| `status` | text NOT NULL | `active` / `shutdown` / `stale`. |
| `max_concurrent_jobs` | int | From `WORKER_MAX_CONCURRENT_JOBS`. |
| `current_job_count` | int | Updated as jobs are claimed/finished. |
| `details` | jsonb | Reserved for future per-worker metadata. |

### RPCs

`claim_next_highlight_job(p_worker_host text)` — atomic claim. Wraps an
`UPDATE … WHERE id = (SELECT id FROM highlight_requests WHERE status='Approved'
ORDER BY submitted_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. The
`SKIP LOCKED` is what makes this multi-worker safe: if two workers race, only
one gets a row; the other gets nothing and tries again on the next poll.

`sweep_stale_highlight_jobs(p_stale_minutes int default 5)` — flips any
`Processing` row whose `last_heartbeat_at` is older than the threshold back
to `Approved`, clearing `worker_host`/`processing_started_at`/`last_heartbeat_at`
and appending an audit note to `error_message`. Returns the number reset.

Both RPCs are `SECURITY DEFINER`, executable by anon/authenticated/service_role.

---

## Multi-worker design

Three guarantees, in order of importance:

1. **No double-claim.** `claim_next_highlight_job` does the entire claim in a
   single SQL statement using `FOR UPDATE SKIP LOCKED`. Two workers polling
   simultaneously cannot both end up on the same row — Postgres hands the row
   to whoever got the row-level lock first; the loser sees an empty result and
   continues polling.
2. **Dead workers don't block the queue.** Every active worker runs a
   heartbeat thread that bumps `last_heartbeat_at` every
   `HEARTBEAT_INTERVAL_SECONDS` (default 30s) while a job is in flight. If a
   worker crashes mid-job, the heartbeat stops; within `STALE_SWEEP_INTERVAL_MINUTES`
   (default 5 min) any other idle worker (or the admin's manual sweep button)
   will call `sweep_stale_highlight_jobs` and the job goes back to `Approved`,
   ready to be re-claimed.
3. **Idempotent worker registry.** Every worker upserts itself into
   `highlight_worker_registry` on startup with `status='active'`. Periodic
   `update_last_seen` calls keep that row fresh; the same RPC promotes
   `stale` rows back to `active` if the worker returns. On graceful shutdown
   (Ctrl-C / SIGTERM), the worker sets `status='shutdown'`. Workers whose
   `last_seen_at` is older than the stale threshold are flipped to `stale`
   by any other worker's periodic sweep — an active row that's actually dead
   won't pin a stale label on itself, but a peer or the admin sweep will.

The admin UI's **Workers** tab shows this state live, including a manual
**Run Stale Sweep Now** button that calls the RPC via the Function.

---

## Phase plan

### Phase 1 — Session A (this session)

✅ Web layer (submission + admin queue) live.
✅ Netlify Function dispatches all admin actions.
✅ SQL migration applied (run manually in Supabase SQL Editor).
🔧 Worker uses **StubHandler** — fakes a 12-second job, returns a placeholder
folder ID. End-to-end flow is testable; share-link minting against the stub
ID will fail (expected).
⏳ Single-machine deployment — only Keith's Mac runs a worker.

### Phase 2 — Session B (next)

- Replace `StubHandler` with the real CV pipeline:
  - Box download via the existing `box-node-sdk` JWT app (or the Python
    Box SDK, TBD)
  - Frame sampling + jersey OCR (likely PaddleOCR or similar)
  - Color-aware filtering by `jersey_color`
  - Clip cutting (likely ffmpeg)
  - Box upload of clips into a fresh per-request folder
- Add CV / video deps to `worker/requirements.txt`
- Wire `disk_manager` quotas + cleanup into the real flow
- Test on a second Mac to validate multi-worker claim safety in practice
- (Optional) parallelism within a single worker process up to
  `WORKER_MAX_CONCURRENT_JOBS`

### Phase 3 — Future

- Open submission to schools. Today, `highlight.html` is anyone-can-submit
  (matches `archive.html`'s posture). To restrict to authorized school
  contacts, mirror `compliance.html`'s `submitPw()` flow against the
  `schools` table (NOT `conference_schools`):
  - Email gate: lookup `schools` by lowercased input → row required
  - Password gate: `crypto.subtle.digest('SHA-256', input)` matches
    `schools.pw_hash`
- Once authenticated, the form can pre-fill `requester_email`,
  `requester_name`, `requester_school` from the school row and submit
  without further validation. The admin UI requires no changes for this.

---

## Environment variables

### Netlify (already set for `box-archive`; reused as-is)

| Variable | Where used | Notes |
|---|---|---|
| `SUPABASE_URL` | `box-highlights.js` | Project URL. |
| `SUPABASE_SERVICE_KEY` | `box-highlights.js` | Service-role key. **Not** the anon key. |
| `BOX_CONFIG_JSON` | `box-highlights.js` | Full JSON contents of the JWT app `config.json`. |

### Supabase

| Project setting | Notes |
|---|---|
| `supabase_realtime` publication | Includes `highlight_requests`, `highlight_processing_log`, `highlight_worker_registry`. The migration adds them idempotently. |
| RLS | Public read+write+update on the three tables. Worker uses service-role key, so RLS is irrelevant on its calls. |

### Worker (`.env` in `worker/`)

| Variable | Default | Notes |
|---|---|---|
| `SUPABASE_URL` | — | Required. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Required. NB: name differs from Netlify's `SUPABASE_SERVICE_KEY` because the worker `.env` is independent and uses Supabase's official label. |
| `WORKER_HOST` | `os.uname().nodename` | Override only if hostnames could collide. |
| `WORKER_MAX_CONCURRENT_JOBS` | `1` | Concurrency cap (StubHandler ignores; Session B honors). |
| `WORKER_TEMP_DIR` | `/tmp/cusa_highlights` | Source/intermediate file location. |
| `KEEP_SOURCE_ON_SUCCESS` | `false` | If true, source files are kept after success. |
| `KEEP_SOURCE_ON_FAILURE_HOURS` | `24` | Source files retained this long after a failure for debugging. |
| `MAX_TEMP_DISK_GB` | `100` | Quota cap. |
| `POLL_INTERVAL_SECONDS` | `30` | Idle poll cadence. |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | Keep < 5 minutes (the stale threshold). |
| `STALE_SWEEP_INTERVAL_MINUTES` | `5` | Sweep cadence + stale threshold. |

---

## Operational runbook

### Check worker status

- Open `highlight-admin.html` → **Workers** tab. Active workers have green
  `active` pills and a fresh `last_seen_at`. Anything red means the
  heartbeat is stale.
- Or query Supabase directly:
  ```sql
  select worker_host, status, last_seen_at, current_job_count
  from highlight_worker_registry
  order by last_seen_at desc;
  ```

### Retry a failed job

- Failed tab → click **Retry** on the row. The Function clears
  `error_message`, `processing_started_at`, `processing_completed_at`,
  `worker_host`, `last_heartbeat_at` and flips status back to `Approved`.
  The next idle worker will claim it.

### Handle a stuck job (worker presumed dead)

- Active tab → if Heartbeat Age is red (> 5 min), click **Force-Reset** on
  the row. This clears the worker fields and stamps an audit note in
  `error_message` so you can see the row was reset by hand.
- Alternatively, click **Run Stale Sweep Now** on the Workers tab — that
  calls `sweep_stale_highlight_jobs` which resets every stale Processing
  row in one shot.

### Manually run a stale sweep

- Workers tab → **⚡ Run Stale Sweep Now**. Threshold defaults to 5 minutes
  (matches `STALE_SWEEP_INTERVAL_MINUTES`).

### Mint a share link for a completed job

- Complete tab → **🔗 Get Share Link**. Opens the minted Box URL in a new
  tab and shows the 30-day expiration in the toast. Copy the URL from the
  browser and email it to the requester.

### Cancel / delete a job

- Failed tab → **Delete** removes the row (cascades to log entries).
  Use this for dev-only test rows, not for real declined requests
  (those should use the Decline action so the audit trail is preserved).

---

## File reference

```
.
├── highlight.html                              # public submission form
├── highlight-admin.html                        # admin queue (password-gated)
├── hub.html / index.html                       # tile linking to highlight.html
├── netlify/functions/box-highlights.js         # action dispatcher
├── supabase/migrations/highlight_requests.sql  # tables + RPCs + Realtime
├── worker/
│   ├── cusa_highlight_worker.py                # main loop + lifecycle
│   ├── handlers/{base,stub_handler}.py         # Handler interface + v1 stub
│   ├── lib/{supabase_client,registry,disk_manager,logger}.py
│   ├── requirements.txt                        # supabase + python-dotenv
│   ├── .env.example
│   ├── run_worker.command                      # double-clickable launcher
│   └── README.md                               # operator setup
└── docs/HIGHLIGHT_FEATURE.md                   # this file
```
