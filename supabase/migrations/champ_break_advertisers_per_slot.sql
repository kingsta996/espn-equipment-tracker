-- Promote champ_break_advertisers from per-break to per-slot. The
-- Advertiser column on the Championships table now mirrors the Local
-- column's :30 slots, so each (sport, break_key, spot_index) gets its
-- own advertiser. Existing rows (per-break) are preserved as spot_index 0.
alter table champ_break_advertisers add column if not exists spot_index int not null default 0;
alter table champ_break_advertisers drop constraint if exists champ_break_advertisers_pkey;
alter table champ_break_advertisers add primary key (sport, break_key, spot_index);
