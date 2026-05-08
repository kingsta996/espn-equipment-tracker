-- ─────────────────────────────────────────────────────────────────────────
-- Migration: per-event dismissal flag for the WSC Capture Portal.
--   wsc_event_dismissals — non-destructive "this event won't be captured"
--   marker so a school user (Sam Houston, etc.) can drop a row from their
--   Manual Capture queue without admin approval. The underlying schedule
--   row in schedule_events / wsc_external_events stays intact.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_event_dismissals (
  event_id     text primary key,           -- matches the portal's id (handles uuid + ext_* + __test_*)
  dismissed_by text,
  dismissed_at timestamptz not null default now(),
  reason       text
);

create index if not exists wsc_event_dismissals_dismissed_at_idx
  on wsc_event_dismissals (dismissed_at desc);

alter table wsc_event_dismissals enable row level security;
drop policy if exists "public read wsc dismissals"  on wsc_event_dismissals;
drop policy if exists "public write wsc dismissals" on wsc_event_dismissals;
create policy "public read wsc dismissals"  on wsc_event_dismissals for select using (true);
create policy "public write wsc dismissals" on wsc_event_dismissals for all    using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table wsc_event_dismissals;
exception when duplicate_object then null; end $$;

-- Sanity check
select count(*) as dismissal_rows from wsc_event_dismissals;
