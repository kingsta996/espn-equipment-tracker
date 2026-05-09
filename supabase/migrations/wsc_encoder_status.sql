-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC encoder activation status
--   wsc_encoder_status — kking@conferenceusa.com (super admin) can flip
--   encoders inactive when they're physically unavailable, so they grey out
--   in the Manual Capture dropdown. Reactivate when they come back online.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_encoder_status (
  encoder_id      text primary key,           -- e.g. 'CUSA1' (matches wsc_data.json)
  active          boolean     not null default true,
  inactive_reason text,
  updated_by      text,
  updated_at      timestamptz not null default now()
);

alter table wsc_encoder_status enable row level security;

drop policy if exists "public read wsc encoder status"  on wsc_encoder_status;
drop policy if exists "public write wsc encoder status" on wsc_encoder_status;
create policy "public read wsc encoder status"  on wsc_encoder_status for select using (true);
create policy "public write wsc encoder status" on wsc_encoder_status for all    using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table wsc_encoder_status;
exception when duplicate_object then null; end $$;

-- Sanity check
select count(*) as encoder_status_rows from wsc_encoder_status;
