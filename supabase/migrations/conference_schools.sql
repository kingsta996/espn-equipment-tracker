-- ─────────────────────────────────────────────────────────────────────────
-- Migration: conference_schools
-- Drives CUSA viewership rankings, School Search, and the CUSA-Produced
-- Only filter on admin.html and viewership.html. Replaces the hardcoded
-- CUSA_SCHOOLS / CUSA_ALIAS / PROD_SCHOOL_MAP lists. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists conference_schools (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  aliases text[] default '{}',
  sort_order int default 100,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table conference_schools enable row level security;
drop policy if exists "public read conference schools"  on conference_schools;
drop policy if exists "public write conference schools" on conference_schools;
create policy "public read conference schools"  on conference_schools for select using (true);
create policy "public write conference schools" on conference_schools for all    using (true) with check (true);

insert into conference_schools (name, aliases) values
  ('Dallas Baptist',        ARRAY['DBU','Dallas Baptist University']),
  ('Delaware',              ARRAY[]::text[]),
  ('Florida International', ARRAY['FIU']),
  ('Jacksonville State',    ARRAY['JSU','Jax State']),
  ('Kennesaw State',        ARRAY['KSU']),
  ('Liberty',               ARRAY[]::text[]),
  ('Middle Tennessee',      ARRAY['MTSU','Mid Tenn','Middle Tenn']),
  ('Missouri State',        ARRAY[]::text[]),
  ('New Mexico State',      ARRAY['NMSU']),
  ('Sam Houston',           ARRAY['SHSU','Sam Houston State']),
  ('Western Kentucky',      ARRAY['WKU'])
on conflict (name) do nothing;

-- Remove schools no longer in CUSA so the directory stays accurate on
-- existing databases that previously seeded them.
delete from conference_schools where name in ('Louisiana Tech','UTEP');

do $$
begin
  alter publication supabase_realtime add table conference_schools;
exception when duplicate_object then null;
end $$;

-- Sanity check — should return 11 rows after the seed.
select name, aliases from conference_schools order by name;
