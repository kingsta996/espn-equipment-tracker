-- ─────────────────────────────────────────────────────────────────────────
-- Migration: schools.code
-- Adds an NCAA-standard short code to each school for use in agency-bound
-- filenames (e.g. PSA submissions). Filename math: 4-digit year + code +
-- "_PSAH" must stay ≤ 15 characters, so codes are capped at 6.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

alter table schools add column if not exists code text;

create unique index if not exists schools_code_unique
  on schools (lower(code))
  where code is not null and code <> '';

-- Seed/refresh codes for the schools currently in the directory. Edit this
-- list and re-run if a code needs to change for an agency requirement.
update schools set code = 'WKU'   where name = 'Western Kentucky';
update schools set code = 'SHSU'  where name = 'Sam Houston';
update schools set code = 'NMSU'  where name = 'New Mexico State';
update schools set code = 'MTSU'  where name = 'MTSU';
update schools set code = 'LIB'   where name = 'Liberty';
update schools set code = 'JSU'   where name = 'Jacksonville State';
update schools set code = 'FIU'   where name = 'FIU';
update schools set code = 'DEL'   where name = 'Delaware';
update schools set code = 'KSU'   where name = 'Kennesaw State';
update schools set code = 'DBU'   where name = 'Dallas Baptist';
update schools set code = 'LATECH' where name = 'Louisiana Tech';
update schools set code = 'MOST'  where name = 'Missouri State';
update schools set code = 'UTEP'  where name = 'UTEP';

-- Sanity check
select name, code from schools order by name;
