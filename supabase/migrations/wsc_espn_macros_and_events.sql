-- ─────────────────────────────────────────────────────────────────────────
-- wsc_espn_macros_and_events.sql
--
-- Adds the two foundational tables for the ESPN macro scheduler:
--
--   • wsc_espn_events  — master list of CUSA football + MBB + WBB events
--                        ingested from ESPN's public API by a 15-min cron.
--                        Tracks kickoff time, status, and a change log so
--                        time-shifts and cancellations are auditable.
--   • wsc_espn_macros  — admin-scheduled fires for each event: which
--                        encoder, which search query, when to fire, plus a
--                        status field driven by roku_commands transitions.
--
-- Also extends:
--   • roku_commands.kind CHECK constraint to allow the new 'text' and
--     'macro' command kinds the relay now supports.
--   • wsc_roku_enqueue() RPC to validate + accept those kinds.
--   • A trigger that propagates roku_commands status → wsc_espn_macros
--     so the scheduler doesn't have to poll the queue itself.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────


-- ─── 1. Loosen roku_commands.kind constraint ─────────────────────────────
alter table roku_commands
  drop constraint if exists roku_commands_kind_check;

alter table roku_commands
  add constraint roku_commands_kind_check
  check (kind in ('keypress', 'launch', 'text', 'macro'));


-- ─── 2. Extend wsc_roku_enqueue to accept text + macro ───────────────────
-- Drop the prior signature so the CREATE OR REPLACE doesn't conflict on
-- the body change (PG won't replace if the function body has a different
-- exception path mid-function — safer to recreate).
drop function if exists wsc_roku_enqueue(text, text, text, text, text, text);

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
  v_pw_match   boolean;
  v_email_lc   text := lower(coalesce(p_email, ''));
  v_id         uuid;
  v_parsed     jsonb;
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
  if p_kind not in ('keypress', 'launch', 'text', 'macro') then
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
  if p_kind = 'text' then
    if coalesce(length(p_payload), 0) = 0 then
      raise exception 'text payload empty';
    end if;
    if length(p_payload) > 100 then
      raise exception 'text payload too long (max 100)';
    end if;
    -- Printable ASCII only — matches relay's _exec_text guard.
    if p_payload ~ '[^\x20-\x7E]' then
      raise exception 'text payload must be printable ASCII only';
    end if;
  end if;
  if p_kind = 'macro' then
    -- Cap payload size before the JSON parse so a malicious row can't
    -- pin the parser with megabytes of garbage.
    if coalesce(length(p_payload), 0) > 20000 then
      raise exception 'macro payload too large (max 20KB)';
    end if;
    begin
      v_parsed := p_payload::jsonb;
    exception when others then
      raise exception 'macro payload is not valid JSON';
    end;
    if jsonb_typeof(v_parsed) <> 'array' then
      raise exception 'macro payload must be a JSON array';
    end if;
    if jsonb_array_length(v_parsed) = 0 then
      raise exception 'macro payload array is empty';
    end if;
    if jsonb_array_length(v_parsed) > 50 then
      raise exception 'macro payload has too many steps (max 50)';
    end if;
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


-- ─── 3. wsc_espn_events — master event list ──────────────────────────────
create table if not exists wsc_espn_events (
  espn_event_id      text primary key,
  sport              text not null
                       check (sport in ('football', 'mens-basketball', 'womens-basketball')),
  league_slug        text not null,            -- ESPN league slug, e.g. 'college-football'
  season_year        int  not null,
  season_type        int  not null,            -- 1=preseason 2=regular 3=postseason 4=offseason
  name               text not null,            -- ESPN's full event name
  short_name         text,                     -- 'AWAY @ HOME'
  home_team          text not null,
  home_team_id       text,
  home_is_cusa       boolean not null default false,
  away_team          text not null,
  away_team_id       text,
  away_is_cusa       boolean not null default false,
  kickoff_at         timestamptz not null,
  status             text not null default 'scheduled'
                       check (status in ('scheduled', 'in', 'post', 'canceled', 'postponed')),
  broadcast          text[],                   -- e.g. {'ESPN+','ESPNU'}
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  last_changed_at    timestamptz not null default now(),
  change_log         jsonb not null default '[]'::jsonb,  -- [{field,old,new,at}]
  raw                jsonb,                    -- the ESPN scoreboard event row, for forensics
  notes              text
);

create index if not exists wsc_espn_events_kickoff_idx     on wsc_espn_events(kickoff_at);
create index if not exists wsc_espn_events_sport_idx       on wsc_espn_events(sport);
create index if not exists wsc_espn_events_status_idx      on wsc_espn_events(status);
create index if not exists wsc_espn_events_last_seen_idx   on wsc_espn_events(last_seen_at desc);

alter table wsc_espn_events enable row level security;
drop policy if exists wsc_espn_events_select on wsc_espn_events;
create policy wsc_espn_events_select on wsc_espn_events
  for select to anon using (true);
-- Writes go through wsc_espn_events_upsert() (SECURITY DEFINER) called by the
-- scanner. Anon clients can read but never write.


-- ─── 4. wsc_espn_macros — scheduled fires ────────────────────────────────
create table if not exists wsc_espn_macros (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by_email   text not null,
  encoder_id         text not null check (encoder_id ~ '^CUSA([1-9]|10)$'),
  espn_event_id      text references wsc_espn_events(espn_event_id) on delete set null,
  sport              text,                       -- denorm of event.sport at schedule time
  matchup_label      text,                       -- 'Liberty @ MTSU' for the queue view
  search_query       text not null check (length(search_query) between 1 and 100),
  result_index       int  not null default 0 check (result_index >= 0 and result_index <= 20),
  trigger_at         timestamptz not null,       -- when the scheduler enqueues the macro
  kickoff_at         timestamptz,                -- for human readability + sort
  status             text not null default 'pending'
                       check (status in ('pending', 'fired', 'completed', 'failed', 'canceled')),
  fired_command_id   uuid references roku_commands(id) on delete set null,
  result_log         jsonb,                      -- relay's reported result, copied from roku_commands.result
  notes              text
);

create index if not exists wsc_espn_macros_trigger_idx
  on wsc_espn_macros(trigger_at)
  where status = 'pending';
create index if not exists wsc_espn_macros_kickoff_idx
  on wsc_espn_macros(kickoff_at desc);
create index if not exists wsc_espn_macros_event_idx
  on wsc_espn_macros(espn_event_id);
create index if not exists wsc_espn_macros_encoder_idx
  on wsc_espn_macros(encoder_id, kickoff_at);

alter table wsc_espn_macros enable row level security;

drop policy if exists wsc_espn_macros_select on wsc_espn_macros;
create policy wsc_espn_macros_select on wsc_espn_macros
  for select to anon using (true);

-- Writes go through wsc_espn_macro_upsert + wsc_espn_macro_cancel below.


-- ─── 5. Trigger: propagate roku_commands → wsc_espn_macros status ────────
-- When the relay reports back via wsc_roku_complete(), the roku_commands
-- row's status flips ok/error. This trigger mirrors that into the linked
-- macro row so the scheduler view stays accurate without extra polling.
create or replace function wsc_espn_macros_sync_from_roku_cmd()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;
  update wsc_espn_macros
     set status = case new.status
                    when 'ok'    then 'completed'
                    when 'error' then 'failed'
                    else status                    -- 'running' is intermediate
                  end,
         result_log = coalesce(new.result, result_log)
   where fired_command_id = new.id
     and status = 'fired';
  return new;
end;
$$;

drop trigger if exists trg_wsc_espn_macros_from_roku_cmd on roku_commands;
create trigger trg_wsc_espn_macros_from_roku_cmd
  after update of status on roku_commands
  for each row execute function wsc_espn_macros_sync_from_roku_cmd();


-- ─── 6. RPC: wsc_espn_macro_upsert ───────────────────────────────────────
-- Admin-only create/update of a scheduled macro. Defaults trigger_at to
-- kickoff − 4 min if the caller doesn't pass one (matches the discovery
-- finding that ESPN tiles only flip to "live-ready" within ~5 min of
-- kickoff).
create or replace function wsc_espn_macro_upsert(
  p_email          text,
  p_pw_hash        text,
  p_id             uuid,             -- null = insert; non-null = update
  p_encoder_id     text,
  p_espn_event_id  text,
  p_search_query   text,
  p_result_index   int,
  p_kickoff_at     timestamptz,
  p_trigger_at     timestamptz default null,
  p_notes          text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_super_admins text[] := array['kking@conferenceusa.com'];
  v_email_lc text := lower(coalesce(p_email, ''));
  v_pw_match boolean;
  v_trigger  timestamptz;
  v_event    wsc_espn_events%rowtype;
  v_id       uuid;
begin
  if not (v_email_lc = any(v_super_admins)) then
    raise exception 'not a roku super admin' using errcode = '42501';
  end if;
  select coalesce(is_active, false) and lower(pw_hash) = lower(p_pw_hash)
    into v_pw_match from admin_users where lower(email) = v_email_lc limit 1;
  if v_pw_match is not true then
    raise exception 'invalid credentials' using errcode = '28000';
  end if;

  if p_encoder_id !~ '^CUSA([1-9]|10)$' then
    raise exception 'invalid encoder_id: %', p_encoder_id;
  end if;
  if coalesce(length(p_search_query), 0) = 0 then
    raise exception 'search_query required';
  end if;
  v_trigger := coalesce(p_trigger_at, p_kickoff_at - interval '4 minutes');

  -- Denorm sport + matchup_label from the event row when available, so the
  -- queue view is one query instead of a join.
  if p_espn_event_id is not null then
    select * into v_event from wsc_espn_events where espn_event_id = p_espn_event_id limit 1;
  end if;

  if p_id is null then
    insert into wsc_espn_macros(
      created_by_email, encoder_id, espn_event_id,
      sport, matchup_label,
      search_query, result_index,
      trigger_at, kickoff_at, notes
    ) values (
      v_email_lc, p_encoder_id, p_espn_event_id,
      v_event.sport,
      coalesce(v_event.short_name, v_event.away_team || ' @ ' || v_event.home_team),
      p_search_query, coalesce(p_result_index, 0),
      v_trigger, p_kickoff_at, p_notes
    ) returning id into v_id;
  else
    update wsc_espn_macros set
      encoder_id     = p_encoder_id,
      espn_event_id  = p_espn_event_id,
      sport          = coalesce(v_event.sport, sport),
      matchup_label  = coalesce(
                         coalesce(v_event.short_name, v_event.away_team || ' @ ' || v_event.home_team),
                         matchup_label),
      search_query   = p_search_query,
      result_index   = coalesce(p_result_index, 0),
      trigger_at     = v_trigger,
      kickoff_at     = p_kickoff_at,
      notes          = p_notes
    where id = p_id and status = 'pending'        -- only pending rows are editable
    returning id into v_id;
    if v_id is null then
      raise exception 'macro % not found or not pending', p_id;
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function wsc_espn_macro_upsert(text, text, uuid, text, text, text, int, timestamptz, timestamptz, text) from public;
grant execute on function wsc_espn_macro_upsert(text, text, uuid, text, text, text, int, timestamptz, timestamptz, text) to anon;


create or replace function wsc_espn_macro_cancel(
  p_email   text,
  p_pw_hash text,
  p_id      uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_super_admins text[] := array['kking@conferenceusa.com'];
  v_email_lc text := lower(coalesce(p_email, ''));
  v_pw_match boolean;
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

  update wsc_espn_macros
     set status = 'canceled'
   where id = p_id
     and status = 'pending';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function wsc_espn_macro_cancel(text, text, uuid) from public;
grant execute on function wsc_espn_macro_cancel(text, text, uuid) to anon;


-- ─── 7a. wsc_app_secrets — tiny config table for SECURITY DEFINER funcs ──
-- Supabase's hosted Postgres won't let us set `app.*` database parameters
-- (permission denied: only the platform itself owns those), so we keep
-- shared secrets in this RLS-locked table. Anon never sees it; only
-- SECURITY DEFINER functions and the service_role can read.
create table if not exists wsc_app_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  notes      text
);
alter table wsc_app_secrets enable row level security;
-- No anon SELECT/INSERT/UPDATE/DELETE policies → RLS denies by default.
-- SECURITY DEFINER functions (running as the function owner) bypass RLS.


-- ─── 7b. RPC: wsc_espn_events_upsert ─────────────────────────────────────
-- Called by the GitHub Action ESPN scanner with a batch of event rows.
-- Inserts new events, updates changed ones (recording a change_log entry
-- for kickoff or status flips), and refreshes last_seen_at for everything
-- it saw this scan. Returns counts.
--
-- Token gate: caller posts p_token; we compare against the value stored
-- under key='espn_scan_token' in wsc_app_secrets. Setting the token:
--   insert into wsc_app_secrets(key, value)
--   values ('espn_scan_token', '<long-random-secret>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
create or replace function wsc_espn_events_upsert(
  p_token   text,
  p_events  jsonb                    -- array of event objects
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
  v_evt   jsonb;
  v_existing wsc_espn_events%rowtype;
  v_inserted int := 0;
  v_updated  int := 0;
  v_unchanged int := 0;
  v_now timestamptz := now();
  v_changes jsonb;
  v_change_log jsonb;
begin
  select value into v_token from wsc_app_secrets where key = 'espn_scan_token' limit 1;
  if v_token is null or length(v_token) < 16 or v_token <> p_token then
    raise exception 'invalid scan token' using errcode = '42501';
  end if;
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'p_events must be a JSON array';
  end if;

  for v_evt in select jsonb_array_elements(p_events) loop
    select * into v_existing from wsc_espn_events
      where espn_event_id = v_evt->>'espn_event_id' limit 1;

    if not found then
      insert into wsc_espn_events(
        espn_event_id, sport, league_slug, season_year, season_type,
        name, short_name, home_team, home_team_id, home_is_cusa,
        away_team, away_team_id, away_is_cusa,
        kickoff_at, status, broadcast, raw
      ) values (
        v_evt->>'espn_event_id',
        v_evt->>'sport',
        v_evt->>'league_slug',
        (v_evt->>'season_year')::int,
        coalesce((v_evt->>'season_type')::int, 2),
        coalesce(v_evt->>'name', v_evt->>'short_name'),
        v_evt->>'short_name',
        v_evt->>'home_team',
        v_evt->>'home_team_id',
        coalesce((v_evt->>'home_is_cusa')::boolean, false),
        v_evt->>'away_team',
        v_evt->>'away_team_id',
        coalesce((v_evt->>'away_is_cusa')::boolean, false),
        (v_evt->>'kickoff_at')::timestamptz,
        coalesce(v_evt->>'status', 'scheduled'),
        case when v_evt ? 'broadcast' then
          (select array_agg(value::text)::text[] from jsonb_array_elements_text(v_evt->'broadcast'))
        else null end,
        v_evt->'raw'
      );
      v_inserted := v_inserted + 1;
    else
      v_changes := '[]'::jsonb;
      if v_existing.kickoff_at <> (v_evt->>'kickoff_at')::timestamptz then
        v_changes := v_changes || jsonb_build_object(
          'field', 'kickoff_at',
          'old',   v_existing.kickoff_at,
          'new',   (v_evt->>'kickoff_at')::timestamptz,
          'at',    v_now
        );
      end if;
      if v_existing.status <> coalesce(v_evt->>'status', 'scheduled') then
        v_changes := v_changes || jsonb_build_object(
          'field', 'status',
          'old',   v_existing.status,
          'new',   coalesce(v_evt->>'status', 'scheduled'),
          'at',    v_now
        );
      end if;

      if jsonb_array_length(v_changes) > 0 then
        v_change_log := v_existing.change_log || v_changes;
        update wsc_espn_events set
          kickoff_at     = (v_evt->>'kickoff_at')::timestamptz,
          status         = coalesce(v_evt->>'status', 'scheduled'),
          broadcast      = case when v_evt ? 'broadcast' then
                             (select array_agg(value::text)::text[] from jsonb_array_elements_text(v_evt->'broadcast'))
                           else broadcast end,
          raw            = v_evt->'raw',
          last_seen_at   = v_now,
          last_changed_at= v_now,
          change_log     = v_change_log
        where espn_event_id = v_existing.espn_event_id;
        v_updated := v_updated + 1;
      else
        update wsc_espn_events set last_seen_at = v_now
         where espn_event_id = v_existing.espn_event_id;
        v_unchanged := v_unchanged + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted',  v_inserted,
    'updated',   v_updated,
    'unchanged', v_unchanged,
    'total',     v_inserted + v_updated + v_unchanged,
    'at',        v_now
  );
end;
$$;
revoke all on function wsc_espn_events_upsert(text, jsonb) from public;
-- Note: this RPC is anon-callable, but token-gated. The scanner posts the
-- shared secret in p_token; without a match the function raises.
grant execute on function wsc_espn_events_upsert(text, jsonb) to anon;


-- ─── 8. RPC: wsc_espn_macros_dispatch_due ───────────────────────────────
-- Called by cusa_relay.py on every poll cycle. Atomically finds macros
-- that are due (status='pending' AND trigger_at <= now()), builds the
-- canonical ESPN-search macro JSON from the row's search_query +
-- result_index, inserts a 'macro' kind row into roku_commands (so the
-- normal command-execution path picks it up), and marks the macro row
-- 'fired'. Returns one row per dispatched macro for the relay to log.
--
-- Authorization: the relay passes its pairing key (p_agent_key); we hash
-- it and use that as the new roku_commands row's agent_key_hash so the
-- same relay (and only that relay) picks the command up on its next
-- queue scan.
--
-- The macro template is hardcoded here — change it by deploying a new
-- migration. Placeholders:
--   <search_query>  → the row's search_query (typed via Lit_)
--   <result_index>  → number of Down presses after escaping the keyboard
create or replace function wsc_espn_macros_dispatch_due(
  p_agent_key  text,
  p_limit      int default 5
) returns table (
  macro_id    uuid,
  command_id  uuid,
  encoder_id  text,
  kickoff_at  timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text;
  v_now timestamptz := now();
  r record;
  v_macro_json jsonb;
  v_cmd_id uuid;
begin
  if coalesce(length(p_agent_key), 0) < 16 then
    raise exception 'agent key too short';
  end if;
  v_hash := encode(sha256(p_agent_key::bytea), 'hex');

  for r in
    select m.id, m.encoder_id, m.search_query, m.result_index, m.kickoff_at
      from wsc_espn_macros m
     where m.status = 'pending'
       and m.trigger_at <= v_now
     order by m.trigger_at asc
     limit greatest(1, least(coalesce(p_limit, 5), 25))
     for update skip locked
  loop
    -- Build the macro JSON. result_index controls the number of Down
    -- presses after Right×6 lands focus on the first result tile.
    v_macro_json := jsonb_build_array(
      jsonb_build_object('action','keypress','payload','Home',   'wait_ms', 3000),
      jsonb_build_object('action','launch',  'payload','34376',  'wait_ms', 15000),
      jsonb_build_object('action','keypress','payload','Left',   'wait_ms', 1500),
      jsonb_build_object('action','keypress','payload','Up',     'wait_ms', 1500),
      jsonb_build_object('action','keypress','payload','Select', 'wait_ms', 6000),
      jsonb_build_object('action','text',    'payload', r.search_query, 'wait_ms', 2000),
      jsonb_build_object('action','keypress','payload','Right',  'wait_ms', 400, 'repeat', 6),
      jsonb_build_object('action','keypress','payload','Down',   'wait_ms', 400, 'repeat', coalesce(r.result_index, 0)),
      jsonb_build_object('action','keypress','payload','Select', 'wait_ms', 10000),
      jsonb_build_object('action','keypress','payload','Select', 'wait_ms', 2000)
    );

    insert into roku_commands(
      created_by_email, agent_key_hash, encoder_id, kind, payload,
      expires_at
    ) values (
      'scheduler@cusa', v_hash, r.encoder_id, 'macro', v_macro_json::text,
      -- Macros take ~50s; give the relay 5 minutes to pick up + run.
      now() + interval '5 minutes'
    )
    returning id into v_cmd_id;

    update wsc_espn_macros
       set status = 'fired',
           fired_command_id = v_cmd_id
     where id = r.id;

    macro_id    := r.id;
    command_id  := v_cmd_id;
    encoder_id  := r.encoder_id;
    kickoff_at  := r.kickoff_at;
    return next;
  end loop;
end;
$$;
revoke all on function wsc_espn_macros_dispatch_due(text, int) from public;
grant execute on function wsc_espn_macros_dispatch_due(text, int) to anon;


-- ─── 9. Sanity output ────────────────────────────────────────────────────
select 'wsc_roku_enqueue (extended)' as fn,
       pg_get_function_identity_arguments('wsc_roku_enqueue'::regproc::oid) as args
union all
select 'wsc_espn_macro_upsert',
       pg_get_function_identity_arguments('wsc_espn_macro_upsert'::regproc::oid)
union all
select 'wsc_espn_macro_cancel',
       pg_get_function_identity_arguments('wsc_espn_macro_cancel'::regproc::oid)
union all
select 'wsc_espn_events_upsert',
       pg_get_function_identity_arguments('wsc_espn_events_upsert'::regproc::oid)
union all
select 'wsc_espn_macros_dispatch_due',
       pg_get_function_identity_arguments('wsc_espn_macros_dispatch_due'::regproc::oid);
