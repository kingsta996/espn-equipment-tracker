-- Claude Code audit log ingest. Receives one row per tool-call event from the
-- Claude Code hook chain on Keith's workstation (see claude-audit-ingest.js
-- Netlify Function + ~/.claude/settings.json http hooks). The local file at
-- ~/claude-audit/YYYY-MM-DD.log remains the chain-of-custody copy; this table
-- is the queryable mirror that the Production and Creative Hub admin pages
-- read for the Claude Audit section.
--
-- Run this in Supabase Studio: SQL Editor → New Query → paste → Run.

create table if not exists claude_audit_events (
  id           bigserial primary key,
  ts           timestamptz not null,
  event        text not null,        -- PreToolUse | PostToolUse | PostToolUseFailure | UserPromptSubmit | SessionStart | Stop | Notification
  tool         text,                 -- Bash | Write | Edit | Read | WebFetch | Grep | Glob | mcp_* | null for non-tool events
  input        jsonb,                -- tool_input for tool events, {prompt:…} for UserPromptSubmit, etc.
  response     jsonb,                -- partial response for PostToolUseFailure; null otherwise
  status       text,                 -- 'success' | 'failure' | null
  cwd          text,                 -- working directory at time of event
  session_id   text,                 -- Claude Code session id
  host         text,                 -- workstation hostname
  os_user      text,                 -- $USER on the workstation
  received_at  timestamptz default now()
);

create index if not exists claude_audit_events_ts_idx        on claude_audit_events (ts desc);
create index if not exists claude_audit_events_cwd_idx       on claude_audit_events (cwd);
create index if not exists claude_audit_events_session_idx   on claude_audit_events (session_id);
create index if not exists claude_audit_events_event_idx     on claude_audit_events (event);
create index if not exists claude_audit_events_tool_idx      on claude_audit_events (tool);

alter table claude_audit_events enable row level security;

-- Anon SELECT: the Hub admin pages query via the public anon key. Front-end
-- already gates these pages to admin_users / creative_hub_users with role=admin,
-- matching the chat_logs pattern.
drop policy if exists claude_audit_events_anon_select on claude_audit_events;
create policy claude_audit_events_anon_select on claude_audit_events
  for select to anon using (true);

-- No anon INSERT/UPDATE/DELETE — only the Netlify ingest function writes,
-- using the service-role key.

comment on table  claude_audit_events is 'Mirror of Claude Code tool-call events from Keith''s workstation. Source of truth is ~/claude-audit/YYYY-MM-DD.log on disk; this table is the queryable copy.';
comment on column claude_audit_events.ts          is 'When the event occurred on the workstation (UTC, from the hook).';
comment on column claude_audit_events.received_at is 'When the Netlify ingest accepted the row.';
comment on column claude_audit_events.input       is 'Raw tool_input (Bash command, file_path, URL, etc.). For UserPromptSubmit: {prompt}.';
