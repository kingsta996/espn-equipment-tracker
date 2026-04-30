-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2 migration for the Melt Archive admin portal.
--
--   Adds a public-safe view of melt_archive_codes that omits shared_link_url.
--   The codes table itself stays locked (RLS denies anon). The Netlify
--   box-archive Function uses the service-role key for inserts/updates.
--   The admin page reads from this view via the anon key for listings.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create or replace view melt_archive_codes_public as
select
  code,
  box_folder_id,
  folder_display_name,
  expires_at,
  created_from_request,
  requester_email,
  status,
  created_at,
  unlock_count
from melt_archive_codes;

grant select on melt_archive_codes_public to anon, authenticated;
