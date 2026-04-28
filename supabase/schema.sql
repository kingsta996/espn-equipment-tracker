-- CUSA ESPN Compliance Dashboard — Database Schema
-- Run this in Supabase Studio: SQL Editor → New Query → paste → Run

-- ── Schools ────────────────────────────────────────────────────────────────
create table if not exists schools (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  conference text default 'CUSA',
  auth_email text,
  sports text[] default '{}',
  -- Switcher
  sw_model text, sw_inputs int default 0, sw_keyers int default 0, sw_mes numeric default 0,
  -- Cameras
  cameras int default 0, camera_models text,
  cam_football int default 0, cam_basketball int default 0, cam_volleyball int default 0,
  cam_soccer int default 0, cam_baseball int default 0, cam_softball int default 0,
  -- Lenses
  has_40x_lens boolean default false, lens_detail text, has_14x_lens boolean default false,
  -- Replay
  replay_model text, replay_units int default 0, replay_inputs int default 0, replay_outputs int default 0,
  -- Audio
  audio_model text, audio_inputs int default 0, audio_outputs int default 0, audio_faders int default 0,
  -- Intercom
  intercom_model text, intercom_ch int default 0,
  -- Graphics
  gfx_model text, gfx_channels int default 0, gfx_approved boolean default true,
  -- Transmission
  tx_digital text default 'Haivision IP Encoder', tx_approved boolean default true, backup_power boolean default false,
  -- Multiviewer
  mv_sources int default 0, mv_software text,
  -- School login
  pw_hash text,
  -- Admin manual "recently updated" flag (independent of auto updated_at)
  manually_marked_at timestamptz,
  -- Audit
  updated_at timestamptz default now(),
  updated_by text
);

-- ── Audit Log ──────────────────────────────────────────────────────────────
create table if not exists school_audit_log (
  id bigserial primary key,
  school_id uuid references schools(id) on delete cascade,
  changed_at timestamptz default now(),
  changed_by text,
  field_name text,
  old_value text,
  new_value text
);

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table schools enable row level security;
alter table school_audit_log enable row level security;

-- Anyone can read schools (compliance/sports views don't require Supabase auth)
create policy "public read schools"
  on schools for select using (true);

-- School contacts can update only their own row
create policy "school updates own row"
  on schools for update
  using (auth.jwt() ->> 'email' = auth_email);

-- Admin can update any row
create policy "admin updates any school"
  on schools for update
  using (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com');

-- Admin can insert new schools
create policy "admin inserts schools"
  on schools for insert
  with check (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com');

-- Admin can delete schools
create policy "admin deletes schools"
  on schools for delete
  using (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com');

-- Authenticated users can read audit log
create policy "authenticated read audit log"
  on school_audit_log for select
  using (auth.role() = 'authenticated');

-- ── Audit Trigger ──────────────────────────────────────────────────────────
create or replace function log_school_changes()
returns trigger language plpgsql as $$
declare
  col text;
  old_val text;
  new_val text;
begin
  foreach col in array array[
    'sw_model','sw_inputs','sw_keyers','sw_mes','cameras','camera_models',
    'cam_football','cam_basketball','cam_volleyball','cam_soccer','cam_baseball','cam_softball',
    'has_40x_lens','lens_detail','has_14x_lens',
    'replay_model','replay_units','replay_inputs','replay_outputs',
    'audio_model','audio_inputs','audio_outputs','audio_faders',
    'intercom_model','intercom_ch',
    'gfx_model','gfx_channels','gfx_approved',
    'tx_digital','tx_approved','backup_power',
    'mv_sources','mv_software','sports'
  ]
  loop
    execute format('select ($1).%I::text', col) using OLD into old_val;
    execute format('select ($1).%I::text', col) using NEW into new_val;
    if old_val is distinct from new_val then
      insert into school_audit_log(school_id, changed_by, field_name, old_value, new_value)
      values (NEW.id, NEW.updated_by, col, old_val, new_val);
    end if;
  end loop;
  NEW.updated_at = now();
  return NEW;
end;
$$;

create or replace trigger school_audit_trigger
  before update on schools
  for each row execute function log_school_changes();


-- ── Viewership Tracker ────────────────────────────────────────────────────
create table if not exists viewership_events (
  id uuid primary key default gen_random_uuid(),
  sport text not null default '',
  airing_title text not null default '',
  event_date text not null default '',
  away_team text,
  home_team text,
  unique_viewers int default 0,
  total_minutes bigint default 0,
  min_per_viewer numeric(8,2) default 0,
  report_period text,
  extra_data jsonb default '{}',
  created_at timestamptz default now(),
  unique (sport, airing_title, event_date)
);

alter table viewership_events enable row level security;
create policy "public read viewership" on viewership_events for select using (true);
create policy "public write viewership" on viewership_events for all using (true) with check (true);


-- ── Commercials Hub ────────────────────────────────────────────────────────
-- Active/inactive spot inventory managed by admin
create table if not exists commercials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text default 'active' check (status in ('active', 'inactive')),
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Which commercial is assigned to which conference break slot
create table if not exists format_assignments (
  sport text not null,
  break_key text not null,
  spot_index int not null,
  commercial_id uuid references commercials(id) on delete set null,
  updated_at timestamptz default now(),
  updated_by text,
  primary key (sport, break_key, spot_index)
);

-- Shared key/value settings (box link, etc.)
create table if not exists app_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now(),
  updated_by text
);

-- RLS for commercials tables
alter table commercials enable row level security;
alter table format_assignments enable row level security;
alter table app_settings enable row level security;

-- Anyone can read
create policy "public read commercials" on commercials for select using (true);
create policy "public read assignments" on format_assignments for select using (true);
create policy "public read settings" on app_settings for select using (true);

-- Only admin can write
create policy "admin write commercials" on commercials for all
  using (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com')
  with check (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com');

create policy "admin write assignments" on format_assignments for all
  using (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com')
  with check (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com');

create policy "admin write settings" on app_settings for all
  using (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com')
  with check (auth.jwt() ->> 'email' = 'keithmkingjr@gmail.com');
