-- ─────────────────────────────────────────────────────────────────────────
-- Patch: replace pgcrypto digest() with built-in sha256() in the Roku
-- relay RPCs. Original migration assumed pgcrypto was on the function's
-- search_path, which isn't true on Supabase projects where extensions
-- live in the `extensions` schema.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function wsc_roku_enqueue(
  p_email      text,
  p_pw_hash    text,
  p_agent_key  text,
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


-- Re-grant just in case the original migration's grants didn't take effect.
revoke all on function wsc_roku_enqueue(text, text, text, text, text, text) from public;
grant execute on function wsc_roku_enqueue(text, text, text, text, text, text) to anon;

revoke all on function wsc_roku_complete(uuid, text, text, jsonb, text) from public;
grant execute on function wsc_roku_complete(uuid, text, text, jsonb, text) to anon;

-- Reload PostgREST schema cache so the new function bodies are picked up.
notify pgrst, 'reload schema';

-- Sanity check
select 'wsc_roku_enqueue'  as fn, pg_get_function_arguments('wsc_roku_enqueue'::regproc::oid)
union all
select 'wsc_roku_complete', pg_get_function_arguments('wsc_roku_complete'::regproc::oid);
