-- Advertiser + year metadata for the commercials catalog.
-- For School PSAs the advertiser is the school (school_id), and the
-- canonical filename is built from year + school code + _PSAH suffix.
-- Admins use the Apply ISCI Naming flow in the Admin Panel to backfill
-- this metadata on existing rows.

alter table commercials add column if not exists school_id uuid references schools(id) on delete set null;
alter table commercials add column if not exists year int;

create index if not exists commercials_school_id_idx on commercials(school_id);
