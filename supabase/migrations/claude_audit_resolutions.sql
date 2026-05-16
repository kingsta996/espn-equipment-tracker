-- Claude Audit risk resolution tracking. Adds resolution metadata to
-- claude_audit_events so admins can mark High/Critical alerts as resolved
-- (with a note about the steps taken). Resolved events drop out of the
-- "active risks" tally on the overview but remain in the full log and the
-- downloadable IT report for audit trail.
--
-- The local ~/claude-audit/*.log on Keith's workstation remains the immutable
-- chain-of-custody. This table is the working-dashboard mirror — layering
-- resolution metadata here does not alter the source-of-truth log.
--
-- Run in Supabase Studio SQL editor.

alter table claude_audit_events add column if not exists resolution_notes text;
alter table claude_audit_events add column if not exists resolved_at      timestamptz;
alter table claude_audit_events add column if not exists resolved_by      text;

-- Partial index: most rows are unresolved (resolved_at IS NULL), so a partial
-- index on resolved rows keeps the "active high/critical risks" filter fast.
create index if not exists claude_audit_events_resolved_idx
  on claude_audit_events (resolved_at)
  where resolved_at is not null;

-- Allow anon UPDATE of resolution metadata. The Hub admin pages are the only
-- clients that touch this; access is gated at the app layer by the admin
-- legacy-hash sign-in (same pattern as the other public-write tables in this
-- project — sponsors, championship_*, schedule_events).
drop policy if exists claude_audit_events_anon_update on claude_audit_events;
create policy claude_audit_events_anon_update on claude_audit_events
  for update to anon using (true) with check (true);

comment on column claude_audit_events.resolution_notes is 'Admin-entered notes describing the steps taken to address a High/Critical risk alert. Null = unresolved.';
comment on column claude_audit_events.resolved_at      is 'Timestamp when an admin marked the alert resolved. Null = unresolved.';
comment on column claude_audit_events.resolved_by      is 'Email of the admin who marked the alert resolved.';
