-- ─────────────────────────────────────────────────────────────────────────
-- Migration: external-source events for the WSC Capture Portal
--   wsc_external_events — events scraped from school athletics sites
--   (SHSU's Nuxt API, etc.) that aren't in the ESPN Broadcast Schedule
--   submission tool. Cross-referenced with schedule_events in the portal.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_external_events (
  id           text primary key,        -- e.g. 'shsu-wsoc-2026-08-14-stephen-f-austin'
  source       text not null,           -- 'shsu-api', 'sidearm-ics', etc.
  school       text not null,           -- canonical CUSA school (matches wsc_data.json)
  sport        text not null,           -- 'Football' / 'Soccer' / 'Volleyball' / 'Baseball' / 'Softball' / "Men's Basketball" / "Women's Basketball"
  event_date   date not null,
  event_time   text,
  home         text,
  away         text,
  conference   text,                    -- 'Conference USA' / 'Non-Conference'
  network      text,                    -- usually empty for non-broadcast scrapes
  notes        text,
  refreshed_at timestamptz not null default now()
);

create index if not exists wsc_external_events_date_idx
  on wsc_external_events (event_date);
create index if not exists wsc_external_events_school_idx
  on wsc_external_events (school);

alter table wsc_external_events enable row level security;
drop policy if exists "public read wsc external events"  on wsc_external_events;
drop policy if exists "public write wsc external events" on wsc_external_events;
create policy "public read wsc external events"  on wsc_external_events for select using (true);
create policy "public write wsc external events" on wsc_external_events for all    using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table wsc_external_events;
exception when duplicate_object then null; end $$;

-- Sanity check
select count(*) as external_event_rows from wsc_external_events;
