-- CUSA ESPN — Commercials Hub seed
-- Run AFTER schema.sql. Safe to re-run (uses NOT EXISTS guard on box_file_id).
-- Source: Box folder inventory pulled 2026-05-02.
--   School PSAs   → conferenceusa.box.com/folder/324548301187
--   CUSA Produced → conferenceusa.box.com/folder/330200154415
--   Sponsors      → conferenceusa.box.com/folder/365988868026

with seed (name, category, box_file_id) as (
  values
    -- School PSAs (13)
    ('2025CUSAFIU1005H.mp4',                      'school_psa', '1942877156529'),
    ('2025KSUCUSAPSAH.mp4',                       'school_psa', '2035480374172'),
    ('JAXSTATEJOURNEY30H.mp4',                    'school_psa', '1946372243187'),
    ('JAXSTSPARK30H.mp4',                         'school_psa', '1947477368541'),
    ('LATU0825M1H.mp4',                           'school_psa', '1955653657284'),
    ('MSU30PSA2025H.mp4',                         'school_psa', '1917034103906'),
    ('NMSUPSA2025H.mp4',                          'school_psa', '1928016347011'),
    ('SHSU30PSA2025.mp4',                         'school_psa', '1883183374805'),
    ('UDNOLIMITS2025H.mp4',                       'school_psa', '1941668193297'),
    ('UTEPIS2025H.mp4',                           'school_psa', '1947473502290'),
    ('UUMT0026000H.mp4',                          'school_psa', '1942963732463'),
    ('VYLU0036000H.mp4',                          'school_psa', '2110899964528'),
    ('WKU Spot – Updated April 2026.mp4',         'school_psa', '2189676040530'),
    -- CUSA Produced PSAs (17)
    ('2025VBCHAMPS.mp4',                          'cusa_psa',   '1958325928787'),
    ('2025WSOCCHAMP.mp4',                         'cusa_psa',   '1958325460280'),
    ('2026 CUSA Basketball TV Spot (30 seconds).mp4', 'cusa_psa', '2103873853641'),
    ('2026HUNTSVILLEPROMOH.mp4',                  'cusa_psa',   '2033405845826'),
    ('26CUSABASEH.mp4',                           'cusa_psa',   '2134179469456'),
    ('26CUSASBH.mp4',                             'cusa_psa',   '2134166941664'),
    ('CUSA-HSV 2026 Promo 30s.mp4',               'cusa_psa',   '2012531824574'),
    ('CUSACCCHAMP25H.mp4',                        'cusa_psa',   '1975946068166'),
    ('CUSAEYFT2025H.mp4',                         'cusa_psa',   '1958295789402'),
    ('CUSAINSIDER2025H.mp4',                      'cusa_psa',   '1975855544490'),
    ('CUSAINSIDER25H.mp4',                        'cusa_psa',   '1942956711809'),
    ('NLOU25CUSAH (Updated 3.3).mp4',             'cusa_psa',   '2152891245019'),
    ('PROFOTY2025H.mp4',                          'cusa_psa',   '1963075303020'),
    ('SAACSPOT2025H.mp4',                         'cusa_psa',   '1947470684994'),
    ('STMPGRND25CUSAH.mp4',                       'cusa_psa',   '1942943550872'),
    ('WEAREWSCUSA25H.mp4',                        'cusa_psa',   '1967304746142'),
    ('WEEKDAYCUSA2025H.mp4',                      'cusa_psa',   '1958302822853'),
    -- Sponsorship Spots (5)
    ('ENTR0001000H.mp4',                          'sponsor',    '2144366151881'),
    ('Huntsville_Space_30s.mp4',                  'sponsor',    '2142014235774'),
    ('QYAF9837000H_.mp4',                         'sponsor',    '2134166351746'),
    ('QYAF9906000H_15.mp4',                       'sponsor',    '2134235140148'),
    ('QYAF9907000H_15.mp4',                       'sponsor',    '2134234499801')
)
insert into commercials (name, category, status, box_file_id, box_link, sports)
select
  s.name,
  s.category,
  'active',
  s.box_file_id,
  'https://conferenceusa.box.com/file/' || s.box_file_id,
  '{}'::text[]
from seed s
where not exists (
  select 1 from commercials c where c.box_file_id = s.box_file_id
);
