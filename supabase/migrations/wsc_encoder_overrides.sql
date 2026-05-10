-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC encoder IP overrides
--
-- Lets a super admin update CUSA1..CUSA10 Roku/HELO IPs from the portal
-- Settings tab without redeploying cusa_backend.py / cusa_relay.py. The
-- relay agent reads this table on every command (cached ~10s) and uses
-- the overridden IPs when present.
--
-- Default values continue to live in cusa_backend.py's ENCODERS list and
-- in wsc_data.json. This table only stores diffs — null fields fall
-- through to the defaults.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_encoder_overrides (
  encoder_id  text primary key check (encoder_id ~ '^CUSA([1-9]|10)$'),
  roku_ip     text check (roku_ip is null or roku_ip ~ '^\d{1,3}(\.\d{1,3}){3}$'),
  helo_ip     text check (helo_ip is null or helo_ip ~ '^\d{1,3}(\.\d{1,3}){3}$'),
  label       text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table wsc_encoder_overrides enable row level security;

drop policy if exists wsc_encoder_overrides_select on wsc_encoder_overrides;

-- Anon needs read access — both the portal (display) and the relay (lookup)
-- read this table. Writes go through the SECURITY DEFINER RPCs below.
create policy wsc_encoder_overrides_select on wsc_encoder_overrides
  for select to anon using (true);


-- ─── Update / upsert RPC ─────────────────────────────────────────────────
create or replace function wsc_encoder_update(
  p_email      text,
  p_pw_hash    text,
  p_encoder_id text,
  p_roku_ip    text,
  p_helo_ip    text,
  p_label      text,
  p_notes      text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_super_admins text[] := array['kking@conferenceusa.com'];
  v_pw_match  boolean;
  v_email_lc  text := lower(coalesce(p_email, ''));
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
  if p_roku_ip is not null and p_roku_ip !~ '^\d{1,3}(\.\d{1,3}){3}$' then
    raise exception 'invalid roku_ip: %', p_roku_ip;
  end if;
  if p_helo_ip is not null and p_helo_ip !~ '^\d{1,3}(\.\d{1,3}){3}$' then
    raise exception 'invalid helo_ip: %', p_helo_ip;
  end if;

  insert into wsc_encoder_overrides(encoder_id, roku_ip, helo_ip, label, notes, updated_by, updated_at)
  values (p_encoder_id, nullif(p_roku_ip,''), nullif(p_helo_ip,''), nullif(p_label,''), nullif(p_notes,''), v_email_lc, now())
  on conflict (encoder_id) do update set
    roku_ip    = nullif(excluded.roku_ip, ''),
    helo_ip    = nullif(excluded.helo_ip, ''),
    label      = nullif(excluded.label,   ''),
    notes      = nullif(excluded.notes,   ''),
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  return true;
end;
$$;

revoke all on function wsc_encoder_update(text, text, text, text, text, text, text) from public;
grant execute on function wsc_encoder_update(text, text, text, text, text, text, text) to anon;


-- ─── Reset RPC (delete a row → revert to static default) ─────────────────
create or replace function wsc_encoder_reset(
  p_email      text,
  p_pw_hash    text,
  p_encoder_id text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_super_admins text[] := array['kking@conferenceusa.com'];
  v_pw_match  boolean;
  v_email_lc  text := lower(coalesce(p_email, ''));
  v_rows int;
begin
  if not (v_email_lc = any(v_super_admins)) then
    raise exception 'not a roku super admin' using errcode = '42501';
  end if;
  select coalesce(is_active, false) and lower(pw_hash) = lower(p_pw_hash)
    into v_pw_match from admin_users where lower(email) = v_email_lc limit 1;
  if v_pw_match is not true then
    raise exception 'invalid credentials' using errcode = '28000';
  end if;

  delete from wsc_encoder_overrides where encoder_id = p_encoder_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function wsc_encoder_reset(text, text, text) from public;
grant execute on function wsc_encoder_reset(text, text, text) to anon;


-- Tell PostgREST to refresh its schema cache.
notify pgrst, 'reload schema';

-- Sanity check
select 'wsc_encoder_overrides' as object, count(*)::text as rows from wsc_encoder_overrides
union all
select 'wsc_encoder_update', pg_get_function_arguments('wsc_encoder_update'::regproc::oid)
union all
select 'wsc_encoder_reset',  pg_get_function_arguments('wsc_encoder_reset'::regproc::oid);
