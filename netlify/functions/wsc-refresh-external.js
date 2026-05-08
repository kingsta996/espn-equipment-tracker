/**
 * wsc-refresh-external — pulls athletics-site schedules from public sources
 * and upserts them into wsc_external_events for the WSC Capture Portal.
 *
 * Sources:
 *   • Conference USA master calendar (Sidearm ICS feed at
 *     /calendar.ashx/calendar.ics). Single endpoint that lists every CUSA
 *     event across every sport — football, basketball, soccer, volleyball,
 *     baseball, softball, etc. Each game appears twice (once per school's
 *     POV) in the feed; we dedupe on date+home+away+sport.
 *   • Sam Houston Nuxt API (gobearkats.com /api/v2/schedule/<id>) for
 *     Soccer / Volleyball / Baseball / Softball — kept as a fallback /
 *     supplement to the conference calendar in case it lags.
 *
 * Invoked from the WSC portal's Settings tab (super-admin only) via
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

// CUSA membership + the aliases we observe in the conference calendar feed.
// Used to canonicalise team names and decide which side of a matchup is CUSA.
const CUSA_SCHOOLS = {
  'Delaware':         ['Delaware'],
  'FIU':              ['FIU', 'Florida International'],
  'Jacksonville State':['Jacksonville State', 'Jax State', 'Jacksonville St.'],
  'Kennesaw State':   ['Kennesaw State', 'Kennesaw St.'],
  'Liberty':          ['Liberty'],
  'Louisiana Tech':   ['Louisiana Tech', 'LA Tech', 'LaTech'],
  'Middle Tennessee': ['Middle Tennessee', 'MTSU', 'Middle Tenn.'],
  'Missouri State':   ['Missouri State', 'Missouri St.'],
  'New Mexico State': ['New Mexico State', 'NM State', 'NMSU', 'New Mexico St.'],
  'Sam Houston':      ['Sam Houston', 'Sam Houston State', 'SHSU'],
  'UTEP':             ['UTEP', 'Texas El Paso'],
  'Western Kentucky': ['Western Kentucky', 'WKU', 'Western Ky.']
};
const ALIAS_MAP = (() => {
  const m = new Map();
  for (const [canon, aliases] of Object.entries(CUSA_SCHOOLS)) {
    m.set(canon.toLowerCase().trim(), canon);
    for (const a of aliases) m.set(a.toLowerCase().trim(), canon);
  }
  return m;
})();
function canonicalSchool(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().trim();
  if (ALIAS_MAP.has(k)) return ALIAS_MAP.get(k);
  return null;
}

// Sports we route to Master / Manual. Sport detection runs longest-prefix-first.
const SPORT_PATTERNS = [
  { re: /^Football\b/,            sport: 'Football' },
  { re: /^Men's Basketball\b/,    sport: "Men's Basketball" },
  { re: /^Women's Basketball\b/,  sport: "Women's Basketball" },
  { re: /^Men's Soccer\b/,        sport: "Men's Soccer" },
  { re: /^Women's Soccer\b/,      sport: "Women's Soccer" },
  { re: /^Soccer\b/,              sport: 'Soccer' },
  { re: /^Men's Volleyball\b/,    sport: "Men's Volleyball" },
  { re: /^Women's Volleyball\b/,  sport: "Women's Volleyball" },
  { re: /^Volleyball\b/,          sport: 'Volleyball' },
  { re: /^Baseball\b/,            sport: 'Baseball' },
  { re: /^Softball\b/,            sport: 'Softball' }
];

const SHSU_NON_BB_SPORTS = new Set(['Soccer', "Men's Soccer", "Women's Soccer", 'Volleyball', "Men's Volleyball", "Women's Volleyball", 'Baseball', 'Softball']);

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

/* ─────────────────────────────────────────────────────────────────────
 *  Conference USA master calendar (Sidearm ICS).
 * ─────────────────────────────────────────────────────────────────── */

function utcToEt(isoDate, hhmm) {
  // hhmm = 'HHMM' UTC. Returns 'h:mm AM/PM ET' in observed Eastern time.
  if (!isoDate || !hhmm) return '';
  const utc = new Date(`${isoDate}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00Z`);
  if (Number.isNaN(utc.getTime())) return '';
  // DST window roughly Mar 14 → Nov 7 (good enough for game schedules; ICAL also
  // emits floating UTC so this approximation is appropriate).
  const m = utc.getUTCMonth() + 1, d = utc.getUTCDate();
  const inDst = (m > 3 && m < 11) || (m === 3 && d >= 14) || (m === 11 && d < 7);
  const offset = inDst ? -4 : -5;
  const et = new Date(utc.getTime() + offset * 3_600_000);
  const h = et.getUTCHours();
  const mm = et.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(mm).padStart(2,'0')} ${ampm} ET`;
}

function parseSummary(summary) {
  // Strip outcome and cancellation prefixes.
  let s = summary.replace(/^\[[WL]\]\s*/, '').trim();
  if (/^(CANCELLED|Postponed)/i.test(s)) return null;
  // Identify the sport prefix.
  let sport = null, rest = s;
  for (const p of SPORT_PATTERNS) {
    const m = s.match(p.re);
    if (m) { sport = p.sport; rest = s.slice(m[0].length).trim(); break; }
  }
  if (!sport) return null;
  // Parse "TeamA at TeamB" or "TeamA vs TeamB". Strip trailing whitespace
  // (the feed often has double-spaces like "Liberty vs  Duke").
  const m = rest.match(/^(.+?)\s+(at|vs\.?)\s+(.+?)\s*$/i);
  if (!m) return null;
  const [, a, sep, b] = m;
  const isAt = /^at$/i.test(sep);
  const home = (isAt ? b : a).replace(/\s+/g, ' ').trim();
  const away = (isAt ? a : b).replace(/\s+/g, ' ').trim();
  return { sport, home, away };
}

function parseIcs(text) {
  const out = [];
  // Split by VEVENT then peel each block.
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  for (const blk of blocks) {
    // ICS folds long lines with CRLF + space — unfold.
    const unfolded = blk.replace(/\r?\n[ \t]/g, '');
    const get = (key) => {
      const re = new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, 'm');
      const mm = unfolded.match(re);
      return mm ? mm[1].trim() : '';
    };
    const dt  = get('DTSTART');
    const sum = get('SUMMARY');
    const loc = get('LOCATION').replace(/\\,/g, ',').replace(/\\n/g, ' ');
    if (!dt || !sum) continue;
    const date = `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}`;
    const time = dt.slice(9, 13);
    const parsed = parseSummary(sum);
    if (!parsed) continue;
    out.push({ date, time, summary: sum, location: loc, ...parsed });
  }
  return out;
}

async function cusaCalendarRefresh() {
  const res = await fetch('https://conferenceusa.com/calendar.ashx/calendar.ics', FETCH_OPTS);
  if (!res.ok) throw new Error(`CUSA calendar fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const events = parseIcs(text);

  // Convert to wsc_external_events rows. Filter rules:
  //   • At least one team must be a CUSA school.
  //   • Football + Men's/Women's Basketball: include any matchup involving a CUSA school.
  //   • Soccer / Volleyball / Baseball / Softball: include only if Sam Houston is involved
  //     (per spec — those non-football/basketball sports are SHSU-only for WSC).
  const rows = [];
  const seen = new Set();
  for (const ev of events) {
    const homeC = canonicalSchool(ev.home);
    const awayC = canonicalSchool(ev.away);
    if (!homeC && !awayC) continue;
    const isFootball   = ev.sport === 'Football';
    const isBasketball = ev.sport === "Men's Basketball" || ev.sport === "Women's Basketball";
    const isShsuSport  = SHSU_NON_BB_SPORTS.has(ev.sport);
    const cusa = homeC || awayC; // primary CUSA school for this row
    let school = cusa;
    if (isShsuSport) {
      const hasShsu = homeC === 'Sam Houston' || awayC === 'Sam Houston';
      if (!hasShsu) continue;
      school = 'Sam Houston';
    } else if (!isFootball && !isBasketball) {
      // Drop sports we don't route (Tennis, Bowling, Track, etc.).
      continue;
    } else {
      // Prefer the home CUSA school as the row owner; otherwise use the away CUSA team.
      school = homeC || awayC;
    }
    const home = homeC || ev.home;
    const away = awayC || ev.away;
    const key = `${ev.date}|${home.toLowerCase()}|${away.toLowerCase()}|${ev.sport}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const conference = (homeC && awayC) ? 'Conference USA' : 'Non-Conference';
    const id = `cusa-${ev.sport.replace(/[^a-z0-9]+/gi, '').toLowerCase()}-${ev.date}-${slugify(away)}-at-${slugify(home)}`;
    rows.push({
      id, source: 'cusa-calendar',
      school, sport: ev.sport,
      event_date: ev.date,
      event_time: utcToEt(ev.date, ev.time),
      home, away,
      conference,
      network: '',
      notes: ev.location || ''
    });
  }
  return { rows, errors: [] };
}

/* ─────────────────────────────────────────────────────────────────────
 *  Sam Houston Nuxt API (supplement to the conference calendar for SHSU).
 * ─────────────────────────────────────────────────────────────────── */

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
    // 1) Conference USA master calendar (primary source, all sports).
    try {
      const cusa = await cusaCalendarRefresh();
      const up = await upsertRows(cusa.rows);
      summary.sources.push({ source: 'cusa-calendar', rows: cusa.rows.length, upserted: up.inserted });
      summary.totalRows += up.inserted;
      summary.errors.push(...cusa.errors);
    } catch (e) {
      summary.errors.push({ source: 'cusa-calendar', error: e.message || String(e) });
    }

    // 2) Sam Houston Nuxt API (supplement; conference calendar typically covers
    //    these but SHSU's own site can have the full schedule earlier).
    try {
      const shsu = await shsuRefresh();
      const up = await upsertRows(shsu.rows);
      summary.sources.push({ source: 'shsu-api', rows: shsu.rows.length, upserted: up.inserted });
      summary.totalRows += up.inserted;
      summary.errors.push(...shsu.errors);
    } catch (e) {
      summary.errors.push({ source: 'shsu-api', error: e.message || String(e) });
    }

    summary.elapsed_ms = Date.now() - t0;
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  } catch (e) {
    summary.errors.push({ stage: 'top-level', error: e.message || String(e) });
    summary.elapsed_ms = Date.now() - t0;
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  }
};
