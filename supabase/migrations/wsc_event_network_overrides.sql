-- ─────────────────────────────────────────────────────────────────────────
-- Migration: WSC event network overrides
--
-- Lets a super admin override the Network column on any Master Schedule /
-- Manual Capture / Past Events row from the WSC portal, without waiting on
-- the source Google Sheet to be updated. Overrides are keyed by a natural
-- tuple (date|sport|home|away) so they survive an event being re-ingested
-- under a different surrogate id.
--
-- Override always wins on display — set the override to NULL/empty (or call
-- the same RPC with empty string) to revert back to whatever the sheet /
-- schedule_events row says.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists wsc_event_network_overrides (
  event_key   text primary key,
  network     text not null check (length(network) between 1 and 80),
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table wsc_event_network_overrides enable row level security;

drop policy if exists wsc_event_network_overrides_select on wsc_event_network_overrides;

-- Anon needs read access — the portal joins this onto every rendered row.
create policy wsc_event_network_overrides_select on wsc_event_network_overrides
  for select to anon using (true);


-- ─── Set / clear RPC ─────────────────────────────────────────────────────
-- p_network = null or '' → DELETE the override (revert to source value).
-- Otherwise UPSERT.
create or replace function wsc_event_network_set(
  p_email     text,
  p_pw_hash   text,
  p_event_key text,
  p_network   text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_super_admins text[] := array['kking@conferenceusa.com'];
  v_pw_match  boolean;
  v_email_lc  text := lower(coalesce(p_email, ''));
  v_net       text := nullif(trim(coalesce(p_network, '')), '');
begin
  if not (v_email_lc = any(v_super_admins)) then
    raise exception 'not a network-override super admin' using errcode = '42501';
  end if;
  select coalesce(is_active, false) and lower(pw_hash) = lower(p_pw_hash)
    into v_pw_match
    from admin_users
   where lower(email) = v_email_lc
   limit 1;
  if v_pw_match is not true then
    raise exception 'invalid credentials' using errcode = '28000';
  end if;

  if coalesce(length(p_event_key), 0) < 5 then
    raise exception 'event_key required';
  end if;
  if v_net is not null and length(v_net) > 80 then
    raise exception 'network too long (max 80 chars)';
  end if;

  if v_net is null then
    delete from wsc_event_network_overrides where event_key = p_event_key;
  else
    insert into wsc_event_network_overrides(event_key, network, updated_by, updated_at)
    values (p_event_key, v_net, v_email_lc, now())
    on conflict (event_key) do update set
      network    = excluded.network,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;
  end if;
  return true;
end;
$$;

revoke all on function wsc_event_network_set(text, text, text, text) from public;
grant execute on function wsc_event_network_set(text, text, text, text) to anon;


-- Realtime: opt the table into the supabase_realtime publication so other
-- tabs / devices see edits within ~1s. Idempotent.
do $$
begin
  alter publication supabase_realtime add table wsc_event_network_overrides;
exception
  when duplicate_object then null;
  when others           then null;
end$$;


notify pgrst, 'reload schema';

-- Sanity check
select 'wsc_event_network_overrides' as object, count(*)::text as rows from wsc_event_network_overrides
union all
select 'wsc_event_network_set', pg_get_function_arguments('wsc_event_network_set'::regproc::oid);
