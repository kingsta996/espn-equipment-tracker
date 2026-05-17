-- ── Championship Box File Request links ─────────────────────────────────
-- Per-sport list of Box File Request URLs that show up as upload buttons
-- inside the "📦 Resources" card on each sport tab of championships.html.
-- Admins edit them in championships-admin.html.
--
-- Trust model + RLS match the rest of the championship_* tables: public
-- read + public write, gated upstream by the admin login on
-- championships-admin.html.
--
-- Safe to re-run.

create table if not exists championship_box_links (
  id          uuid primary key default gen_random_uuid(),
  sport       text not null,             -- sport key (matches championship_schedule.sport)
  label       text not null,             -- e.g. "Broadcast Melts", "Highlight Reel"
  url         text not null,             -- Box File Request URL
  sort_order  int  not null default 0,
  notes       text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  updated_by  text
);

create index if not exists championship_box_links_sport_sort_idx
  on championship_box_links (sport, sort_order, created_at);

alter table championship_box_links enable row level security;
drop policy if exists "public read championship box links"  on championship_box_links;
drop policy if exists "public write championship box links" on championship_box_links;
create policy "public read championship box links"
  on championship_box_links for select using (true);
create policy "public write championship box links"
  on championship_box_links for all using (true) with check (true);

create or replace function touch_championship_box_links_updated_at()
returns trigger language plpgsql as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;
drop trigger if exists championship_box_links_touch_updated_at on championship_box_links;
create trigger championship_box_links_touch_updated_at
  before update on championship_box_links
  for each row execute function touch_championship_box_links_updated_at();

-- Realtime so admin edits propagate live to the public sport tabs.
do $$ begin alter publication supabase_realtime add table championship_box_links;
  exception when duplicate_object then null; when undefined_table then null; end $$;

select 'championship_box_links migration applied' as status;
