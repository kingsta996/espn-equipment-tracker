-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC Roku snapshot mode
--
-- Sub-second-latency alternative to the HLS preview on the Roku Control
-- tab. Used when the operator needs fast feedback (menu navigation, etc.)
-- and doesn't need full-resolution video (HLS mode is for that).
--
-- Flow:
--   1. Portal in Snapshot mode calls wsc_roku_snapshot_watch() every ~5s
--      with a 10s watch window — like a heartbeat saying "I'm watching
--      CUSA3, please keep snapshots flowing."
--   2. cusa_relay.py polls wsc_roku_snapshots for rows where watch_until
--      > now() AND agent_key_hash matches its own. For each, it fetches
--      http://{helo_ip}/wall/videofeed.jpg from the local HELO encoder
--      and publishes the JPEG bytes via wsc_roku_snapshot_publish().
--   3. Portal polls wsc_roku_snapshots for the latest jpeg_b64 and
--      renders it into an <img>.
--
-- Same trust model as the command relay:
--   • Anon role cannot directly INSERT/UPDATE — flows through SECURITY
--     DEFINER RPCs that validate super-admin email + admin_users pw_hash
--     (watch) or matching agent_key_hash (publish).
--   • A leaked anon key alone can't make the agent fetch anything
--     (publish needs the agent_key, watch needs the password).
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_roku_snapshots (
  encoder_id      text primary key check (encoder_id ~ '^CUSA([1-9]|10)$'),
  agent_key_hash  text not null,
  jpeg_b64        text,           -- base64 of the JPEG bytes from the HELO
  bytes           int,            -- size of original (pre-base64) JPEG
  captured_at     timestamptz,
  agent_id        text,
  watch_until     timestamptz not null default (now() - interval '1 second')
);

alter table wsc_roku_snapshots enable row level security;

drop policy if exists wsc_roku_snapshots_select on wsc_roku_snapshots;

-- Anon needs read access — both portal (display) and agent (queue scan).
-- jpeg_b64 column means a row can be a few hundred KB; we live with that
-- since the agent UPSERTs in place rather than appending history.
create policy wsc_roku_snapshots_select on wsc_roku_snapshots
  for select to anon using (true);


-- ─── Watch heartbeat (portal → DB) ───────────────────────────────────────
-- Portal calls every ~5s while in Snapshot mode. Sets/extends watch_until
-- and pins agent_key_hash so only the matching agent will publish frames.
create or replace function wsc_roku_snapshot_watch(
  p_email      text,
  p_pw_hash    text,
  p_agent_key  text,
  p_encoder_id text,
  p_seconds    int
) returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_super_admins text[] := array['kking@conferenceusa.com'];
  v_pw_match  boolean;
  v_email_lc  text := lower(coalesce(p_email, ''));
  v_until     timestamptz;
  v_seconds   int := least(greatest(coalesce(p_seconds, 10), 1), 60);
begin
  if not (v_email_lc = any(v_super_admins)) then
    raise exception 'not a roku super admin' using errcode = '42501';
  end if;
  select coalesce(is_active, false) and lower(pw_hash) = lower(p_pw_hash)
    into v_pw_match
    from admin_users
   where lower(email) = v_email_lc
   limit 1;
  if v_pw_match is not true then
    raise exception 'invalid credentials' using errcode = '28000';
  end if;
  if p_encoder_id !~ '^CUSA([1-9]|10)$' then
    raise exception 'invalid encoder_id: %', p_encoder_id;
  end if;
  if coalesce(length(p_agent_key), 0) < 16 then
    raise exception 'agent key too short';
  end if;

  v_until := now() + (v_seconds || ' seconds')::interval;

  insert into wsc_roku_snapshots(encoder_id, agent_key_hash, watch_until)
  values (p_encoder_id, encode(sha256(p_agent_key::bytea), 'hex'), v_until)
  on conflict (encoder_id) do update set
    -- Always refresh agent_key_hash on a watch heartbeat so a freshly-paired
    -- portal can take over a stale row from a prior session.
    agent_key_hash = excluded.agent_key_hash,
    watch_until    = excluded.watch_until;

  return v_until;
end;
$$;

revoke all on function wsc_roku_snapshot_watch(text, text, text, text, int) from public;
grant execute on function wsc_roku_snapshot_watch(text, text, text, text, int) to anon;


-- ─── Publish (agent → DB) ────────────────────────────────────────────────
-- Agent calls after fetching a JPEG from the HELO. Verifies the row's
-- agent_key_hash matches the agent's own (so a malicious anon caller
-- can't poison the displayed image).
create or replace function wsc_roku_snapshot_publish(
  p_agent_key  text,
  p_encoder_id text,
  p_jpeg_b64   text,
  p_bytes      int,
  p_agent_id   text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(sha256(p_agent_key::bytea), 'hex');
  v_rows int;
begin
  if p_encoder_id !~ '^CUSA([1-9]|10)$' then
    raise exception 'invalid encoder_id: %', p_encoder_id;
  end if;
  if coalesce(length(p_agent_key), 0) < 16 then
    raise exception 'agent key too short';
  end if;
  if coalesce(length(p_jpeg_b64), 0) < 100 then
    raise exception 'jpeg payload too small';
  end if;
  -- Soft cap on payload size — discourage accidentally pushing 5MB frames
  -- through the row-level limit. The HELO snapshot is typically <300KB
  -- which base64-inflates to ~400KB. 1MB is a safety margin.
  if length(p_jpeg_b64) > 1500000 then
    raise exception 'jpeg payload too large (% bytes)', length(p_jpeg_b64);
  end if;

  update wsc_roku_snapshots
     set jpeg_b64    = p_jpeg_b64,
         bytes       = p_bytes,
         captured_at = now(),
         agent_id    = p_agent_id
   where encoder_id     = p_encoder_id
     and agent_key_hash = v_hash;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function wsc_roku_snapshot_publish(text, text, text, int, text) from public;
grant execute on function wsc_roku_snapshot_publish(text, text, text, int, text) to anon;


-- Realtime: enable change events on this table so the WSC portal can
-- subscribe to UPDATE events instead of polling. Idempotent — adding a
-- table that's already in the publication raises duplicate_object,
-- which we swallow.
do $$
begin
  alter publication supabase_realtime add table wsc_roku_snapshots;
exception
  when duplicate_object then null;
  when others           then null;  -- publication may not exist on self-hosted Postgres; non-fatal
end$$;


notify pgrst, 'reload schema';

-- Sanity check
select 'wsc_roku_snapshots'         as object, count(*)::text as rows from wsc_roku_snapshots
union all
select 'wsc_roku_snapshot_watch',   pg_get_function_arguments('wsc_roku_snapshot_watch'::regproc::oid)
union all
select 'wsc_roku_snapshot_publish', pg_get_function_arguments('wsc_roku_snapshot_publish'::regproc::oid);
