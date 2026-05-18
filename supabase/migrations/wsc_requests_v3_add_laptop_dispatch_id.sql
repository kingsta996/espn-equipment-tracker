-- ─────────────────────────────────────────────────────────────────────────
-- wsc_requests_v3_add_laptop_dispatch_id.sql
--
-- Adds the laptop_dispatch_id FK to wsc_requests so confirmed self-
-- service requests can point at the new wsc_laptop_dispatches row (the
-- browser-on-laptop pipeline that replaces the Roku ECP macro path for
-- staff requests).
--
-- The existing espn_macro_id column stays nullable and on-delete-set-
-- null so old rows continue to work; new rows populate laptop_dispatch_id
-- only.
--
-- Run AFTER wsc_laptop_dispatches.sql. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

alter table wsc_requests
  add column if not exists laptop_dispatch_id uuid
  references wsc_laptop_dispatches(id) on delete set null;

create index if not exists wsc_requests_dispatch_idx on wsc_requests(laptop_dispatch_id);

-- Relax encoder_id so laptop dispatches (which have no Roku encoder)
-- can be logged. Drop the CUSA-only CHECK + NOT NULL.
alter table wsc_requests
  drop constraint if exists wsc_requests_encoder_id_check;

alter table wsc_requests
  alter column encoder_id drop not null;
