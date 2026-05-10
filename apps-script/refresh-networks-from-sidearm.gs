/**
 * Daily TV-network refresh from each school's SideArm site.
 *
 * The per-school sheets pull schedules via IMPORTHTML against SideArm's
 * /text view, which is server-rendered but doesn't expose TV info.
 * The default /schedule view DOES expose TV, but it's hydrated from
 * a JSON payload (window.__NUXT_DATA__) so IMPORTHTML can't see it.
 *
 * This script bridges the gap: fetch each school's full /schedule page,
 * extract the JSON, join games by date + opponent, and write the TV
 * value into the Network column on the school's normalized data tab.
 *
 * The portal-side override (wsc_event_network_overrides) still wins on
 * display — this just provides smarter defaults so most rows are
 * already-populated by the time a super admin opens the WSC portal.
 *
 * Run manually first via `refreshNetworksFromSideArm` to verify it works,
 * then call `installDailyTrigger` once to schedule it overnight.
 *
 * Setup:
 *   1. Open the master sheet, Extensions → Apps Script.
 *   2. Add this file alongside add-network-column.gs (you can have both
 *      in the same Apps Script project).
 *   3. Run `addNetworkColumnToAllSheets` ONCE first (from the other
 *      script) so each sheet has a Network column to write into.
 *   4. Run `refreshNetworksFromSideArm` to do an initial pull. Check the
 *      execution log — it'll list each school + sport + how many rows
 *      were matched.
 *   5. Run `installDailyTrigger` once to schedule a 5 AM ET daily run.
 */

const TV_SCHOOLS = [
  // path-slug guesses are SideArm conventions. If a school 404s on a sport
  // path, the log will say which URL failed — patch it here.
  {
    id: '1B-1wfDdEXjbsWp70WfGnZLY8E9kBvNxKK7GPVAUACio',
    name: 'Delaware',
    paths: {
      'Football':            'https://bluehens.com/sports/football/schedule',
      "Men's Basketball":    'https://bluehens.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://bluehens.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1cvft9c_elDAufTSyDcj1vEWOzQn0L7fBbf7NCIeTaVo',
    name: 'Jacksonville State',
    paths: {
      'Football':            'https://jaxstatesports.com/sports/football/schedule',
      "Men's Basketball":    'https://jaxstatesports.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://jaxstatesports.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1hWXpI7lPgbOKipkwETmDZqnZQIlo5webaSPs9xS3Kxw',
    name: 'FIU',
    paths: {
      'Football':            'https://fiusports.com/sports/football/schedule',
      "Men's Basketball":    'https://fiusports.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://fiusports.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1LcsFfQuhLJFl2hohVZWDZ0zpf-7jz3zgWm9-6wjKxfs',
    name: 'Louisiana Tech',
    paths: {
      'Football':            'https://latechsports.com/sports/football/schedule',
      "Men's Basketball":    'https://latechsports.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://latechsports.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1cBLvWCdzw9ybjYuK3yhZsb22ZT9r2Sn2VVacxfkNcNA',
    name: 'Liberty',
    paths: {
      'Football':            'https://libertyflames.com/sports/football/schedule',
      "Men's Basketball":    'https://libertyflames.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://libertyflames.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1eS2CuDG-drsMi004uJgejds46i7kU1yjvJ__BTNbO00',
    name: 'Middle Tennessee',
    paths: {
      'Football':            'https://goblueraiders.com/sports/football/schedule',
      "Men's Basketball":    'https://goblueraiders.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://goblueraiders.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1zbmOU0GccaSYg4jfsR_oHH-BkT2wmH5GkfW1-NsrXI8',
    name: 'Missouri State',
    paths: {
      'Football':            'https://missouristatebears.com/sports/football/schedule',
      "Men's Basketball":    'https://missouristatebears.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://missouristatebears.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1d_qlMPCIlOjx00XfS4FmS5cVm9ytnhyC7UWkYHk0EQo',
    name: 'Kennesaw State',
    paths: {
      'Football':            'https://ksuowls.com/sports/football/schedule',
      "Men's Basketball":    'https://ksuowls.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://ksuowls.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1NSQBtprFg0mWvl4S_lgVasuB8-ZA-bz9xdQ1K8Tq15w',
    name: 'New Mexico State',
    paths: {
      'Football':            'https://nmstatesports.com/sports/football/schedule',
      "Men's Basketball":    'https://nmstatesports.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://nmstatesports.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '16i3kq-jyu_QmyvwrUKBF_Ok0fOFiDXwFifLStPpFnw0',
    name: 'Sam Houston',
    paths: {
      'Football':            'https://gobearkats.com/sports/football/schedule',
      "Men's Basketball":    'https://gobearkats.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://gobearkats.com/sports/womens-basketball/schedule'
    }
  },
  {
    id: '1qZWk0ZCe3eoesOwAYj8k5DfuaoMidJAQXjBhD9ehhuU',
    name: 'Western Kentucky',
    paths: {
      'Football':            'https://wkusports.com/sports/football/schedule',
      "Men's Basketball":    'https://wkusports.com/sports/mens-basketball/schedule',
      "Women's Basketball":  'https://wkusports.com/sports/womens-basketball/schedule'
    }
  }
];

const REQUIRED_HEADERS_TV = ['Date', 'Time', 'At', 'Opponent', 'Sport'];

// ─── Top-level entry points ──────────────────────────────────────────────

function refreshNetworksFromSideArm() {
  const summary = [];
  TV_SCHOOLS.forEach(school => {
    try {
      Logger.log(`\n=== ${school.name} (${school.id}) ===`);
      const ss  = SpreadsheetApp.openById(school.id);
      const tab = findDataTabTV_(ss);
      if (!tab) { Logger.log(`  no data tab matching standard schema — skipped`); return; }

      const data = tab.getDataRange().getValues();
      if (data.length < 2) { Logger.log(`  empty tab — skipped`); return; }

      const headers = data[0].map(v => String(v || '').trim());
      const idx = name => headers.indexOf(name);
      const cDate = idx('Date'), cOppo = idx('Opponent'), cSport = idx('Sport'), cAt = idx('At');
      let   cNet  = idx('Network');

      // Add Network header at the rightmost position if missing.
      if (cNet < 0) {
        cNet = headers.length;
        tab.getRange(1, cNet + 1).setValue('Network');
        Logger.log(`  added Network column at col ${cNet + 1}`);
      }

      // Fetch one TV lookup per sport that appears in this sheet AND has
      // a configured SideArm URL.
      const sportTV = {};
      Object.keys(school.paths).forEach(sport => {
        try {
          const url = school.paths[sport];
          const games = fetchSideArmGames_(url);
          sportTV[sport] = games;
          Logger.log(`  ${sport}: fetched ${games.length} games from ${url}`);
        } catch (e) {
          Logger.log(`  ${sport}: fetch failed — ${e.message}`);
          sportTV[sport] = [];
        }
      });

      // Walk the sheet; for each row, look up TV.
      let matched = 0, missed = 0;
      const writes = [];
      for (let r = 1; r < data.length; r++) {
        const row = data[r];
        const sport = String(row[cSport] || '').trim();
        if (!sport) continue;
        const games = sportTV[sport];
        if (!games || !games.length) continue;
        const tv = matchTV_(games, row[cDate], row[cOppo]);
        if (tv) {
          writes.push({ row: r + 1, value: tv });
          matched++;
        } else {
          missed++;
        }
      }

      // Batch the writes to minimize quota spend.
      writes.forEach(w => tab.getRange(w.row, cNet + 1).setValue(w.value));
      Logger.log(`  → wrote TV for ${matched} rows · ${missed} unmatched`);
      summary.push(`${school.name}: ${matched} matched`);
    } catch (e) {
      Logger.log(`  ERROR: ${e.message}`);
      summary.push(`${school.name}: ERROR ${e.message}`);
    }
  });
  Logger.log('\n=== Summary ===\n' + summary.join('\n'));
}

function installDailyTrigger() {
  // Remove any existing triggers for this function so we don't stack.
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'refreshNetworksFromSideArm') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshNetworksFromSideArm')
    .timeBased()
    .atHour(5)         // 5 AM in the project's timezone
    .everyDays(1)
    .create();
  Logger.log('Daily trigger installed for refreshNetworksFromSideArm at ~5 AM.');
}

function uninstallDailyTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'refreshNetworksFromSideArm') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log(`Removed ${removed} trigger(s).`);
}


// ─── Helpers ─────────────────────────────────────────────────────────────

function findDataTabTV_(ss) {
  for (const sh of ss.getSheets()) {
    const lastCol = sh.getLastColumn();
    if (lastCol < REQUIRED_HEADERS_TV.length) continue;
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(v => String(v || '').trim());
    if (REQUIRED_HEADERS_TV.every(h => headers.indexOf(h) >= 0)) return sh;
  }
  return null;
}

/** Fetch a SideArm /schedule page, parse __NUXT_DATA__, return [{date_iso, opponent, tv}, ...]. */
function fetchSideArmGames_(url) {
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'CUSA-WSC-Refresh/1.0' }
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('HTTP ' + res.getResponseCode() + ' fetching ' + url);
  }
  const html = res.getContentText();
  const m = html.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NUXT_DATA__ payload');
  const data = JSON.parse(m[1]);

  function deep(v, seen) {
    seen = seen || {};
    while (typeof v === 'number' && v >= 0 && v < data.length && !seen[v]) {
      seen[v] = true;
      v = data[v];
    }
    if (Array.isArray(v)) return v.map(x => deep(x, seen));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = deep(v[k], seen);
      return out;
    }
    return v;
  }

  // Game-shaped node = dict with both 'date' and 'opponent' keys.
  const games = [];
  for (let i = 0; i < data.length; i++) {
    const n = data[i];
    if (n && typeof n === 'object' && !Array.isArray(n) && 'date' in n && 'opponent' in n) {
      const g = deep(n);
      // tv lives inside g.media.tv, plus g.opponent.title, g.date.start_date
      const tv = (g && g.media && g.media.tv) || g.tv || null;
      let oppo = null;
      if (g.opponent && typeof g.opponent === 'object') {
        oppo = g.opponent.title || g.opponent.name || g.opponent.display_name || null;
      } else if (typeof g.opponent === 'string') {
        oppo = g.opponent;
      }
      let dateIso = null;
      if (typeof g.date === 'string') dateIso = g.date.slice(0, 10);
      else if (g.date && typeof g.date === 'object') {
        dateIso = (g.date.start_date || g.date.iso || '').slice(0, 10) || null;
      }
      games.push({ date_iso: dateIso, opponent: oppo, tv });
    }
  }
  return games;
}

/** Match a sheet row's date+opponent against the SideArm games list. */
function matchTV_(games, sheetDate, sheetOppo) {
  const sheetIso  = parseSheetDate_(sheetDate);
  const oppoNorm  = normalizeOppo_(sheetOppo);
  if (!sheetIso || !oppoNorm) return null;
  for (const g of games) {
    if (!g.tv) continue;
    if (g.date_iso !== sheetIso) continue;
    const cand = normalizeOppo_(g.opponent);
    if (!cand) continue;
    if (cand === oppoNorm || cand.indexOf(oppoNorm) >= 0 || oppoNorm.indexOf(cand) >= 0) {
      return g.tv;
    }
  }
  return null;
}

/** Sheet dates look like "Sep 12 (Sat)" or "Sep 12" or a Date object. Returns ISO YYYY-MM-DD. */
function parseSheetDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'America/New_York', 'yyyy-MM-dd');
  }
  const s = String(v || '').trim();
  if (!s) return null;
  // Already an ISO date?
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // "Sep 12 (Sat)" or "Sep 12"
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})/);
  if (!m) return null;
  const months = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Sept:9, Oct:10, Nov:11, Dec:12 };
  const mo = months[m[1].slice(0,3)];
  if (!mo) return null;
  const day = Number(m[2]);
  // Year inference: month >= 8 → current calendar year (Fall season),
  // else next calendar year (Winter/Spring continuing the athletic year).
  const today = new Date();
  let year = today.getFullYear();
  if (mo < 6 && today.getMonth() >= 6) year += 1;
  if (mo >= 8 && today.getMonth() < 6) year -= 1;
  return `${year}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function normalizeOppo_(v) {
  if (v == null) return '';
  return String(v).toLowerCase()
    .replace(/\(exhibition\)/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
