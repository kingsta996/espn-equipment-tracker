/**
 * wsc-refresh-external — pulls the conference Master Schedule (Google Sheet
 * shared with the Xpression Hub) and upserts events into wsc_external_events
 * for the WSC Capture Portal.
 *
 * Source:
 *   • Google Sheet "Master Schedule" tab — same sheet
 *     (id 1FyknP3xzkfHNAfzXo7gsqgQ5D84K7iUNl5sq-ecYs04) the Xpression Hub
 *     reads for its broadcast tooling. Exported as CSV via the gviz/tq
 *     endpoint. Sheet must be set to "Anyone with the link → Viewer".
 *
 * The sheet has an explicit "At" column (Home / Away), school "Code", and
 * Sport + Gender, so we don't have to parse summary strings the way an
 * ICS feed forces. School Code → canonical name lookup is hard-coded
 * below to match the canonical names in wsc_data.json.
 *
 * Invoked from the WSC portal's Settings tab (super-admin only) via
 *   POST /.netlify/functions/wsc-refresh-external
 */

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const FETCH_OPTS = {
  headers: { 'User-Agent': 'CUSA-WSC-Portal/1.0 (Netlify Function)' }
};

// Conference USA Master Schedule — same Google Sheet the Xpression Hub
// pulls from (schedule-master.html). Set to "Anyone with the link → Viewer".
const MASTER_SHEET_ID  = '1FyknP3xzkfHNAfzXo7gsqgQ5D84K7iUNl5sq-ecYs04';
const MASTER_SHEET_TAB = 'Master Schedule';

// First year of the athletic year the sheet's Fall season belongs to.
// 2026 → 2026-27 athletic year (Fall 2026, Winter 2026-27, Spring 2027).
// When the season rolls, bump this. Read from env if present.
const SCHEDULE_BASE_YEAR = Number(process.env.WSC_SCHEDULE_BASE_YEAR) || 2026;

// Code → canonical school name (matches wsc_data.json "canonical").
const CODE_TO_SCHOOL = {
  DEL:    'Delaware',
  FIU:    'FIU',
  JSU:    'Jacksonville State',
  KSU:    'Kennesaw State',
  LIB:    'Liberty',
  LTECH:  'Louisiana Tech',
  MOST:   'Missouri State',
  MTSU:   'Middle Tennessee',
  NMSU:   'New Mexico State',
  SHSU:   'Sam Houston',
  UTEP:   'UTEP',
  WKU:    'Western Kentucky'
};

// Sport + Gender → canonical sport label routed by the WSC portal.
function sportLabel(sport, gender) {
  const s = (sport || '').trim();
  const g = (gender || '').trim();
  if (s === 'Football')   return 'Football';
  if (s === 'Basketball') return g === "Women's" ? "Women's Basketball" : "Men's Basketball";
  if (s === 'Soccer')     return g === "Men's"   ? "Men's Soccer"       : "Women's Soccer";
  if (s === 'Volleyball') return g === "Men's"   ? "Men's Volleyball"   : 'Volleyball';
  if (s === 'Baseball')   return 'Baseball';
  if (s === 'Softball')   return 'Softball';
  return null;
}

// SHSU-only sports for Manual Capture (per WSC routing spec).
const SHSU_SPORTS = new Set(['Soccer', "Men's Soccer", "Women's Soccer", 'Volleyball', "Men's Volleyball", 'Baseball', 'Softball']);

const MONTHS = {
  Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7,
  Aug:8, Sep:9, Sept:9, Oct:10, Nov:11, Dec:12
};

/** "Sep 3" + season "Fall" → "2026-09-03". Returns null on parse failure. */
function deriveDate(dateStr, season, baseYear) {
  if (!dateStr) return null;
  const m = dateStr.match(/^([A-Za-z]+)\.?\s+(\d{1,2})/);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0,3)] || MONTHS[m[1]];
  if (!month) return null;
  const day = Number(m[2]);
  let year;
  switch ((season || '').trim()) {
    case 'Fall':   year = baseYear; break;
    case 'Spring': year = baseYear + 1; break;
    case 'Winter': year = month >= 8 ? baseYear : baseYear + 1; break;
    default:       year = month >= 8 ? baseYear : baseYear + 1; break;
  }
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Parser handles quoted fields, escaped quotes, and embedded commas/newlines.
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i+1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',')  { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function masterSheetRefresh() {
  const url = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(MASTER_SHEET_TAB)}`;
  const res = await fetch(url, FETCH_OPTS);
  if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
  const csv  = await res.text();
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('Sheet returned no rows');
  const hdr = rows[0];
  const idx = (name) => hdr.indexOf(name);
  const c = {
    date:    idx('Date'),
    time:    idx('Time'),
    at:      idx('At'),
    oppo:    idx('Opponent'),
    loc:     idx('Location'),
    sport:   idx('Sport'),
    gender:  idx('Gender'),
    season:  idx('Season'),
    code:    idx('Code'),
    school:  idx('School')
  };
  for (const k of Object.keys(c)) {
    if (c[k] < 0) throw new Error(`Sheet missing required column: ${k}`);
  }

  const out = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;
    const code = (r[c.code] || '').trim().toUpperCase();
    const school = CODE_TO_SCHOOL[code];
    if (!school) continue; // unknown / non-CUSA row
    const sport = sportLabel(r[c.sport], r[c.gender]);
    if (!sport) continue;
    // Routing-scope filter: keep football, basketball, and (Sam Houston only)
    // soccer/volleyball/baseball/softball.
    const isFB  = sport === 'Football';
    const isBB  = sport === "Men's Basketball" || sport === "Women's Basketball";
    const isOther = SHSU_SPORTS.has(sport);
    if (!isFB && !isBB && !(isOther && school === 'Sam Houston')) continue;

    const isoDate = deriveDate(r[c.date], r[c.season], SCHEDULE_BASE_YEAR);
    if (!isoDate) continue;
    const at = (r[c.at] || '').trim().toLowerCase();
    const oppo = (r[c.oppo] || '').trim();
    if (!oppo) continue;
    const home = at === 'home' ? school : oppo;
    const away = at === 'home' ? oppo   : school;

    // Each game appears twice in the sheet (once per CUSA participant when both
    // are conference teams). Dedup on date+home+away+sport.
    const key = `${isoDate}|${home.toLowerCase()}|${away.toLowerCase()}|${sport}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const otherIsCusa = Object.values(CODE_TO_SCHOOL).some(n =>
      n.toLowerCase() === oppo.toLowerCase() ||
      // Also try matching the full sheet-name (e.g. "University of Delaware")
      // via simple substring — rare for opponent column, but defensive.
      oppo.toLowerCase().includes(n.toLowerCase())
    );
    out.push({
      id: `master-${slugify(sport)}-${isoDate}-${slugify(away)}-at-${slugify(home)}`,
      source:     'master-sheet',
      school,
      sport,
      event_date: isoDate,
      event_time: (r[c.time] || '').trim(),
      home, away,
      conference: otherIsCusa ? 'Conference USA' : 'Non-Conference',
      network:    '',
      notes:      (r[c.loc] || '').trim()
    });
  }
  return { rows: out, errors: [] };
}

async function upsertRows(rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase env not configured (need SUPABASE_URL + SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY)');
  }
  if (!rows.length) return { inserted: 0 };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/wsc_external_events?on_conflict=id`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows.map(r => Object.assign({}, r, { refreshed_at: new Date().toISOString() })))
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upsert failed: HTTP ${res.status} ${text.slice(0, 240)}`);
  }
  return { inserted: rows.length };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')      return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  const t0 = Date.now();
  const summary = { sources: [], totalRows: 0, errors: [], elapsed_ms: 0 };

  try {
    const sheet = await masterSheetRefresh();
    const up = await upsertRows(sheet.rows);
    summary.sources.push({ source: 'master-sheet', rows: sheet.rows.length, upserted: up.inserted });
    summary.totalRows += up.inserted;
    summary.errors.push(...sheet.errors);
  } catch (e) {
    summary.errors.push({ source: 'master-sheet', error: e.message || String(e) });
  }

  summary.elapsed_ms = Date.now() - t0;
  const code = summary.errors.length && summary.totalRows === 0 ? 500 : 200;
  return { statusCode: code, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
};
