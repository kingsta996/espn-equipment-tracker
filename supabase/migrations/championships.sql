-- ── Championships Page ────────────────────────────────────────────────────
-- Powers /championships.html (sport tabs + Schedule tab) and
-- /championships-admin.html (schedule editor + global Break Clock).
--
-- Data model:
--   championship_schedule    — one row per championship session (single-event
--                              sports have 1 row; bracket sports may have N).
--   championship_break_clock — singleton row with the URL/user/pass that
--                              auto-populates every sport tab.
--
-- Sport keys are stable slugs (cross-country, soccer, volleyball, football,
-- indoor-track-and-field, basketball, bowling, mens-tennis, womens-tennis,
-- womens-golf, beach-volleyball, mens-golf, softball,
-- outdoor-track-and-field, baseball). The display name + season are derived
-- client-side from a lookup table so renames don't require a migration.

create table if not exists championship_schedule (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  row_index int not null default 0,
  event_date text default '',
  event_time text default '',
  production_type text default '',  -- 'School' | 'Packager'
  venue text default '',
  athletic_year text default '2025-26',
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text,
  unique (sport, row_index, athletic_year)
);

alter table championship_schedule enable row level security;
drop policy if exists "public read championship schedule"  on championship_schedule;
drop policy if exists "public write championship schedule" on championship_schedule;
create policy "public read championship schedule"  on championship_schedule for select using (true);
create policy "public write championship schedule" on championship_schedule for all    using (true) with check (true);

create or replace function touch_championship_schedule_updated_at()
returns trigger language plpgsql as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;
drop trigger if exists championship_schedule_touch_updated_at on championship_schedule;
create trigger championship_schedule_touch_updated_at
  before update on championship_schedule
  for each row execute function touch_championship_schedule_updated_at();


create table if not exists championship_break_clock (
  id text primary key default 'singleton',
  url text default '',
  username text default '',
  password text default '',
  notes text default '',
  updated_at timestamptz default now(),
  updated_by text
);

alter table championship_break_clock enable row level security;
drop policy if exists "public read championship break clock"  on championship_break_clock;
drop policy if exists "public write championship break clock" on championship_break_clock;
create policy "public read championship break clock"  on championship_break_clock for select using (true);
create policy "public write championship break clock" on championship_break_clock for all    using (true) with check (true);

insert into championship_break_clock (id) values ('singleton') on conflict do nothing;


-- Realtime so admin edits propagate instantly to viewers on the sport tabs.
do $$ begin alter publication supabase_realtime add table championship_schedule;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table championship_break_clock;
  exception when duplicate_object then null; when undefined_table then null; end $$;
