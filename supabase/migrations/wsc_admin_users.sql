-- ─────────────────────────────────────────────────────────────────────────
-- Migration: Seed Tata Communications NOC admin user for the WSC portal
--   pw_hash is SHA-256 of the plaintext password (matches the legacy hash
--   format used elsewhere in the portal — see hashPw() in wsc-portal.html).
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

insert into admin_users (email, pw_hash, display_name, is_active) values
  ('mes-noc@tatacommunications.com',
   'df1a0171fc3b0ac960f9d342f7b8f2dff86e8945adcb554e0fdcb48af9645c26',  -- SHA-256('TATA_CUSAadmin10')
   'Tata Communications NOC',
   true)
on conflict (email) do update set
  pw_hash      = excluded.pw_hash,
  display_name = excluded.display_name,
  is_active    = excluded.is_active;

-- Sanity check
select email, display_name, is_active from admin_users where email = 'mes-noc@tatacommunications.com';
