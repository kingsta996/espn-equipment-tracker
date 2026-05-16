-- ── Master Sponsorships ───────────────────────────────────────────────────
-- Powers /sponsorships.html (admin-only at kking + jbryant) and the per-sport
-- Sponsors card on /championships.html.
--
-- Data model:
--   sponsors                    — directory of sponsor accounts (name, logo,
--                                 optional Commercial Hub link, notes).
--   championship_sponsorships   — assignment per (sport, sponsor, usage).
--                                 Usage values are pulled from the 2025-26
--                                 ESPN+ CUSA Sales Inventory PDF.
--
-- Usage values (kept client-side as a constant list — not enforced at DB
-- level so we can iterate on the inventory without migrations):
--   In-Game: Starting Lineups, Keys to the Game, Players to Watch / Impact
--            Players, First Half Stats, Conference Standings, Upcoming
--            Schedule, Trivia Question, Series History, Player of the Game,
--            Play of the Game, Game Track, Player Spotlight / Player Bio,
--            Game Summary, Post-Game Interview
--   Halftime: First Half Tune-In, Halftime Report, First Half Highlights
-- ESPN cap: max 6 sales features per event (UI-level soft warning).

create table if not exists sponsors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text default '',           -- data URL or external URL
  commercial_id uuid references commercials(id) on delete set null,
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text
);
create index if not exists sponsors_name_idx on sponsors (lower(name));

alter table sponsors enable row level security;
drop policy if exists "public read sponsors"  on sponsors;
drop policy if exists "public write sponsors" on sponsors;
create policy "public read sponsors"  on sponsors for select using (true);
create policy "public write sponsors" on sponsors for all    using (true) with check (true);

create or replace function touch_sponsors_updated_at()
returns trigger language plpgsql as $$
begin NEW.updated_at = now(); return NEW; end;
$$;
drop trigger if exists sponsors_touch_updated_at on sponsors;
create trigger sponsors_touch_updated_at
  before update on sponsors
  for each row execute function touch_sponsors_updated_at();


create table if not exists championship_sponsorships (
  id uuid primary key default gen_random_uuid(),
  sport text not null,                                -- slug, e.g. 'football'
  sponsor_id uuid not null references sponsors(id) on delete cascade,
  usage text not null default '',                     -- ESPN inventory slot
  status text not null default 'pending'
    check (status in ('pending','confirmed','tbd','cancelled')),
  notes text default '',
  athletic_year text default '2025-26',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text,
  unique (sport, sponsor_id, usage, athletic_year)
);
create index if not exists champ_spons_sport_idx on championship_sponsorships (sport);

alter table championship_sponsorships enable row level security;
drop policy if exists "public read champ sponsorships"  on championship_sponsorships;
drop policy if exists "public write champ sponsorships" on championship_sponsorships;
create policy "public read champ sponsorships"  on championship_sponsorships for select using (true);
create policy "public write champ sponsorships" on championship_sponsorships for all    using (true) with check (true);

create or replace function touch_champ_sponsorships_updated_at()
returns trigger language plpgsql as $$
begin NEW.updated_at = now(); return NEW; end;
$$;
drop trigger if exists champ_sponsorships_touch_updated_at on championship_sponsorships;
create trigger champ_sponsorships_touch_updated_at
  before update on championship_sponsorships
  for each row execute function touch_champ_sponsorships_updated_at();


-- Realtime so admin edits propagate instantly to the public Championships page.
do $$ begin alter publication supabase_realtime add table sponsors;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table championship_sponsorships;
  exception when duplicate_object then null; when undefined_table then null; end $$;


-- Seed Jordan Bryant into admin_users so the Master Sponsorship page works
-- out of the box. Uses the default admin password (Keith's hash); Jordan can
-- self-rotate from admin.html. Keith's row already exists from earlier
-- seeds (keithmkingjr@gmail.com).
insert into admin_users (email, pw_hash, display_name) values
  ('kking@conferenceusa.com',    '9a874f8b06ebb0eb63336db78b70ca149513a237de8395d8e858ee8f0c702ae2', 'Keith King'),
  ('jbryant@conferenceusa.com',  '9a874f8b06ebb0eb63336db78b70ca149513a237de8395d8e858ee8f0c702ae2', 'Jordan Bryant')
on conflict (email) do update set
  display_name = excluded.display_name,
  is_active = true;
