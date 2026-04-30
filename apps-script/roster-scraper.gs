/**
 * CUSA Roster Scraper — Google Apps Script web app (FALLBACK ONLY)
 *
 * Bound to: https://docs.google.com/spreadsheets/d/1X4-oSmZ6fnJ2kM-JousLXy7GvVma62kXJflHXPgYI24
 *
 * Status: roster.html now uses a CORS proxy by default. This script is kept
 * as an opt-in backup for the rare case a school's site blocks the proxy.
 * To activate per browser, run in DevTools console:
 *     localStorage.setItem('cusa_roster_use_apps_script', 'true');
 *     localStorage.setItem('cusa_roster_scraper_url', '<DEPLOY URL>');
 *
 * Purpose: same as the in-browser parser — runs IMPORTHTML against the URL,
 * scans candidate table numbers, returns the first table whose headers
 * contain '#' and 'Full Name' (or 'Name' / 'Player').
 *
 * ── Deploy (one-time) ─────────────────────────────────────────────────────
 *   1. Open the sheet → Extensions → Apps Script
 *   2. Replace any existing code with the contents of this file
 *   3. Click Save (disk icon)
 *   4. Click Deploy → New deployment
 *   5. Type: Web app
 *   6. Description: "CUSA Roster Scraper"
 *   7. Execute as: Me (your Google account)
 *   8. Who has access: Anyone
 *   9. Click Deploy. Authorize when prompted.
 *  10. Copy the "Web app" URL — that's the value you paste into roster.html
 *      the first time you click "Pull from URL". It's saved in localStorage.
 *
 * ── Re-deploy after edits ─────────────────────────────────────────────────
 *   Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy
 *   (the URL stays the same — no need to update roster.html).
 */

const SCRATCH_SHEET = 'Scraper';
// Tables 3 first because that's the most common spot, then 1/2/4/5...
const TABLE_ORDER = [3, 1, 2, 4, 5, 6, 7, 8, 9, 10];
// How long to wait for IMPORTHTML to evaluate. 2.5s is enough for most sites
// even on a cold cache. If a site is slow, the "no table found" branch will
// retry the next number — so under-waiting just means a longer total time.
const SETTLE_MS = 2500;

function doGet(e) {
  try {
    const url = ((e && e.parameter && e.parameter.url) || '').trim();
    if (!url) return jsonError('Missing url parameter');
    if (!/^https?:\/\//i.test(url)) return jsonError('URL must start with http:// or https://');

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let scratch = ss.getSheetByName(SCRATCH_SHEET);
    if (!scratch) scratch = ss.insertSheet(SCRATCH_SHEET);

    let lastError = '';
    for (const i of TABLE_ORDER) {
      // Reset and load this table number into A1
      scratch.clearContents();
      const safeUrl = url.replace(/"/g, '""');
      scratch.getRange('A1').setFormula('=IMPORTHTML("' + safeUrl + '","table",' + i + ')');
      SpreadsheetApp.flush();
      Utilities.sleep(SETTLE_MS);

      const range = scratch.getDataRange();
      const data = range.getValues();
      if (!data.length || !data[0] || !data[0].length) continue;

      // IMPORTHTML returns "#ERROR!" / "#N/A" in A1 when the table doesn't exist
      const firstCell = String(data[0][0] || '').trim();
      if (firstCell.indexOf('#ERROR') === 0 || firstCell.indexOf('#N/A') === 0 ||
          firstCell.toLowerCase().indexOf('error') === 0) {
        lastError = firstCell;
        continue;
      }

      const headers = data[0].map(function(h) { return String(h || '').trim(); });
      const lower   = headers.map(function(h) { return h.toLowerCase(); });
      const hasNum  = lower.indexOf('#') !== -1 || lower.indexOf('no.') !== -1 || lower.indexOf('jersey') !== -1;
      const hasName = lower.some(function(h) {
        return h === 'full name' || h === 'name' || h === 'player' || h === 'player name';
      });
      if (hasNum && hasName) {
        return jsonOk({
          headers: headers,
          rows: data.slice(1).filter(function(r) {
            // Skip wholly-empty rows (IMPORTHTML sometimes pads)
            return r.some(function(c) { return String(c || '').trim() !== ''; });
          }),
          tableNum: i,
          sourceUrl: url
        });
      }
    }
    return jsonError('No table with "#" + "Full Name" headers found in tables ' +
                     TABLE_ORDER.join(',') + '. Last result: ' + (lastError || '(empty)'));
  } catch (err) {
    return jsonError('Scraper error: ' + (err && err.message ? err.message : String(err)));
  }
}

function jsonOk(payload) {
  payload.ok = true;
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Self-test you can run inside the Apps Script editor: pick "test" → Run.
function test() {
  const r = doGet({ parameter: { url: 'https://fiusports.com/sports/baseball/roster' } });
  Logger.log(r.getContent().substring(0, 500));
}
