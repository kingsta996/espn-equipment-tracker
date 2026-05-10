/**
 * Adds a "Network" column header to the data tab of each per-school
 * schedule spreadsheet AND the master "Master Schedule" tab.
 *
 * Idempotent — re-running on a sheet that already has the column is a no-op.
 *
 * After running:
 *   1. Editors can fill in the new Network column on each per-school sheet.
 *   2. The Master Schedule's IMPORTRANGE / QUERY formula needs to be widened
 *      to include the new column (one cell edit — see notes printed by this
 *      script in the Apps Script execution log).
 *   3. wsc-refresh-external.js (in the espn-equipment-tracker repo) already
 *      reads the Network column when present, so once the sheet pipeline
 *      flows it, the WSC portal picks it up on the next "Refresh External
 *      Schedules" click.
 *
 * To run:
 *   1. Open the master sheet:
 *      https://docs.google.com/spreadsheets/d/1FyknP3xzkfHNAfzXo7gsqgQ5D84K7iUNl5sq-ecYs04/edit
 *   2. Extensions → Apps Script. Paste this entire file (replace whatever's
 *      there in a new project).
 *   3. Top toolbar: select function `addNetworkColumnToAllSheets`.
 *   4. Click Run. Approve the Drive + Sheets permissions on first run.
 *   5. View → Logs to see what was added / skipped per sheet.
 */

const SCHOOL_SHEETS = [
  { id: '1B-1wfDdEXjbsWp70WfGnZLY8E9kBvNxKK7GPVAUACio', name: 'Delaware' },
  { id: '1cvft9c_elDAufTSyDcj1vEWOzQn0L7fBbf7NCIeTaVo', name: 'Jacksonville State' },
  { id: '1hWXpI7lPgbOKipkwETmDZqnZQIlo5webaSPs9xS3Kxw', name: 'FIU' },
  { id: '1LcsFfQuhLJFl2hohVZWDZ0zpf-7jz3zgWm9-6wjKxfs', name: 'Louisiana Tech' },
  { id: '1cBLvWCdzw9ybjYuK3yhZsb22ZT9r2Sn2VVacxfkNcNA', name: 'Liberty' },
  { id: '1eS2CuDG-drsMi004uJgejds46i7kU1yjvJ__BTNbO00', name: 'Middle Tennessee' },
  { id: '1zbmOU0GccaSYg4jfsR_oHH-BkT2wmH5GkfW1-NsrXI8', name: 'Missouri State' },
  { id: '1d_qlMPCIlOjx00XfS4FmS5cVm9ytnhyC7UWkYHk0EQo', name: 'Kennesaw State' },
  { id: '1NSQBtprFg0mWvl4S_lgVasuB8-ZA-bz9xdQ1K8Tq15w', name: 'New Mexico State' },
  { id: '16i3kq-jyu_QmyvwrUKBF_Ok0fOFiDXwFifLStPpFnw0', name: 'Sam Houston' },
  { id: '1qZWk0ZCe3eoesOwAYj8k5DfuaoMidJAQXjBhD9ehhuU', name: 'Western Kentucky' },
  // UTEP not in the shared folder yet — add its spreadsheet ID here when ready.
];

const MASTER_SHEET_ID  = '1FyknP3xzkfHNAfzXo7gsqgQ5D84K7iUNl5sq-ecYs04';
const MASTER_TAB_NAME  = 'Master Schedule';
const REQUIRED_HEADERS = ['Date', 'Day', 'Time', 'At', 'Opponent', 'Code'];

function addNetworkColumnToAllSheets() {
  Logger.log('=== Per-school sheets ===');
  SCHOOL_SHEETS.forEach(s => {
    try {
      const ss = SpreadsheetApp.openById(s.id);
      const tab = findDataTab_(ss);
      if (!tab) {
        Logger.log(`${s.name}: no data tab matching the standard schema`);
        return;
      }
      const result = addNetworkHeader_(tab);
      Logger.log(`${s.name} [${tab.getName()}]: ${result}`);
    } catch (e) {
      Logger.log(`${s.name}: ERROR — ${e.message}`);
    }
  });

  Logger.log('');
  Logger.log('=== Master sheet ===');
  try {
    const ss = SpreadsheetApp.openById(MASTER_SHEET_ID);
    const tab = ss.getSheetByName(MASTER_TAB_NAME);
    if (!tab) {
      Logger.log(`Master: no "${MASTER_TAB_NAME}" tab`);
    } else {
      const result = addNetworkHeader_(tab);
      Logger.log(`Master [${MASTER_TAB_NAME}]: ${result}`);
    }
  } catch (e) {
    Logger.log(`Master: ERROR — ${e.message}`);
  }

  Logger.log('');
  Logger.log('=== Manual follow-up ===');
  Logger.log('If the Master Schedule tab pulls from each school via IMPORTRANGE / QUERY,');
  Logger.log('widen the column range in that formula to include the new Network column.');
  Logger.log('Common patterns:');
  Logger.log('  IMPORTRANGE("...", "Schedule!A:M")  →  IMPORTRANGE("...", "Schedule!A:N")');
  Logger.log('  QUERY({...}, "select Col1, Col2, ..., Col13", 1)  →  add Col14 (Network)');
  Logger.log('Once the formula carries Network through, the WSC portal Settings → Refresh');
  Logger.log('External Schedules button will pull network values into wsc_external_events.');
}

/** Find the tab whose row 1 contains the standard schedule headers. */
function findDataTab_(ss) {
  const sheets = ss.getSheets();
  for (const sh of sheets) {
    const lastCol = sh.getLastColumn();
    if (lastCol < REQUIRED_HEADERS.length) continue;
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(v => String(v || '').trim());
    const has = REQUIRED_HEADERS.every(h => headers.indexOf(h) >= 0);
    if (has) return sh;
  }
  return null;
}

/** Add a "Network" header at the rightmost position. Idempotent. */
function addNetworkHeader_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(v => String(v || '').trim());
  const existingIdx = headers.indexOf('Network');
  if (existingIdx >= 0) {
    return `Network already at column ${existingIdx + 1} — skipped.`;
  }
  const targetCol = lastCol + 1;
  sheet.getRange(1, targetCol).setValue('Network');
  // Light formatting so it visually matches the rest of the header row.
  try {
    const headerRow1Style = sheet.getRange(1, lastCol);
    sheet.getRange(1, targetCol).setFontWeight(headerRow1Style.getFontWeight() || 'bold');
    sheet.getRange(1, targetCol).setHorizontalAlignment(headerRow1Style.getHorizontalAlignment() || 'center');
  } catch (_) { /* style copy is best-effort */ }
  return `added Network at column ${targetCol}`;
}
