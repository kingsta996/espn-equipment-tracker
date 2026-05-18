-- ─────────────────────────────────────────────────────────────────────────
-- wsc_laptop_dispatches.sql
--
-- Queue table for the OBS+RTMP browser-on-laptop capture path. Replaces
-- the Roku ECP macro pipeline for staff self-service requests (the Roku
-- path stays in wsc-portal admin tooling for now).
--
-- One row per scheduled "open the ESPN watch URL in a browser on
-- LAPTOP-A or LAPTOP-B at trigger_at" job. A small Python agent runs on
-- each laptop, polls Supabase for its pending rows, and at trigger_at
-- opens the URL via macOS `open` command + flips status to 'launched'.
--
-- Pairing with wsc_requests: confirmed self-service requests reference
-- the dispatch row via wsc_requests.laptop_dispatch_id (added in the
-- wsc_requests_v3 migration alongside this one).
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_laptop_dispatches (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by_email   text not null,
  laptop_id          text not null check (laptop_id in ('LAPTOP-A', 'LAPTOP-B')),
  espn_event_id      text references wsc_espn_events(espn_event_id) on delete set null,
  matchup_label      text,                     -- 'Liberty @ MTSU' for the queue view
  sport              text,                     -- denorm of event.sport at schedule time
  launch_url         text not null,            -- the URL the agent will open in the browser
  trigger_at         timestamptz not null,     -- when the agent should open the URL
  kickoff_at         timestamptz,              -- for human readability + sort
  status             text not null default 'pending'
                       check (status in ('pending', 'launched', 'completed', 'failed', 'canceled')),
  launched_at        timestamptz,              -- set by the agent when it opens the URL
  result_log         jsonb,                    -- agent's report (exit code, browser pid, etc.)
  notes              text
);

create index if not exists wsc_laptop_dispatches_trigger_idx
  on wsc_laptop_dispatches(trigger_at)
  where status = 'pending';
create index if not exists wsc_laptop_dispatches_laptop_idx
  on wsc_laptop_dispatches(laptop_id, kickoff_at);
create index if not exists wsc_laptop_dispatches_kickoff_idx
  on wsc_laptop_dispatches(kickoff_at desc);
create index if not exists wsc_laptop_dispatches_event_idx
  on wsc_laptop_dispatches(espn_event_id);

alter table wsc_laptop_dispatches enable row level security;

-- Anon SELECT — the wsc-request page reads this for conflict detection
-- and the admin pages render queue views from it.
drop policy if exists wsc_laptop_dispatches_select on wsc_laptop_dispatches;
create policy wsc_laptop_dispatches_select on wsc_laptop_dispatches
  for select to anon using (true);

-- Anon INSERT — the wsc-request Netlify function uses the service-role
-- key, but we keep anon INSERT permissive to match the existing
-- wsc_espn_macros pattern (the trust boundary is the auth-gated
-- function, not the table policy).
drop policy if exists wsc_laptop_dispatches_insert on wsc_laptop_dispatches;
create policy wsc_laptop_dispatches_insert on wsc_laptop_dispatches
  for insert to anon with check (true);

-- Anon UPDATE — the Python agent on each laptop uses the anon key to
-- flip status to 'launched' / write result_log when the browser opens.
drop policy if exists wsc_laptop_dispatches_update on wsc_laptop_dispatches;
create policy wsc_laptop_dispatches_update on wsc_laptop_dispatches
  for update to anon using (true) with check (true);

drop policy if exists wsc_laptop_dispatches_delete on wsc_laptop_dispatches;
create policy wsc_laptop_dispatches_delete on wsc_laptop_dispatches
  for delete to anon using (true);
