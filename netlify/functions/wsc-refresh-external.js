/**
 * wsc-refresh-external — pulls per-school athletics-site schedules and
 * upserts them into wsc_external_events for the WSC Capture Portal.
 *
 * Sources currently implemented:
 *   • Sam Houston (Nuxt at gobearkats.com) — Soccer / Volleyball /
 *     Baseball / Softball. Discovers the current scheduleId via
 *     /api/v2/sports/ then pulls /api/v2/schedule/<id>.
 *
 * TODO (per user request): per-school Football + Basketball scrapers
 * for the other 10 CUSA schools. Each school is on a different CMS
 * (some Sidearm classic, some Nuxt, some custom), so each gets its
 * own adapter as we discover what's accessible.
 *
 * Invoked by the WSC portal's Settings tab (super-admin only) via
 *   POST /.netlify/functions/wsc-refresh-external
 *
 * The function accepts the Supabase service-role key over env so it can
 * write through RLS. With the public RLS policy on wsc_external_events
 * the anon key would also work; the service-role variant is here in case
 * we ever lock the policy down.
 */

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

// Map SHSU's globalSportShortName → our canonical sport label.
const SHSU_SPORT_MAP = {
  wsoc:    "Soccer",
  wvball:  "Volleyball",
  baseball: "Baseball",
  softball: "Softball"
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const FETCH_OPTS = {
  headers: { 'User-Agent': 'CUSA-WSC-Portal/1.0 (Netlify Function)' }
};

async function getJson(url) {
  const res = await fetch(url, FETCH_OPTS);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Pull one SHSU sport schedule. Returns an array of event rows. */
async function shsuScrape(scheduleId, sportLabel) {
  const data = await getJson(`https://gobearkats.com/api/v2/schedule/${scheduleId}`);
  const games = data.games || [];
  return games.map(ev => {
    const opp   = (ev.opponent && ev.opponent.title) || '';
    const atVs  = String(ev.atVs || '').toLowerCase();
    const date  = (ev.date || '').slice(0, 10);
    const time  = ev.time || '';
    if (!date || !opp) return null;
    const home = atVs === 'at' ? opp : 'Sam Houston';
    const away = atVs === 'at' ? 'Sam Houston' : opp;
    const id = `shsu-${slugify(sportLabel)}-${date}-${slugify(opp)}`;
    return {
      id, source: 'shsu-api', school: 'Sam Houston',
      sport: sportLabel, event_date: date, event_time: time,
      home, away,
      conference: ev.conference ? 'Conference USA' : 'Non-Conference',
      network: '', notes: ev.location || ''
    };
  }).filter(Boolean);
}

/** Look up SHSU schedule IDs from /api/v2/sports/. */
async function shsuRefresh() {
  const sports = await getJson('https://gobearkats.com/api/v2/sports/');
  const out = [];
  const errors = [];
  for (const s of sports) {
    const short = (s.globalSportShortName || '').toLowerCase();
    const label = SHSU_SPORT_MAP[short];
    if (!label || !s.scheduleId) continue;
    try {
      const rows = await shsuScrape(s.scheduleId, label);
      out.push(...rows);
    } catch (e) {
      errors.push({ source: 'shsu', sport: label, error: e.message || String(e) });
    }
  }
  return { rows: out, errors };
}

async function upsertRows(rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase env not configured (need SUPABASE_URL + SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY)');
  }
  if (!rows.length) return { inserted: 0 };
  // Direct REST upsert — keeps the function dependency-free.
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
    // SHSU
    try {
      const shsu = await shsuRefresh();
      const up = await upsertRows(shsu.rows);
      summary.sources.push({ source: 'shsu-api', rows: shsu.rows.length, upserted: up.inserted });
      summary.totalRows += up.inserted;
      summary.errors.push(...shsu.errors);
    } catch (e) {
      summary.errors.push({ source: 'shsu-api', error: e.message || String(e) });
    }

    // TODO: per-school Football + Basketball scrapers go here. Each will
    // emit rows with school=<canonical>, sport='Football' | "Men's Basketball" | "Women's Basketball".
    summary.pending = ['football-per-school', 'basketball-per-school'];

    summary.elapsed_ms = Date.now() - t0;
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  } catch (e) {
    summary.errors.push({ stage: 'top-level', error: e.message || String(e) });
    summary.elapsed_ms = Date.now() - t0;
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  }
};
