-- Per-break advertiser text for the CBSSN Championships format. Each row is
-- one (sport, break_key) pair so the Championships table can show a
-- free-text Advertiser column that admins edit inline and that flows into
-- the PDF export.
create table if not exists champ_break_advertisers (
  sport text not null,
  break_key text not null,
  advertiser text,
  updated_at timestamptz default now(),
  updated_by text,
  primary key (sport, break_key)
);

alter table champ_break_advertisers enable row level security;
drop policy if exists "public read champ break advertisers"  on champ_break_advertisers;
drop policy if exists "public write champ break advertisers" on champ_break_advertisers;
create policy "public read champ break advertisers"  on champ_break_advertisers for select using (true);
create policy "public write champ break advertisers" on champ_break_advertisers for all    using (true) with check (true);
