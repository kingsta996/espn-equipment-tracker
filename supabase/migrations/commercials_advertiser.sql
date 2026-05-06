-- Advertiser metadata for the commercials catalog. Free-text — for School
-- PSAs the admin types the school name; for sponsorships the brand. Admins
-- edit this from the Admin Panel's School PSA Advertisers table.
-- (school_id / year were added during an earlier iteration that auto-built
-- ISCI filenames; left in place but no longer used by the UI.)

alter table commercials add column if not exists school_id uuid references schools(id) on delete set null;
alter table commercials add column if not exists year int;
alter table commercials add column if not exists advertiser text;

create index if not exists commercials_school_id_idx on commercials(school_id);
