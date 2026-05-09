-- ─────────────────────────────────────────────────────────────────────────
-- Migration: Chat Support logs + FAQ
--   • chat_logs  — one row per chat turn (Production Hub + Creative Hub).
--   • chat_faq   — curated Q&A entries promoted from logs by kking@.
--   Front-ends: hub.html (Production Hub), index.html (Creative Hub),
--               faq.html (public reader), chatlogs.html (admin).
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists chat_logs (
  id                  uuid primary key default gen_random_uuid(),
  app                 text not null check (app in ('production_hub', 'creative_hub')),
  conversation_id     text,
  message_index       integer,
  user_email          text,
  user_display_name   text,
  user_role           text,
  user_message        text not null,
  assistant_reply     text,
  model               text,
  input_tokens        integer,
  output_tokens       integer,
  cache_read_tokens   integer,
  cache_creation_tokens integer,
  faq_slugs_referenced text[],
  promoted_to_faq     boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists chat_logs_app_created_idx on chat_logs (app, created_at desc);
create index if not exists chat_logs_user_idx       on chat_logs (user_email, created_at desc);

alter table chat_logs enable row level security;
drop policy if exists "public read chat logs"  on chat_logs;
drop policy if exists "public write chat logs" on chat_logs;
create policy "public read chat logs"  on chat_logs for select using (true);
create policy "public write chat logs" on chat_logs for all    using (true) with check (true);

create table if not exists chat_faq (
  id                  uuid primary key default gen_random_uuid(),
  slug                text unique not null,
  app                 text not null check (app in ('production_hub', 'creative_hub', 'both')),
  category            text,
  question            text not null,
  answer              text not null,
  keywords            text[],
  source_chat_log_id  uuid references chat_logs(id) on delete set null,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  is_active           boolean not null default true,
  view_count          integer not null default 0,
  sort_order          integer not null default 0
);
create index if not exists chat_faq_app_active_idx on chat_faq (app, is_active);

alter table chat_faq enable row level security;
drop policy if exists "public read chat faq"  on chat_faq;
drop policy if exists "public write chat faq" on chat_faq;
create policy "public read chat faq"  on chat_faq for select using (true);
create policy "public write chat faq" on chat_faq for all    using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table chat_faq;
exception when duplicate_object then null; end $$;

select count(*) as chat_logs_rows from chat_logs;
select count(*) as chat_faq_rows  from chat_faq;
