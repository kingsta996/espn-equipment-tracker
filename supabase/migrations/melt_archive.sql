-- ─────────────────────────────────────────────────────────────────────────
-- Migration: Melt Archive — request + access-code workflow
--
--   melt_archive_requests  — producer submissions (mirrors SharePoint
--                            CUSA_Melt_Archive_Requests schema)
--   melt_archive_codes     — access codes minted on Approve (mirrors
--                            SharePoint CUSA_Melt_Archive_Codes schema)
--   unlock_archive_code()  — public RPC to validate a code and return its
--                            stored Box shared_link_url. Codes table itself
--                            is NOT publicly readable — security depends on
--                            this being the only way to read shared links.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists melt_archive_requests (
  id uuid primary key default gen_random_uuid(),
  submitted_at timestamptz default now(),
  full_name text not null,
  email text not null,
  company text,
  phone text,
  project_name text,
  intended_use text,                          -- Broadcast / Social cut / Archival / Other
  deadline date,
  notes text,
  selected_year text not null,
  selected_sport text not null,
  selected_school text not null,
  selected_game text not null,
  box_folder_id text not null,
  status text not null default 'Pending',     -- Pending / Approved / Declined
  approved_by text,
  approved_at timestamptz,
  declined_reason text,
  declined_at timestamptz
);

alter table melt_archive_requests enable row level security;
drop policy if exists "public insert archive requests" on melt_archive_requests;
drop policy if exists "public read archive requests"   on melt_archive_requests;
drop policy if exists "public update archive requests" on melt_archive_requests;
-- Producers can submit (insert).
create policy "public insert archive requests" on melt_archive_requests for insert with check (true);
-- Admin portal reads pending/approved/declined queues.
create policy "public read archive requests"   on melt_archive_requests for select using (true);
-- Admin portal updates status. (Phase 2 admin UI gates this; if you want to
-- harden further later, push status updates through a Netlify Function with
-- the service-role key and tighten this policy.)
create policy "public update archive requests" on melt_archive_requests for update using (true) with check (true);


create table if not exists melt_archive_codes (
  code text primary key,
  box_folder_id text not null,
  folder_display_name text,
  shared_link_url text,                       -- private — only readable via the unlock_archive_code() RPC
  expires_at timestamptz not null,
  created_from_request uuid references melt_archive_requests(id) on delete set null,
  requester_email text,
  status text not null default 'Active',      -- Active / Expired / Revoked
  created_at timestamptz default now(),
  unlock_count int default 0
);

-- Hard-lock the codes table: NO public read, NO public write. Phase 2's
-- admin Netlify Function uses the Supabase service-role key to manage rows.
-- The only public access is via the unlock_archive_code RPC below.
alter table melt_archive_codes enable row level security;
drop policy if exists "public read archive codes"   on melt_archive_codes;
drop policy if exists "public write archive codes"  on melt_archive_codes;
drop policy if exists "public update archive codes" on melt_archive_codes;
-- (intentionally no policies — anon role gets denied by default)


-- Public RPC: validate a code and return its stored shared link URL.
-- Atomically increments unlock_count. SECURITY DEFINER lets it bypass RLS
-- on the codes table. Returns no rows when the code is invalid/expired/revoked.
create or replace function unlock_archive_code(p_code text)
returns table (shared_link_url text, folder_display_name text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update melt_archive_codes
  set unlock_count = unlock_count + 1
  where code = p_code
    and status = 'Active'
    and expires_at > now()
  returning melt_archive_codes.shared_link_url,
            melt_archive_codes.folder_display_name,
            melt_archive_codes.expires_at;
end;
$$;

revoke all on function unlock_archive_code(text) from public;
grant execute on function unlock_archive_code(text) to anon, authenticated;


-- Realtime so the admin portal sees new requests live (Phase 2).
do $$ begin alter publication supabase_realtime add table melt_archive_requests; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table melt_archive_codes;    exception when duplicate_object then null; end $$;
