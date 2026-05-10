-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC Roku Control — outbound-only relay table + RPCs
--
-- Lets a super admin in the WSC portal queue a Roku ECP command which a
-- relay agent (cusa_relay.py) running on the MC workstation picks up
-- via polling and executes against the local Roku.
--
-- Trust boundaries:
--   • Anon role CANNOT directly INSERT or UPDATE roku_commands. RLS
--     blocks both. Commands flow through wsc_roku_enqueue() (anon-callable,
--     SECURITY DEFINER) which validates super admin + agent pairing key.
--   • Agent reads queued rows via SELECT (allowed for anon) and updates
--     them via wsc_roku_complete() (anon-callable, SECURITY DEFINER) that
--     verifies agent_key_hash before mutating.
--   • Even with the anon key leaked, an attacker cannot:
--       — issue commands (super admin email + admin_users pw_hash required)
--       — execute commands they queue (agent_key_hash must match the agent)
--       — modify other rows (RLS forbids direct UPDATE for anon)
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- Hashing uses Postgres's built-in sha256() (no pgcrypto dependency).

-- ─── Table ───────────────────────────────────────────────────────────────
create table if not exists roku_commands (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  created_by_email text not null,
  agent_key_hash  text not null,                       -- sha256(pairing key)
  encoder_id      text not null check (encoder_id ~ '^CUSA([1-9]|10)$'),
  kind            text not null check (kind in ('keypress', 'launch')),
  payload         text not null,                        -- key name or numeric channel id
  status          text not null default 'queued'
                    check (status in ('queued', 'running', 'ok', 'error', 'expired')),
  result          jsonb,
  agent_id        text,
  executed_at     timestamptz,
  expires_at      timestamptz not null default (now() + interval '60 seconds')
);

create index if not exists roku_commands_queue_idx
  on roku_commands(agent_key_hash, status, created_at)
  where status = 'queued';

create index if not exists roku_commands_recent_idx
  on roku_commands(created_at desc);

-- ─── RLS ─────────────────────────────────────────────────────────────────
alter table roku_commands enable row level security;

-- Drop pre-existing policies before recreating (idempotent re-run).
drop policy if exists roku_commands_select        on roku_commands;
drop policy if exists roku_commands_no_anon_write on roku_commands;
drop policy if exists roku_commands_no_anon_upd   on roku_commands;

-- Anon can read recent commands so:
--   • the portal can poll a row's status by id
--   • the agent can scan the queue
create policy roku_commands_select on roku_commands
  for select to anon
  using (created_at > now() - interval '5 minutes');

-- Explicitly forbid anon INSERT/UPDATE — flow through SECURITY DEFINER RPCs.
-- (RLS denies by default, but an explicit policy makes intent clear.)


-- ─── Enqueue RPC ─────────────────────────────────────────────────────────
-- Called by the WSC portal. Validates super-admin credentials, then inserts
-- a queued command. Returns the inserted row's id.
--
-- Hardcoded super_admin allowlist mirrors SUPER_ADMINS in wsc-portal.html.
-- If you change one, change the other.
create or replace function wsc_roku_enqueue(
  p_email      text,
  p_pw_hash    text,
  p_agent_key  text,        -- plaintext; hashed inside the function, never stored
  p_encoder_id text,
  p_kind       text,
  p_payload    text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_super_admins text[] := array['kking@conferenceusa.com'];
  v_allowed_keys text[] := array[
    'Home','Rev','Fwd','Play','Select','Left','Right','Down','Up',
    'Back','Replay','Info','Search','Enter',
    'VolumeUp','VolumeDown','VolumeMute',
    'PowerOff','PowerOn',
    'ChannelUp','ChannelDown',
    'InputTuner','InputHDMI1','InputHDMI2','InputHDMI3','InputHDMI4','InputAV1'
  ];
  v_pw_match  boolean;
  v_email_lc  text := lower(coalesce(p_email, ''));
  v_id        uuid;
begin
  -- 1) Super admin allowlist
  if not (v_email_lc = any(v_super_admins)) then
    raise exception 'not a roku super admin' using errcode = '42501';
  end if;

  -- 2) admin_users credentials match (active + pw_hash)
  select coalesce(is_active, false) and lower(pw_hash) = lower(p_pw_hash)
    into v_pw_match
    from admin_users
   where lower(email) = v_email_lc
   limit 1;

  if v_pw_match is not true then
    raise exception 'invalid credentials' using errcode = '28000';
  end if;

  -- 3) Command shape
  if p_kind not in ('keypress', 'launch') then
    raise exception 'invalid kind: %', p_kind;
  end if;
  if p_encoder_id !~ '^CUSA([1-9]|10)$' then
    raise exception 'invalid encoder_id: %', p_encoder_id;
  end if;
  if p_kind = 'keypress' and not (p_payload = any(v_allowed_keys)) then
    raise exception 'key not in whitelist: %', p_payload;
  end if;
  if p_kind = 'launch' and p_payload !~ '^[0-9]+$' then
    raise exception 'launch payload must be numeric channel id';
  end if;

  -- 4) Pairing key is required
  if coalesce(length(p_agent_key), 0) < 16 then
    raise exception 'agent key too short';
  end if;

  insert into roku_commands(created_by_email, agent_key_hash, encoder_id, kind, payload)
  values (
    v_email_lc,
    encode(sha256(p_agent_key::bytea), 'hex'),
    p_encoder_id,
    p_kind,
    p_payload
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function wsc_roku_enqueue(text, text, text, text, text, text) from public;
grant execute on function wsc_roku_enqueue(text, text, text, text, text, text) to anon;


-- ─── Complete RPC ────────────────────────────────────────────────────────
-- Called by cusa_relay.py after executing a command. Verifies the caller
-- holds the matching agent key (via hash), then transitions the row.
create or replace function wsc_roku_complete(
  p_id          uuid,
  p_agent_key   text,
  p_status      text,
  p_result      jsonb,
  p_agent_id    text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(sha256(p_agent_key::bytea), 'hex');
  v_rows int;
begin
  if p_status not in ('running', 'ok', 'error') then
    raise exception 'invalid status: %', p_status;
  end if;

  update roku_commands
     set status      = p_status,
         result      = coalesce(p_result, result),
         agent_id    = coalesce(p_agent_id, agent_id),
         executed_at = case when p_status in ('ok','error') then now() else executed_at end
   where id = p_id
     and agent_key_hash = v_hash;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function wsc_roku_complete(uuid, text, text, jsonb, text) from public;
grant execute on function wsc_roku_complete(uuid, text, text, jsonb, text) to anon;


-- ─── Cleanup helper ──────────────────────────────────────────────────────
-- Mark stale queued commands as expired so they can't be replayed.
-- The agent calls this opportunistically; a Supabase scheduled job
-- could also be wired up later if desired.
create or replace function wsc_roku_expire_stale() returns int
language sql
security definer
set search_path = public, pg_temp
as $$
  with upd as (
    update roku_commands
       set status = 'expired'
     where status = 'queued' and expires_at < now()
     returning 1
  )
  select count(*)::int from upd;
$$;

revoke all on function wsc_roku_expire_stale() from public;
grant execute on function wsc_roku_expire_stale() to anon;


-- Sanity check
select 'roku_commands' as object, count(*)::text as rows from roku_commands
union all
select 'wsc_roku_enqueue', pg_get_function_identity_arguments('wsc_roku_enqueue'::regproc::oid)
union all
select 'wsc_roku_complete', pg_get_function_identity_arguments('wsc_roku_complete'::regproc::oid);
