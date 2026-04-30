-- ─────────────────────────────────────────────────────────────────────────
-- Migration: Broadcast Melts admin tables
--   melt_config  — per-sport File Request URL (admin-editable)
--   melt_uploads — tracks which schedule_events have a broadcast melt
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists melt_config (
  sport text primary key,
  file_request_url text default '',
  notes text,
  updated_at timestamptz default now(),
  updated_by text
);

alter table melt_config enable row level security;
drop policy if exists "public read melt config"  on melt_config;
drop policy if exists "public write melt config" on melt_config;
create policy "public read melt config"  on melt_config for select using (true);
create policy "public write melt config" on melt_config for all    using (true) with check (true);

insert into melt_config (sport) values
  ('Football'),
  ('Men''s Basketball'),
  ('Women''s Basketball'),
  ('Volleyball'),
  ('Women''s Soccer'),
  ('Baseball'),
  ('Softball')
on conflict (sport) do nothing;

create table if not exists melt_uploads (
  id uuid primary key default gen_random_uuid(),
  schedule_event_id uuid references schedule_events(id) on delete cascade,
  filename text,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  notes text,
  unique (schedule_event_id)
);

alter table melt_uploads enable row level security;
drop policy if exists "public read melt uploads"  on melt_uploads;
drop policy if exists "public write melt uploads" on melt_uploads;
create policy "public read melt uploads"  on melt_uploads for select using (true);
create policy "public write melt uploads" on melt_uploads for all    using (true) with check (true);

do $$ begin alter publication supabase_realtime add table melt_config;  exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table melt_uploads; exception when duplicate_object then null; end $$;

-- Sanity check
select sport, file_request_url from melt_config order by sport;
