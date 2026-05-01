# CUSA ESPN Compliance Dashboard

An interactive web dashboard for tracking ESPN production compliance across the 11 Conference USA member schools. Built and maintained by CUSA media operations to provide schools, conference staff, and ESPN partners a shared view of broadcast equipment readiness against the 2025–26 ESPN Production Standards.

🌐 **Live site:** _coming soon_ — will be deployed to Netlify

---

## What This Tool Does

The dashboard takes the data each school submits in their annual ESPN Production Campus Survey and turns it into a live compliance view. It shows at a glance which schools meet the ESPN minimums for switchers, cameras, lenses, replay, audio, intercom, graphics, transmission, and backup power — and where the gaps are.

It has four tabs:

- **School Editor** — each school enters and updates their own equipment data. Per-sport camera counts can be entered for the six CUSA-sponsored sports. Changes save automatically.
- **Equipment Compliance** _(password protected)_ — a color-coded matrix comparing every school against the 14 ESPN minimum requirements. Green cells pass, red cells fail. Includes a one-click Excel export for sharing offline.
- **Sport Minimums** _(password protected)_ — for each school, breaks down camera and replay compliance per CUSA-sponsored sport with a "Why?" column explaining exactly which spec is failing. Filtered to the six CUSA-sponsored sports: Football, Basketball, Volleyball, Soccer, Baseball, Softball.
- **ESPN Standards Reference** — the underlying ESPN 2025–26 minimum specs and per-sport requirements, formatted for easy reference.

---

## CUSA Camera Minimums

These reflect the conference's broadcast standards, not just ESPN's general minimums:

| Sport | Minimum Cameras | Notes |
|---|---|---|
| Football | 4 | |
| Basketball | 4 | |
| Volleyball | 4 | |
| Soccer | 4 | |
| Baseball | 3 | High home, center field, low or high 1st base |
| Softball | 3 | High home, center field, low or high 1st base |

---

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS, no build step. Single `index.html` file with the Supabase JS client and `xlsx-js-style` loaded from CDN.
- **Database:** Supabase (Postgres) with row-level security and realtime subscriptions for live multi-user editing.
- **Auth:** Supabase Auth (magic-link email login).
- **Hosting:** Netlify, deployed automatically from the `main` branch.

---

## Local Development

```bash
# Clone
git clone https://github.com/<your-username>/cusa-espn-compliance.git
cd cusa-espn-compliance

# Set up environment
cp .env.example .env
# Then edit .env with your Supabase URL and anon key

# Generate config.js from .env (creates the file index.html reads at load time)
bash build.sh

# Serve locally — any static server works
python3 -m http.server 8000
# Then open http://localhost:8000
```

The site is intentionally a static HTML/JS app with no framework, no build pipeline, and no Node dependencies in the repo. Every change can be tested by opening `index.html` in a browser after running `build.sh` once.

---

## Environment Variables

Required for both local development and Netlify deployment:

| Variable | Description | Where to find it |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL | Supabase dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY` | The public anon key (safe to expose) | Same place as above |

The `service_role` key should **never** be committed or shared. It bypasses row-level security and is only needed for admin operations performed from the Supabase dashboard or trusted server-side scripts.

---

## Deployment

This site auto-deploys to Netlify on every push to `main`.

**Build command:** `bash build.sh`
**Publish directory:** `.` (project root)

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Netlify's site settings under **Site configuration → Environment variables**. The `build.sh` script reads them and generates `config.js`, which `index.html` loads at runtime.

---

## How to Add a New School

When a new school joins CUSA or a non-CUSA school needs to be added:

1. Open the Supabase dashboard → **Table Editor** → `schools` table.
2. Click **Insert row** and fill in at minimum: `name`, `conference`, `auth_email` (the school contact's email used for login).
3. Other fields can be left at their defaults — the school's primary contact will fill them in via the School Editor tab once they log in.
4. Send the contact a magic-link login by adding their email to **Authentication → Users → Invite user** in the Supabase dashboard.

To remove a school, delete the row from the `schools` table. The audit log entry is preserved automatically.

---

## How to Reset a Forgotten Password

There are no passwords — auth uses email magic links via Supabase. If a contact at a school can't log in:

1. Confirm their email matches the `auth_email` value in their `schools` row.
2. Have them visit the site and click **Send Login Link** — a one-time link arrives in their email and authenticates them.
3. If the email is wrong or they need a different contact, update `auth_email` in the `schools` table.

---

## How to Pull an Excel Export

1. Log in and open the **Equipment Compliance** tab.
2. Click the green **⬇ Export to Excel** button in the top right.
3. The file downloads as `CUSA_ESPN_Compliance_YYYY-MM-DD.xlsx` with two sheets: the full compliance matrix (with color-coded pass/fail formatting) and the ESPN Standards reference table.

The export uses `xlsx-js-style` from a CDN and runs entirely in the browser — no server round-trip and no data leaves the page.

---

## Brand Standards

This tool follows CUSA's 2025 Brand Book:

- **Primary colors:** Navy `#00263A`, Gray `#BFCED6`, White `#FFFFFF`
- **Accents:** Red `#E40046`, Blue `#00B5E2`, Green `#A7D500`
- **ESPN co-brand red:** `#EF4035`
- **Conference name:** "Conference USA" — abbreviation is **CUSA** (never "C-USA" or hyphenated)
- **ESPN logo:** Official ESPN black logo with transparent background, inverted to white on dark surfaces. No other ESPN marks.

---

## Project Structure

```
.
├── index.html              # The dashboard — single-page app, all UI logic
├── config.js               # Generated at build time — Supabase URL/anon key
├── build.sh                # Generates config.js from environment variables
├── supabase/
│   ├── schema.sql          # Database schema (schools + audit log)
│   └── seed.sql            # Initial 10-school seed data
├── .env.example            # Template for local environment variables
├── .gitignore
└── README.md
```

---

## Highlight Request

The Production Hub also includes an automated highlight pipeline (`highlight.html` + `highlight-admin.html`) that lets staff request player-specific highlights from Box game film by jersey number and color. Approved requests are claimed by a Python worker on a CUSA Mac, which produces a Box folder of clips and surfaces a 30-day shared link in the admin UI. The architecture is multi-worker-safe (atomic claim via `claim_next_highlight_job`, heartbeat-based stale-job sweeping) so processing capacity can scale by adding more machines. See [`docs/HIGHLIGHT_FEATURE.md`](docs/HIGHLIGHT_FEATURE.md) for the full architecture, schema, env-var reference, and operational runbook.

---

## Maintained By

**Keith King** — Conference USA Media Operations
[kking@conferenceusa.com](mailto:kking@conferenceusa.com)

For technical questions or to request access for a new school contact, reach out directly.

---

## License

Internal Conference USA tool. Not for redistribution.
