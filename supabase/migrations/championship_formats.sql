-- ─────────────────────────────────────────────────────────────────────────
-- championship_formats.sql
--
-- Self-service commercial format uploads for the Championships admin
-- portal. Replaces the repo-committed XLSX files in /Formats/ with a
-- Supabase Storage bucket + per-sport pointer table so non-engineers can
-- update formats without a git commit.
--
-- One row per CUSA championship sport key (15 keys, all of SPORTS in
-- championships.html). Latest upload overwrites the previous (admin
-- explicitly chose "overwrite, no version history" on 2026-05-17).
--
-- Storage layout: bucket 'championship-formats', object path
-- '<sport_key>/format.xlsx'. The pointer table keeps the original
-- filename for the download UI label, plus uploaded_at/by for audit.
--
-- Auth model: admin gate is client-side (championships-admin.html
-- password). Anon-key writes are allowed at the RLS layer; the gate
-- lives in the UI. Matches the precedent set by the POTW backgrounds
-- bucket on potw.html.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── 1. Pointer table ────────────────────────────────────────────────────
create table if not exists championship_formats (
  sport_key      text primary key,
  filename       text not null check (length(filename) between 1 and 200),
  storage_path   text not null,
  content_type   text,
  size_bytes     bigint,
  uploaded_at    timestamptz not null default now(),
  uploaded_by    text
);

alter table championship_formats enable row level security;

drop policy if exists championship_formats_select on championship_formats;
create policy championship_formats_select on championship_formats
  for select to anon using (true);

drop policy if exists championship_formats_insert on championship_formats;
create policy championship_formats_insert on championship_formats
  for insert to anon with check (true);

drop policy if exists championship_formats_update on championship_formats;
create policy championship_formats_update on championship_formats
  for update to anon using (true) with check (true);

drop policy if exists championship_formats_delete on championship_formats;
create policy championship_formats_delete on championship_formats
  for delete to anon using (true);


-- ─── 2. Storage bucket ───────────────────────────────────────────────────
-- Public read so championships.html can fetch the file URL directly.
insert into storage.buckets (id, name, public)
values ('championship-formats', 'championship-formats', true)
on conflict (id) do update set public = excluded.public;


-- ─── 3. Storage policies (object-level) ──────────────────────────────────
-- Public anon SELECT/INSERT/UPDATE/DELETE scoped to this bucket only.
-- The 'public' flag on the bucket gives unauthenticated SELECT via the
-- public URL path; the policy below is the belt-and-suspenders match
-- for direct storage.objects access via the API.

drop policy if exists "championship_formats_objects_select" on storage.objects;
create policy "championship_formats_objects_select" on storage.objects
  for select to anon
  using (bucket_id = 'championship-formats');

drop policy if exists "championship_formats_objects_insert" on storage.objects;
create policy "championship_formats_objects_insert" on storage.objects
  for insert to anon
  with check (bucket_id = 'championship-formats');

drop policy if exists "championship_formats_objects_update" on storage.objects;
create policy "championship_formats_objects_update" on storage.objects
  for update to anon
  using (bucket_id = 'championship-formats')
  with check (bucket_id = 'championship-formats');

drop policy if exists "championship_formats_objects_delete" on storage.objects;
create policy "championship_formats_objects_delete" on storage.objects
  for delete to anon
  using (bucket_id = 'championship-formats');
