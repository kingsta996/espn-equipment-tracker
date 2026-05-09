-- ─────────────────────────────────────────────────────────────────────────
-- Migration: Seed Michael Adams (Tata Communications) admin user.
--   Has Master Schedule + Multiviewer access (extended via the
--   MULTIVIEWER_ADMINS allowlist in wsc-portal.html). Settings tab remains
--   super-admin-only (kking@conferenceusa.com).
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

insert into admin_users (email, pw_hash, display_name, is_active) values
  ('michael.adams@tatacommunications.com',
   'df1a0171fc3b0ac960f9d342f7b8f2dff86e8945adcb554e0fdcb48af9645c26',  -- SHA-256('TATA_CUSAadmin10')
   'Michael Adams (Tata)',
   true)
on conflict (email) do update set
  pw_hash      = excluded.pw_hash,
  display_name = excluded.display_name,
  is_active    = excluded.is_active;

select email, display_name, is_active from admin_users where email = 'michael.adams@tatacommunications.com';
