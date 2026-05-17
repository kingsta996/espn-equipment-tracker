-- ─────────────────────────────────────────────────────────────────────────
-- Migration: PSA upload tables
--   psa_config  — per-category File Request URL (admin-editable)
--   psa_uploads — tracks each PSA upload event (school PSAs + CUSA produced)
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists psa_config (
  category text primary key,
  file_request_url text default '',
  folder_id text,
  notes text,
  updated_at timestamptz default now(),
  updated_by text
);

-- Idempotent: adds folder_id (the Box folder the File Request points at) for
-- installs that already ran the original migration. Used by the
-- box-folder-audit function to detect uploads that bypassed the File Request.
alter table psa_config add column if not exists folder_id text;

alter table psa_config enable row level security;
drop policy if exists "public read psa config"  on psa_config;
drop policy if exists "public write psa config" on psa_config;
create policy "public read psa config"  on psa_config for select using (true);
create policy "public write psa config" on psa_config for all    using (true) with check (true);

insert into psa_config (category) values
  ('school_psa'),
  ('cusa_psa')
on conflict (category) do nothing;

create table if not exists psa_uploads (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('school_psa','cusa_psa')),
  school_id uuid references schools(id) on delete set null,
  school_name text,
  year int,
  filename text not null,
  sponsor_name text,
  uploader_name text,
  uploader_email text,
  sport text,
  rotation_period text,
  uploaded_at timestamptz default now(),
  uploaded_by_admin boolean default false,
  notes text
);

create index if not exists psa_uploads_category_idx on psa_uploads (category);
create index if not exists psa_uploads_school_idx   on psa_uploads (school_id);
create index if not exists psa_uploads_uploaded_at_idx on psa_uploads (uploaded_at desc);

alter table psa_uploads enable row level security;
drop policy if exists "public read psa uploads"  on psa_uploads;
drop policy if exists "public write psa uploads" on psa_uploads;
create policy "public read psa uploads"  on psa_uploads for select using (true);
create policy "public write psa uploads" on psa_uploads for all    using (true) with check (true);

do $$ begin alter publication supabase_realtime add table psa_config;  exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table psa_uploads; exception when duplicate_object then null; end $$;

-- Force PostgREST to re-read the schema so the newly-added folder_id column
-- is visible to the JS client without a manual API restart.
notify pgrst, 'reload schema';

-- Sanity check
select category, file_request_url, folder_id from psa_config order by category;
