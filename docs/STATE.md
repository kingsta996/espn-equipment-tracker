# Highlight Request — implementation state

Snapshot of what was built in **Session A** (this branch) and what's deferred.

Legend:
- ✅ done in this session
- 🔧 stubbed — interface exists, real impl in Session B
- ⏳ deferred — not started, planned for Session B or Phase 3

---

## Session A — what was built

### SQL
- ✅ `supabase/migrations/highlight_requests.sql` — `highlight_requests`,
  `highlight_processing_log`, `highlight_worker_registry`,
  `claim_next_highlight_job()`, `sweep_stale_highlight_jobs()`,
  Realtime publication, indexes, RLS. Safe to re-run.
  - **Action item for Keith:** open the file in Supabase SQL Editor and Run.
    Confirm `highlight tables ready` is returned.

### Web
- ✅ `highlight.html` — public submission form. Loads `conference_schools`
  for the school + team dropdowns. Inserts to `highlight_requests` with
  `status='Pending'`. No auth required (mirrors `archive.html`).
- ✅ `highlight-admin.html` — six-tab admin queue. Pending / Active / Complete
  / Failed / Workers / All. Password gate against `admin_users` with the
  same legacy hash fallback as `archive-admin.html`. Realtime on
  `highlight_requests` AND `highlight_worker_registry`. Live badge counts on
  Pending / Active / Failed. Heartbeat-age column on Active flags stale rows
  red (>5 min). Workers tab includes a manual sweep button.
- ✅ `hub.html` AND `index.html` — Highlight Request card added (verified
  byte-identical via `diff`).
- ✅ `README.md` — short section pointing to `docs/HIGHLIGHT_FEATURE.md`.

### Netlify Function
- ✅ `netlify/functions/box-highlights.js` — actions: approve, decline,
  retry, force_reset, sweep_stale, delete, get_share_link. Auth via
  `verifyAdmin` against `admin_users` (matches `box-archive.js`). Reuses
  `BOX_CONFIG_JSON`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` env vars.
  Deps resolve from root `package.json` — no function-local deps.

### Worker
- ✅ `worker/cusa_highlight_worker.py` — main loop + lifecycle (banner,
  registry register, signal handlers, atexit hook, periodic stale sweep,
  heartbeat thread per job, polite shutdown).
- ✅ `worker/handlers/base.py` — Handler ABC + `HandlerResult` TypedDict.
- 🔧 `worker/handlers/stub_handler.py` — fakes 12s of work, returns
  `output_box_folder_id="STUB_FOLDER_12345"`. Real CV handler arrives
  in Session B.
- ✅ `worker/lib/supabase_client.py` — client init + `claim_next_job`,
  `heartbeat`, `mark_complete`, `mark_failed`, `sweep_stale`.
- ✅ `worker/lib/registry.py` — `register_worker`, `update_last_seen`,
  `mark_shutdown`, `mark_stale_workers`.
- ✅ `worker/lib/disk_manager.py` — full API (get_temp_dir, get_free_gb,
  check_space_for, cleanup_file, cleanup_old_files, get_temp_dir_size_gb,
  assert_within_quota). Module exists and is testable; the StubHandler
  doesn't exercise it, but Session B will.
- ✅ `worker/lib/logger.py` — `log_info`/`log_warn`/`log_error` writing to
  both `highlight_processing_log` and stdout.
- ✅ `worker/requirements.txt` — `supabase`, `python-dotenv` only.
  **No CV / video deps** — that's Session B's call.
- ✅ `worker/.env.example`, `worker/run_worker.command` (executable),
  `worker/.gitignore` (excludes `.env`, `venv/`, `__pycache__/`).
- ✅ `worker/README.md` — first-time setup, running, multi-machine
  setup, disk management, polling cadence, verification steps.

### Documentation
- ✅ `docs/HIGHLIGHT_FEATURE.md` — full architecture: user journey,
  components, data flow, schema, multi-worker design, phase plan, env
  vars, operational runbook, file reference.
- ✅ `docs/STATE.md` — this file.

---

## Verification checklist — run before Session B

- [ ] Open the SQL migration in Supabase SQL Editor and Run. Confirm
      `highlight tables ready` is returned and the three tables show up
      under Table Editor.
- [ ] Verify the Netlify deploy succeeded after the latest push (Deploys
      tab — should show green for the head commit).
- [ ] Set up worker venv:
  ```
  cd "/Users/keithking/Movies/ESPN Equipment Tracker/worker"
  python3 -m venv venv && source venv/bin/activate
  pip install -r requirements.txt
  cp .env.example .env
  # Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
  ```
- [ ] Run the worker: `python cusa_highlight_worker.py`. Confirm the
      banner shows worker_host, temp dir, free GB, and max concurrent.
      Confirm the row appears in `highlight_worker_registry` (Supabase
      Table Editor).
- [ ] Open `https://<your-netlify-site>/highlight.html`, submit a test
      request. Confirm a Pending row appears in `highlight_requests`.
- [ ] Open `https://<your-netlify-site>/highlight-admin.html`, sign in,
      and confirm the Pending tab shows your test request. Click
      **Approve**.
- [ ] Watch the worker terminal — within 30 seconds it should log
      `claimed job…`, run six 2-second heartbeat cycles, log `Job complete`,
      and update `highlight_requests.status` to `Complete`.
- [ ] Confirm the row moved to the Complete tab in the admin UI and
      that `output_box_folder_id` shows `STUB_FOLDER_12345`. Heartbeats
      should have visibly updated during processing.
- [ ] Click **🔗 Get Share Link** on the completed row — this is
      **expected to fail** because `STUB_FOLDER_12345` is not a real
      Box folder ID. Confirm the function returns a structured error
      ("Box API failed: …") rather than a 500.
- [ ] Press **Ctrl-C** in the worker terminal. Confirm
      `highlight_worker_registry.status` flips to `shutdown` for that
      hostname.
- [ ] Submit another test, approve, then kill the worker terminal **without
      Ctrl-C** mid-job. Wait 5+ minutes, then in the admin UI click **Run
      Stale Sweep Now** on the Workers tab. Confirm the orphaned row
      bounces back to Approved with an audit note in `error_message`.

---

## What Session B should tackle

Highest priority first.

1. **Replace `StubHandler` with the real CV pipeline.**
   Decisions to make in Session B:
   - Box client: stick with `box-node-sdk` (call from Node via subprocess)
     or use the Python Box SDK?
   - Frame sampling cadence (every 0.25s? on scene changes? motion-detected?)
   - Jersey OCR engine (PaddleOCR? a custom-trained YOLO+OCR pipeline?)
   - Color matching vs. jersey color (HSV thresholds per color value)
   - Clip cutting (ffmpeg subprocess vs. ffmpeg-python)
   - Output folder naming convention in Box

2. **Wire `disk_manager` into the real handler.** Check
   `get_free_gb` before downloading; `assert_within_quota` periodically;
   `cleanup_file` on success (subject to `KEEP_SOURCE_ON_SUCCESS`);
   `cleanup_old_files` honoring `KEEP_SOURCE_ON_FAILURE_HOURS`.

3. **Concurrency within a single worker.** Right now the loop is
   single-threaded (one job at a time per process). For machines with
   `WORKER_MAX_CONCURRENT_JOBS > 1`, run jobs in a thread pool and
   maintain `current_job_count`. The atomic claim + heartbeat thread
   already make this safe.

4. **Test multi-machine.** Spin up the worker on a second Mac, set
   `WORKER_HOST` to a unique value, submit several jobs at once, and
   confirm each row is claimed by exactly one worker. Watch the Workers
   tab for both rows turning green.

5. **(Optional) Email notifications.** Currently neither submission nor
   completion sends mail. Easiest path: add a "notify on complete"
   action to `box-highlights.js` that calls SendGrid / Mailgun / Resend.

6. **(Optional) Phase 3 prep.** If schools should self-serve highlight
   requests, gate `highlight.html` behind the `compliance.html`
   `submitPw()` flow against the `schools` table. The admin UI does not
   need to change.

---

## Known limitations of Phase 1

- **Share link minting will fail in v1** because the stub returns a
  fake Box folder ID. This is by design and disappears in Session B.
- **No email notifications** to either staff (on approval) or admin
  (on submission). Realtime keeps the admin queue live; staff have to
  ask.
- **`highlight.html` has no auth** — anyone with the URL can submit. Fine
  for an internal CUSA roll-out; revisit before opening to school
  contacts (Phase 3).
- **Closing the worker's Terminal window via the red ✕** doesn't always
  deliver SIGTERM. If that happens, the worker's row stays `active` until
  the periodic stale sweep flips it. The README documents this; always
  prefer Ctrl-C.
