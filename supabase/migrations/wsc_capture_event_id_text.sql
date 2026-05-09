-- ─────────────────────────────────────────────────────────────────────────
-- Migration: relax wsc_capture_status.schedule_event_id from uuid → text
--   External (Sidearm-scraped) events use 'ext_*' string IDs, not UUIDs,
--   so A/V Confirmed + encoder selection couldn't be saved on those rows.
--   wsc_event_dismissals.event_id already uses text for the same reason.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- Drop the FK to schedule_events first (its target column is uuid).
alter table wsc_capture_status
  drop constraint if exists wsc_capture_status_schedule_event_id_fkey;

-- Cast the column to text; existing UUID values cast cleanly.
alter table wsc_capture_status
  alter column schedule_event_id type text using schedule_event_id::text;

-- Sanity check
select count(*) as wsc_capture_rows from wsc_capture_status;
