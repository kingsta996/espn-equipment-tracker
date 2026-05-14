-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC Championships tab
--   wsc_championship_events — manually-added CUSA championship events.
--   ESPN-API-detected championships are merged in client-side from the
--   existing wsc_espn_events table (no extra storage needed).
--   Encoder bookings & A/V Confirmed continue to live in
--   wsc_capture_status, whose schedule_event_id column is already TEXT
--   (see wsc_capture_event_id_text.sql), so championship rows participate
--   in the same encoder-conflict picture as Manual Capture + Master
--   Schedule overrides without further schema changes.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_championship_events (
  id           uuid primary key default gen_random_uuid(),
  -- Champ type: 'team' (Football/Soccer/VB/MBB/WBB/Baseball/Softball — has away+home)
  --             or 'solo' (Bowling/Golf/Tennis/XC/Track & Field — CUSA-titled, no teams)
  champ_type   text not null check (champ_type in ('team', 'solo')),
  sport        text not null,
  event_date   date not null,
  event_time   text,        -- free-form, mirrors schedule_events.event_time
  title        text,        -- for 'solo': e.g., "CUSA Tennis Championship — Semifinal"
  away_team    text,        -- for 'team': road team
  home_team    text,        -- for 'team': host school
  network      text,
  round_text   text,        -- "Semifinal", "Championship", "Round 1", etc.
  notes        text,
  archived     boolean not null default false,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists wsc_championship_events_date_idx
  on wsc_championship_events (event_date);
create index if not exists wsc_championship_events_sport_idx
  on wsc_championship_events (sport);

alter table wsc_championship_events enable row level security;

drop policy if exists "public read wsc champ"  on wsc_championship_events;
drop policy if exists "public write wsc champ" on wsc_championship_events;
create policy "public read wsc champ"  on wsc_championship_events for select using (true);
create policy "public write wsc champ" on wsc_championship_events for all    using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table wsc_championship_events;
exception when duplicate_object then null; end $$;

-- Sanity check
select count(*) as wsc_championship_event_rows from wsc_championship_events;
