-- ──────────────────────────────────────────────────────────────────
-- Migration: Highlight Request Workflow (multi-worker ready)
--   highlight_requests          — staff submissions, admin approval
--   highlight_processing_log    — worker activity log
--   highlight_worker_registry   — active worker tracking
--   claim_next_highlight_job()  — atomic job claim (FOR UPDATE SKIP LOCKED)
--   sweep_stale_highlight_jobs() — reset jobs whose worker died
-- Mirrors melt_archive_requests pattern. Safe to re-run.
-- ──────────────────────────────────────────────────────────────────

create table if not exists highlight_requests (
  id uuid primary key default gen_random_uuid(),
  submitted_at timestamptz default now(),
  -- requester (Phase 3 school auth will validate against schools.auth_email)
  requester_email text not null,
  requester_name text,
  requester_school text,
  -- what they want
  box_file_id text not null,
  box_file_name text,
  jersey_number text not null,
  jersey_color text not null,
  team text,
  game_context text,
  notes text,
  -- workflow status
  status text not null default 'Pending',
    -- Pending / Approved / Processing / Complete / Failed / Declined
  approved_by text,
  approved_at timestamptz,
  declined_reason text,
  declined_at timestamptz,
  -- worker tracking
  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  worker_host text,
  last_heartbeat_at timestamptz,
  -- output
  output_box_folder_id text,
  output_clip_count int,
  output_metadata jsonb default '{}',
  error_message text
);

alter table highlight_requests enable row level security;
drop policy if exists "public insert highlight requests" on highlight_requests;
drop policy if exists "public read highlight requests"   on highlight_requests;
drop policy if exists "public update highlight requests" on highlight_requests;
create policy "public insert highlight requests" on highlight_requests for insert with check (true);
create policy "public read highlight requests"   on highlight_requests for select using (true);
create policy "public update highlight requests" on highlight_requests for update using (true) with check (true);

create table if not exists highlight_processing_log (
  id bigserial primary key,
  request_id uuid references highlight_requests(id) on delete cascade,
  worker_host text,
  level text check (level in ('info','warn','error')),
  message text not null,
  details jsonb,
  logged_at timestamptz default now()
);

alter table highlight_processing_log enable row level security;
drop policy if exists "public read highlight log"   on highlight_processing_log;
drop policy if exists "public insert highlight log" on highlight_processing_log;
create policy "public read highlight log"   on highlight_processing_log for select using (true);
create policy "public insert highlight log" on highlight_processing_log for insert with check (true);

create table if not exists highlight_worker_registry (
  worker_host text primary key,
  started_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  status text not null default 'active',
    -- active / shutdown / stale
  max_concurrent_jobs int default 1,
  current_job_count int default 0,
  details jsonb default '{}'
);

alter table highlight_worker_registry enable row level security;
drop policy if exists "public read worker registry"  on highlight_worker_registry;
drop policy if exists "public write worker registry" on highlight_worker_registry;
create policy "public read worker registry"  on highlight_worker_registry for select using (true);
create policy "public write worker registry" on highlight_worker_registry for all using (true) with check (true);

create index if not exists highlight_requests_status_idx on highlight_requests (status);
create index if not exists highlight_requests_submitted_idx on highlight_requests (submitted_at desc);
create index if not exists highlight_requests_heartbeat_idx on highlight_requests (last_heartbeat_at) where status = 'Processing';
create index if not exists highlight_processing_log_request_idx on highlight_processing_log (request_id, logged_at desc);

-- ── Atomic job claim ─────────────────────────────────────────────
-- Returns the claimed row, or NULL if no work is available.
-- FOR UPDATE SKIP LOCKED prevents concurrent workers from grabbing the same job.
create or replace function claim_next_highlight_job(p_worker_host text)
returns highlight_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed highlight_requests;
begin
  update highlight_requests
  set status = 'Processing',
      processing_started_at = now(),
      last_heartbeat_at = now(),
      worker_host = p_worker_host
  where id = (
    select id from highlight_requests
    where status = 'Approved'
    order by submitted_at asc
    limit 1
    for update skip locked
  )
  returning * into claimed;
  return claimed;
end;
$$;
revoke all on function claim_next_highlight_job(text) from public;
grant execute on function claim_next_highlight_job(text) to anon, authenticated, service_role;

-- ── Stale job sweeper ────────────────────────────────────────────
create or replace function sweep_stale_highlight_jobs(p_stale_minutes int default 5)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  reset_count int;
begin
  with reset as (
    update highlight_requests
    set status = 'Approved',
        worker_host = null,
        processing_started_at = null,
        last_heartbeat_at = null,
        error_message = coalesce(error_message,'') ||
          ' [auto-reset by sweep at ' || now()::text || ' — worker did not heartbeat in ' || p_stale_minutes || ' min]'
    where status = 'Processing'
      and last_heartbeat_at is not null
      and last_heartbeat_at < now() - (p_stale_minutes || ' minutes')::interval
    returning id
  )
  select count(*) into reset_count from reset;
  return reset_count;
end;
$$;
revoke all on function sweep_stale_highlight_jobs(int) from public;
grant execute on function sweep_stale_highlight_jobs(int) to anon, authenticated, service_role;

-- ── Realtime ─────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table highlight_requests; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table highlight_processing_log; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table highlight_worker_registry; exception when duplicate_object then null; end $$;

select 'highlight tables ready' as status;
