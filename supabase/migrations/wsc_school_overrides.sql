-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC school reference-data overrides
--   wsc_school_overrides — admin-edited HLS / SRT / contacts per school.
--   Merged on top of the static wsc_data.json at portal load.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_school_overrides (
  school     text primary key,         -- canonical school name (matches wsc_data.json)
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table wsc_school_overrides enable row level security;

drop policy if exists "public read wsc school overrides"  on wsc_school_overrides;
drop policy if exists "public write wsc school overrides" on wsc_school_overrides;
create policy "public read wsc school overrides"  on wsc_school_overrides for select using (true);
create policy "public write wsc school overrides" on wsc_school_overrides for all    using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table wsc_school_overrides;
exception when duplicate_object then null; end $$;

-- Sanity check
select count(*) as override_rows from wsc_school_overrides;
