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

-- The app uses a password gate (not Supabase Auth) so we cannot rely on
-- auth.jwt() in policies. Treat the schools table the same as the other
-- write-from-anon tables: public read + public write. Access control lives
-- in the app's password gate.
drop policy if exists "public read schools"  on schools;
drop policy if exists "public write schools" on schools;
create policy "public read schools"  on schools for select using (true);
create policy "public write schools" on schools for all    using (true) with check (true);

-- Audit log: public read + public insert so the trigger can write rows
-- regardless of how the user authenticated (password gate or anon).
drop policy if exists "public read audit log"   on school_audit_log;
drop policy if exists "public insert audit log" on school_audit_log;
create policy "public read audit log"
  on school_audit_log for select using (true);
create policy "public insert audit log"
  on school_audit_log for insert with check (true);

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


-- ── ESPN Broadcast Schedule Submissions ───────────────────────────────────
-- Public form-driven schedule submissions, one row per event.
-- Used by /schedule.html (public school submission) and /schedule-admin.html.
create table if not exists schedule_events (
  id uuid primary key default gen_random_uuid(),
  school text not null,
  athletic_year text default '2025-26',
  season text default '',
  archived boolean default false,
  archived_at timestamptz,
  -- 19 columns from ESPN Broadcast Schedule template:
  sport text,
  event_date text,
  event_time text,
  duration text,
  network text,
  away text,
  home text,
  conference text,
  round_text text,
  production text,
  ad_serve text,
  site text,
  manned_cameras int,
  lock_off_cameras int,
  graphics text,
  replay text,
  talent text,
  transmission text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text
);

alter table schedule_events enable row level security;
drop policy if exists "public read schedule events"  on schedule_events;
drop policy if exists "public write schedule events" on schedule_events;
create policy "public read schedule events"  on schedule_events for select using (true);
create policy "public write schedule events" on schedule_events for all    using (true) with check (true);

-- ── Admin users + activity log ────────────────────────────────────────────
-- Per-user admin accounts (email + SHA-256 of password). Used by admin.html,
-- compliance.html, schedule-admin.html for sign-in. Replaces the single
-- shared admin password.
create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  pw_hash text not null,
  display_name text,
  is_active boolean default true,
  created_at timestamptz default now()
);
alter table admin_users enable row level security;
drop policy if exists "public read admin users"  on admin_users;
drop policy if exists "public write admin users" on admin_users;
create policy "public read admin users"  on admin_users for select using (true);
create policy "public write admin users" on admin_users for all    using (true) with check (true);

-- Append-only activity log: who logged in, who modified what, when.
create table if not exists admin_activity_log (
  id bigserial primary key,
  email text not null,
  display_name text,
  app text,             -- 'viewership' | 'compliance' | 'schedule' | 'auth'
  action text not null, -- 'login' | 'sign-out' | 'add' | 'edit' | 'delete' | 'import' | 'archive' | etc.
  target text,          -- 'school:Liberty' | 'event:abc-123' | 'period:Aug-Oct 2025' | etc.
  details text,
  occurred_at timestamptz default now()
);
alter table admin_activity_log enable row level security;
drop policy if exists "public read activity log"   on admin_activity_log;
drop policy if exists "public insert activity log" on admin_activity_log;
create policy "public read activity log"   on admin_activity_log for select using (true);
create policy "public insert activity log" on admin_activity_log for insert with check (true);

-- Seed two admin accounts. Keith keeps his existing hash so his current
-- password still works; Carney's row has SHA-256('C0nferenceUSA!').
insert into admin_users (email, pw_hash, display_name) values
  ('keithmkingjr@gmail.com',     '9a874f8b06ebb0eb63336db78b70ca149513a237de8395d8e858ee8f0c702ae2', 'Keith King'),
  ('kcarney@conferenceusa.com',  '8b0bc1004fe02329dc00733a3be4ee41e8539e929ec9f7d1e858906a676f4f47', 'K Carney')
on conflict (email) do update set
  pw_hash = excluded.pw_hash,
  display_name = excluded.display_name,
  is_active = true;


-- (Realtime publication adds for the above tables happen at the bottom of
-- this file, after schedule_settings / produced_events / viewership_events
-- and the commercials tables have all been created.)


-- Single-row settings table for the schedule (active year + Fall/Winter/Spring window state)
create table if not exists schedule_settings (
  id text primary key default 'singleton',
  active_year text default '2025-26',
  fall_window text default 'open',     -- 'open' | 'closed'
  winter_window text default 'open',
  spring_window text default 'open',
  fall_closed_at timestamptz,
  winter_closed_at timestamptz,
  spring_closed_at timestamptz,
  updated_at timestamptz default now()
);
alter table schedule_settings enable row level security;
drop policy if exists "public read schedule settings"  on schedule_settings;
drop policy if exists "public write schedule settings" on schedule_settings;
create policy "public read schedule settings"  on schedule_settings for select using (true);
create policy "public write schedule settings" on schedule_settings for all    using (true) with check (true);
insert into schedule_settings (id) values ('singleton') on conflict do nothing;


-- ── CUSA Production Tracker (drives 'CUSA Produced Only' filter) ──────────
create table if not exists produced_events (
  id uuid primary key default gen_random_uuid(),
  sport text not null default '',
  school text not null default '',
  event_date text not null default '',
  home_team text,
  away_team text,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  unique (sport, school, event_date, home_team, away_team)
);

alter table produced_events enable row level security;
drop policy if exists "public read produced events"  on produced_events;
drop policy if exists "public write produced events" on produced_events;
create policy "public read produced events"  on produced_events for select using (true);
create policy "public write produced events" on produced_events for all using (true) with check (true);


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
drop policy if exists "public read viewership"  on viewership_events;
drop policy if exists "public write viewership" on viewership_events;
create policy "public read viewership"  on viewership_events for select using (true);
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

-- Dashboard categorization + Box link + sport targeting (added 2026-05)
alter table commercials add column if not exists category text
  check (category in ('school_psa', 'cusa_psa', 'sponsor'));
alter table commercials add column if not exists box_link text;
alter table commercials add column if not exists box_file_id text;
alter table commercials add column if not exists sports text[] default '{}';
alter table commercials add column if not exists notes text;
alter table commercials add column if not exists school_id uuid references schools(id) on delete set null;
alter table commercials add column if not exists year int;
alter table commercials add column if not exists advertiser text;
create index if not exists commercials_school_id_idx on commercials(school_id);

-- Per-slot advertiser text for CBSSN Championships (one row per :30 slot)
create table if not exists champ_break_advertisers (
  sport text not null,
  break_key text not null,
  spot_index int not null default 0,
  advertiser text,
  updated_at timestamptz default now(),
  updated_by text,
  primary key (sport, break_key, spot_index)
);
-- Promote older per-break rows that pre-date the spot_index column.
alter table champ_break_advertisers add column if not exists spot_index int not null default 0;
alter table champ_break_advertisers drop constraint if exists champ_break_advertisers_pkey;
alter table champ_break_advertisers add primary key (sport, break_key, spot_index);
alter table champ_break_advertisers enable row level security;
drop policy if exists "public read champ break advertisers"  on champ_break_advertisers;
drop policy if exists "public write champ break advertisers" on champ_break_advertisers;
create policy "public read champ break advertisers"  on champ_break_advertisers for select using (true);
create policy "public write champ break advertisers" on champ_break_advertisers for all    using (true) with check (true);

-- Touch updated_at on every row update so the change banner can fire
create or replace function touch_commercials_updated_at()
returns trigger language plpgsql as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;
drop trigger if exists commercials_touch_updated_at on commercials;
create trigger commercials_touch_updated_at
  before update on commercials
  for each row execute function touch_commercials_updated_at();

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

-- Per-school commercial activity (logins, dashboard views, box-link clicks, change confirmations)
create table if not exists commercial_activity_log (
  id bigserial primary key,
  school_id uuid references schools(id) on delete set null,
  school_name text,
  action text not null,           -- 'login' | 'view_dashboard' | 'box_click' | 'confirm_changes' | 'admin_login'
  commercial_id uuid references commercials(id) on delete set null,
  commercial_name text,
  details text,
  occurred_at timestamptz default now()
);
create index if not exists commercial_activity_log_school_idx on commercial_activity_log (school_id, occurred_at desc);
create index if not exists commercial_activity_log_action_idx on commercial_activity_log (action, occurred_at desc);

-- Tracks the last time each school confirmed they've reviewed commercial changes
create table if not exists commercial_acks (
  school_id uuid primary key references schools(id) on delete cascade,
  school_name text,
  last_seen_change_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS for commercials tables
alter table commercials enable row level security;
alter table format_assignments enable row level security;
alter table app_settings enable row level security;
alter table commercial_activity_log enable row level security;
alter table commercial_acks enable row level security;

-- Drop the broken auth.jwt-based policies if they exist (kept anon writes from working)
drop policy if exists "admin write commercials" on commercials;
drop policy if exists "admin write assignments" on format_assignments;
drop policy if exists "admin write settings"    on app_settings;

-- Public read (matches the rest of the app — password gate handles access)
drop policy if exists "public read commercials" on commercials;
drop policy if exists "public read assignments" on format_assignments;
drop policy if exists "public read settings"    on app_settings;
drop policy if exists "public read activity"    on commercial_activity_log;
drop policy if exists "public read acks"        on commercial_acks;
create policy "public read commercials" on commercials          for select using (true);
create policy "public read assignments" on format_assignments    for select using (true);
create policy "public read settings"    on app_settings          for select using (true);
create policy "public read activity"    on commercial_activity_log for select using (true);
create policy "public read acks"        on commercial_acks       for select using (true);

-- Public write (password gate enforced in app)
drop policy if exists "public write commercials" on commercials;
drop policy if exists "public write assignments" on format_assignments;
drop policy if exists "public write settings"    on app_settings;
drop policy if exists "public write activity"    on commercial_activity_log;
drop policy if exists "public write acks"        on commercial_acks;
create policy "public write commercials" on commercials          for all    using (true) with check (true);
create policy "public write assignments" on format_assignments    for all    using (true) with check (true);
create policy "public write settings"    on app_settings          for all    using (true) with check (true);
create policy "public write activity"    on commercial_activity_log for insert with check (true);
create policy "public write acks"        on commercial_acks       for all    using (true) with check (true);

-- Realtime broadcasts so admin changes appear instantly in school sessions.
-- Covers every table that should live-sync across browsers. Safe to re-run:
-- `duplicate_object` (already in publication) and `undefined_table` (table
-- not present on this DB) are both swallowed.
do $$ begin alter publication supabase_realtime add table viewership_events;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table produced_events;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table schedule_events;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table schedule_settings;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table schools;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table school_audit_log;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table admin_activity_log;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table commercials;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table format_assignments;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table app_settings;
  exception when duplicate_object then null; when undefined_table then null; end $$;
do $$ begin alter publication supabase_realtime add table commercial_activity_log;
  exception when duplicate_object then null; when undefined_table then null; end $$;
