-- Open psa_uploads to the new 'sponsor' category and add the slate metadata
-- fields (title, length_label) captured by the Sponsorship Spot upload modal.

alter table psa_uploads drop constraint if exists psa_uploads_category_check;
alter table psa_uploads add constraint psa_uploads_category_check
  check (category in ('school_psa','cusa_psa','sponsor'));

alter table psa_uploads add column if not exists title text;
alter table psa_uploads add column if not exists length_label text;

-- Pre-create the 'sponsor' row in psa_config so the admin URL input has
-- somewhere to land on first save (psa_config.category has no CHECK, so the
-- only requirement is a row to upsert into).
insert into psa_config (category) values ('sponsor') on conflict (category) do nothing;
