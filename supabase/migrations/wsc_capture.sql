-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC capture tracking
--   wsc_capture_status — A/V Confirmed flag per schedule_event
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_capture_status (
  schedule_event_id uuid primary key references schedule_events(id) on delete cascade,
  av_confirmed      boolean     not null default false,
  confirmed_by      text,
  confirmed_at      timestamptz,
  encoder           text,        -- e.g. 'CUSA1' chosen for the broadcast
  notes             text,
  updated_at        timestamptz  not null default now()
);

alter table wsc_capture_status enable row level security;

drop policy if exists "public read wsc capture"  on wsc_capture_status;
drop policy if exists "public write wsc capture" on wsc_capture_status;
create policy "public read wsc capture"  on wsc_capture_status for select using (true);
create policy "public write wsc capture" on wsc_capture_status for all    using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table wsc_capture_status;
exception when duplicate_object then null; end $$;

-- Sanity check
select count(*) as wsc_capture_rows from wsc_capture_status;
