-- ─────────────────────────────────────────────────────────────────────────
-- wsc_requests.sql
--
-- Self-service request log for wsc-request.html, the staff-facing portal
-- where non-admins can schedule a WSC capture from a Teams chat tab.
--
-- The actual technical schedule lives in wsc_espn_macros (one row per
-- scheduled ESPN-search macro fire). This table adds the *who-asked-for-it*
-- + Clipro-confirmation context that the macro row doesn't capture:
--   - staff identity (initials + optional full name) — shared-login portal,
--     so no per-user auth identifies the requester
--   - school / opponent / sport — denormed so admins can see the matchup
--     in human terms without joining ESPN events
--   - link back to the wsc_espn_macros row that was created
--
-- A row is written when the staff member clicks "Confirm scheduled in
-- Clipro" — Clipro is the source of truth, so the log only records
-- requests that made it all the way through.
--
-- Inserts only happen via the wsc-request Netlify function (service-role
-- key bypasses RLS). RLS exposes anon SELECT so admin pages can render the
-- "Recent Requests" panel client-side with the anon key, matching the
-- pattern already used for wsc_espn_macros.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_requests (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  staff_initials  text not null check (length(staff_initials) between 1 and 12),
  staff_name      text,
  school          text not null check (length(school) between 1 and 80),
  opponent        text not null check (length(opponent) between 1 and 80),
  sport           text not null check (length(sport) between 1 and 40),
  espn_macro_id   uuid references wsc_espn_macros(id) on delete set null,
  encoder_id      text not null check (encoder_id ~ '^CUSA([1-9]|10)$'),
  search_query    text,
  result_index    int,
  kickoff_at      timestamptz not null,
  trigger_at      timestamptz,
  notes           text
);

create index if not exists wsc_requests_kickoff_idx on wsc_requests(kickoff_at desc);
create index if not exists wsc_requests_school_idx  on wsc_requests(school);
create index if not exists wsc_requests_macro_idx   on wsc_requests(espn_macro_id);

alter table wsc_requests enable row level security;

drop policy if exists wsc_requests_select on wsc_requests;
create policy wsc_requests_select on wsc_requests
  for select to anon using (true);
-- No anon INSERT/UPDATE/DELETE policy — writes require service-role key
-- (set on the wsc-request Netlify function).
