// Renders CUSA host-school roster pages with Playwright and writes the
// fully-rendered HTML to /headshot-cache/ so the browser-only headshots tool
// can fall back to it when a school's static HTML doesn't include player
// cards (i.e. the page is React-rendered).
//
// Modes:
//   - Default: render the host-school × sport matrix to
//       headshot-cache/{slug(school)}/{slug(sport)}.html
//   - With EXTRA_URLS env var: render only those URLs to
//       headshot-cache/_pulls/{sha1(url)}.html
//
// Card-selector list mirrors CARD_SELECTORS in headshots.html so the wait
// condition matches what the browser parser will look for.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HOST_SCHOOLS = {
  'Delaware':           'https://bluehens.com',
  'FIU':                'https://fiusports.com',
  'Jacksonville State': 'https://jaxstatesports.com',
  'Kennesaw State':     'https://ksuowls.com',
  'Liberty':            'https://libertyflames.com',
  'Middle Tennessee':   'https://goblueraiders.com',
  'Missouri State':     'https://missouristatebears.com',
  'New Mexico State':   'https://nmstatesports.com',
  'Sam Houston':        'https://gobearkats.com',
  'Western Kentucky':   'https://wkusports.com',
};

const SPORT_PATHS = {
  'Football':           'sports/football/roster',
  'Womens Soccer':      'sports/womens-soccer/roster',
  'Volleyball':         'sports/volleyball/roster',
  'Womens Track':       'sports/womens-track-and-field/roster',
  'Mens Track':         'sports/mens-track-and-field/roster',
  'Womens XC':          'sports/womens-cross-country/roster',
  'Mens XC':            'sports/mens-cross-country/roster',
  'Bowling':            'sports/bowling/roster',
  'Mens Golf':          'sports/mens-golf/roster',
  'Womens Golf':        'sports/womens-golf/roster',
  'Mens Basketball':    'sports/mens-basketball/roster',
  'Womens Basketball':  'sports/womens-basketball/roster',
  'Softball':           'sports/softball/roster',
  'Baseball':           'sports/baseball/roster',
  'Beach Volleyball':   'sports/beach-volleyball/roster',
};

const SCHOOL_OVERRIDES = {
  'Delaware': {
    'Womens Track': 'sports/track-and-field/roster',
    'Mens Track':   'sports/track-and-field/roster',
    'Womens XC':    'sports/cross-country/roster',
    'Mens XC':      'sports/cross-country/roster',
    'Bowling':      null,
    'Beach Volleyball': null,
  },
  'FIU': {
    'Beach Volleyball': 'sports/womens-beach-volleyball/roster',
    'Bowling':          null,
  },
  'Jacksonville State': { 'Beach Volleyball': null, 'Bowling': null },
  'Kennesaw State':     { 'Beach Volleyball': null, 'Bowling': null, 'Baseball': null, 'Softball': null },
  'Liberty':            { 'Beach Volleyball': null, 'Bowling': null },
  'Middle Tennessee':   { 'Beach Volleyball': null, 'Bowling': null },
  'Missouri State':     { 'Beach Volleyball': null, 'Bowling': null, 'Baseball': null },
  'New Mexico State':   { 'Beach Volleyball': null, 'Bowling': null },
  'Sam Houston':        { 'Beach Volleyball': null, 'Bowling': null },
  'Western Kentucky':   { 'Beach Volleyball': null, 'Bowling': 'sports/womens-bowling/roster' },
};

const CARD_SELECTORS = [
  '.s-person-card',
  '.roster-player',
  "[class*='person-card']",
  "[class*='roster-athlete']",
  '.roster__item',
  '.athlete-card',
  "li[class*='roster']",
];

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PLAYWRIGHT_TIMEOUT  = 45000;
const SELECTOR_TIMEOUT    = 8000;
const POLITE_DELAY_MS     = 750;

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sha1Hex(s) {
  return createHash('sha1').update(s).digest('hex');
}

function resolvePath(school, sport) {
  const overrides = SCHOOL_OVERRIDES[school] || {};
  if (sport in overrides) return overrides[sport];
  return SPORT_PATHS[sport] || null;
}

async function ensureDir(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function renderUrl(context, url) {
  const page = await context.newPage();
  let cardsFound = 0;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: PLAYWRIGHT_TIMEOUT });
    for (const sel of CARD_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: SELECTOR_TIMEOUT });
        cardsFound = await page.$$eval(sel, els => els.length);
        if (cardsFound > 0) break;
      } catch { /* try next selector */ }
    }
    const html = await page.content();
    return { html, cardsFound };
  } finally {
    await page.close();
  }
}

async function writeCacheFile(filePath, html) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, html, 'utf8');
}

async function main() {
  const extraUrls = (process.env.EXTRA_URLS || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && /^https?:\/\//i.test(s));

  console.log(`Headshot cache renderer`);
  console.log(`  Extra URLs: ${extraUrls.length}`);
  console.log(`  Mode: ${extraUrls.length ? 'on-demand pulls only' : 'host-school matrix'}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 1600 },
  });

  let succeeded = 0;
  let empty = 0;
  let failed = 0;

  try {
    if (extraUrls.length) {
      // On-demand: render only the supplied URLs.
      for (const url of extraUrls) {
        const filePath = `headshot-cache/_pulls/${sha1Hex(url)}.html`;
        process.stdout.write(`[pull] ${url}\n        → ${filePath}\n`);
        try {
          const { html, cardsFound } = await renderUrl(context, url);
          await writeCacheFile(filePath, html);
          if (cardsFound > 0) {
            console.log(`        ✓ ${cardsFound} cards rendered`);
            succeeded++;
          } else {
            console.log(`        ⚠ HTML written but no card selector matched`);
            empty++;
          }
        } catch (err) {
          console.log(`        ✗ ${err.message}`);
          failed++;
        }
        await new Promise(r => setTimeout(r, POLITE_DELAY_MS));
      }
    } else {
      // Default: render the matrix.
      for (const [school, baseUrl] of Object.entries(HOST_SCHOOLS)) {
        for (const sport of Object.keys(SPORT_PATHS)) {
          const sportPath = resolvePath(school, sport);
          if (sportPath === null) continue;
          const url = `${baseUrl}/${sportPath}`;
          const filePath = `headshot-cache/${slug(school)}/${slug(sport)}.html`;
          process.stdout.write(`[matrix] ${school} / ${sport}\n         ${url}\n         → ${filePath}\n`);
          try {
            const { html, cardsFound } = await renderUrl(context, url);
            await writeCacheFile(filePath, html);
            if (cardsFound > 0) {
              console.log(`         ✓ ${cardsFound} cards rendered`);
              succeeded++;
            } else {
              console.log(`         ⚠ HTML written but no card selector matched (page may not have a roster yet)`);
              empty++;
            }
          } catch (err) {
            console.log(`         ✗ ${err.message}`);
            failed++;
          }
          await new Promise(r => setTimeout(r, POLITE_DELAY_MS));
        }
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(`\nDone: ${succeeded} ok · ${empty} empty · ${failed} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
