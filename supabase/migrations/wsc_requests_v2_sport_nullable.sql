-- ─────────────────────────────────────────────────────────────────────────
-- wsc_requests_v2_sport_nullable.sql
--
-- Follow-up to wsc_requests.sql: the staff request form no longer collects
-- Sport (we search by CUSA school name only — the search process surfaces
-- whichever game is live, regardless of sport). Relax the column so future
-- inserts can omit it.
--
-- Drops the NOT NULL constraint and the length CHECK. Existing rows are
-- unaffected. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

alter table wsc_requests
  drop constraint if exists wsc_requests_sport_check;

alter table wsc_requests
  alter column sport drop not null;
