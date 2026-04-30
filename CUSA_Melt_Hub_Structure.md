# CUSA Melt Hub — Box Structure & Specification (v5)

**Status:** Box structure BUILT. Metadata template BUILT. File Request URLs LIVE. Ready for website build.

**Conference:** Conference USA, 2026–27 academic year
**Member Schools (10):** Delaware, FIU, Jacksonville State, Kennesaw State, Liberty, Middle Tennessee, Missouri State, New Mexico State, Sam Houston, Western Kentucky
**Sports (7):** Football, Women's Soccer, Volleyball, Men's Basketball, Women's Basketball, Softball, Baseball

**Companion file:** `melt_hub_config.json` — all live Box folder IDs and File Request URLs.

---

## What's Locked In

1. **Non-conference games:** CUSA admin uploads when school doesn't produce. Files go in home CUSA school's folder via Box Editor access (not File Request).
2. **Championship melts:** Live in `CHAMPIONSHIPS/` folder under the Hub. Per-event folders named `[SPORT] - [DATE] - [HOST]`.
3. **Melt type:** Broadcast melts only. No type taxonomy in file naming.
4. **File Requests:** 7 total — one per sport, used by all 10 schools, landing in per-sport `_New Uploads/` intake folders.
5. **No QC step.** Uploads are immediately visible to all schools and production companies.

---

## 1. Live Box Structure

```
CONFERENCE USA FILE SHARE/
└── 2026-27/                                    (Box ID 364937787874)
    └── VIDEO/                                   (Box ID 379505204768)
        ├── FOOTBALL/                            (379505912466)
        │   ├── _New Uploads/                    (379504475104)
        │   ├── DELAWARE/, FIU/, JAX STATE/, KENNESAW STATE/, LIBERTY/,
        │   └── MO STATE/, MTSU/, NM STATE/, SAM HOUSTON/, WKU/
        ├── MEN'S BASKETBALL/                    (379507701528)
        ├── WOMEN'S BASKETBALL/                  (379508106586)
        ├── VOLLEYBALL/                          (379505312505)
        ├── WOMEN'S SOCCER/                      (379507185119)
        ├── BASEBALL/                            (379505367606)
        ├── SOFTBALL/                            (379504825320)
        ├── CHAMPIONSHIPS/                       (379506549062)
        └── _ADMIN/                              (379504017113)
            ├── Templates/                       (379507382099)
            ├── Production Onboarding/           (379507962313)
            └── Melt Request Log/                (379507677283)
```

All school folder IDs (70 total) are in `melt_hub_config.json`.

> Inside each `[SPORT]/[SCHOOL]/` folder, schools (or admin for non-conference) create game folders following §3. Inside each game folder, the melt file follows §4 naming.

---

## 2. Sport Folder Conventions

Each sport folder contains:
- One `_New Uploads/` intake folder (File Request landing zone)
- 10 school folders using CUSA's existing internal abbreviations:
  `DELAWARE`, `FIU`, `JAX STATE`, `KENNESAW STATE`, `LIBERTY`, `MO STATE`, `MTSU`, `NM STATE`, `SAM HOUSTON`, `WKU`

> UTEP and LA TECH excluded for 2026-27 per realignment.

---

## 3. Game Folder Naming Convention

### Format

```
VS [Opponent Full Name] [MM-DD-YYYY]
```

- `VS` always uppercase
- Opponent uses **full school name** with proper capitalization (e.g., `Middle Tennessee`, not `MTSU`)
- Date format: `MM-DD-YYYY`, zero-padded with hyphens

### Examples

```
2026-27/VIDEO/FOOTBALL/JAX STATE/VS Liberty 09-12-2026/
2026-27/VIDEO/MEN'S BASKETBALL/JAX STATE/VS Middle Tennessee 01-23-2026/
2026-27/VIDEO/VOLLEYBALL/SAM HOUSTON/VS FIU 10-04-2026/
2026-27/VIDEO/WOMEN'S SOCCER/LIBERTY/VS Missouri State 09-25-2026/
```

### Series Sports (Baseball, Softball)

Series folder + game subfolders:
```
BASEBALL/SAM HOUSTON/VS New Mexico State 04-10-2026 (Series)/
├── G1/
├── G2/
└── G3/
```

Doubleheaders:
```
└── G1/
    ├── (DH1)/
    └── (DH2)/
```

---

## 4. Mandatory File Naming Convention

### Regular Season Format

```
YYYY-MM-DD [Home] vs [Opponent] - MELT.[ext]
```

For series sports:
```
YYYY-MM-DD [Home] vs [Opponent] G1 - MELT.[ext]
```

### Championship Format

```
YYYY-MM-DD [Round] - [Team A] vs [Team B] - MELT.[ext]
```

Where `[Round]` is `Quarterfinal`, `Semifinal`, `Final`, `Championship`, `Game 1`, `Game 2`, etc.

### Examples

```
2026-09-12 Jax State vs Liberty - MELT.mp4
2026-04-10 Sam Houston vs New Mexico State G1 - MELT.mp4
2026-04-10 Sam Houston vs New Mexico State G1 (DH1) - MELT.mp4
2027-03-14 Final - Liberty vs WKU - MELT.mp4
2026-12-05 Championship - Liberty vs Jax State - MELT.mp4
```

### Rules
- All caps for `MELT` suffix; lowercase only for the file extension (`.mp4` or `.mov`)
- Use spaces in matchup, hyphens around `MELT` and round
- HOME team always first, regardless of who's uploading
- Date is **game date**, not upload date

---

## 5. Championships Structure

Per-event folder under `CHAMPIONSHIPS/`. File naming uses round (Quarterfinal/Semifinal/Final/Championship) in place of opponent.

```
CHAMPIONSHIPS/
├── FOOTBALL - DEC 5 - JAX STATE/
│   └── 2026-12-05 Championship - Liberty vs Jax State - MELT.mp4
│
├── MEN'S BASKETBALL - MARCH 10-14 - HUNTSVILLE/
│   ├── 2027-03-11 Quarterfinal - Liberty vs Sam Houston - MELT.mp4
│   ├── 2027-03-12 Semifinal - Liberty vs WKU - MELT.mp4
│   └── 2027-03-14 Final - Liberty vs Sam Houston - MELT.mp4
│
└── [other championship events]
```

Network info (CBS, ESPN, etc.) lives in metadata, not folder structure.

---

## 6. Permission Model

| Folder | CUSA Staff | All CUSA Schools | Production Companies |
|---|---|---|---|
| `2026-27/VIDEO/` (Hub root) | Co-owner | Viewer | Viewer |
| `[SPORT]/` | Editor | Viewer | Viewer |
| `[SPORT]/_New Uploads/` | Editor | Viewer (post-upload) | Viewer |
| `[SPORT]/[SCHOOL]/` | Editor | Editor for own school, Viewer for others | Viewer |
| `CHAMPIONSHIPS/` | Editor | Viewer | Viewer |
| `_ADMIN/` | Co-owner | None | None |

**Box Group:** `CUSA Melt Hub - Production Viewers` — production companies are added to this group; group is granted Viewer on `2026-27/VIDEO/`. Add/remove vendors = group membership change.

---

## 7. Upload Mechanisms

### Schools — Option A (Box Editor, recommended)
1. Log into Box
2. Navigate to `2026-27/VIDEO/[SPORT]/[SCHOOL]/`
3. Create game folder per §3
4. Upload file named per §4

### Schools — Option B (File Request, no login required)
- 7 File Request URLs total, one per sport, shared across all 10 schools
- Each lands in that sport's `_New Uploads/` folder
- Filename `[Home School]` segment identifies the source school
- URLs stored in `melt_hub_config.json` → `sports[].file_request_url`

### CUSA Admin — non-conference games
- Uses Box Editor access, uploads directly to home CUSA school's folder
- Same naming convention applies

---

## 8. Production Company Access

Two paths via the website:

1. **Catalog page** — Box API-driven, filterable by sport, school, date, phase. Click-through opens file in Box.
2. **Request form** — production companies request specific melts or custom edits. Submissions write to `_ADMIN/Melt Request Log/`.

Production companies are added to the `CUSA Melt Hub - Production Viewers` Box group. Group membership = access; no per-folder edits needed.

---

## 9. Box Metadata Template — `cusaMelt` (BUILT)

Applied to files in the Hub for catalog filtering. Schools fill on upload via Box web UI.

| Field | Type | Values |
|---|---|---|
| Sport | Dropdown | Football, Men's Basketball, Women's Basketball, Volleyball, Women's Soccer, Baseball, Softball |
| Home School | Dropdown | (10 CUSA schools) |
| Opponent | Text | Free text — any opponent (CUSA or non-conference) |
| Game Date | Date | — |
| Phase | Dropdown | Regular Season, Quarterfinal, Semifinal, Final, Championship |
| Series Game | Text | G1, G2, G3 (baseball/softball series only) |
| Network | Dropdown | ESPN, ESPN+, CBS, Other |

Template key: `cusaMelt` (referenced from config).

---

## 10. Website Integration (for Claude Code)

The companion `melt_hub_config.json` has every folder ID and File Request URL the website needs.

### Filename validation regex

```regex
^\d{4}-\d{2}-\d{2} ((Quarterfinal|Semifinal|Final|Championship|Game [1-9]\d?) - )?[A-Z][A-Za-z. ]+ vs [A-Z][A-Za-z. ]+( G[1-3])?( \(DH[12]\))? - MELT\.(mp4|mov)$
```

### School upload page
- Authenticate the school user
- Surface the 7 File Request URLs (one per sport)
- Filename builder UI: dropdowns for date, home school (locked), opponent, series game / round → builds the exact filename and copies to clipboard
- Show recent uploads from that school for reference

### Catalog page (schools + production companies)
- Use Box API `GET /folders/:id/items` recursively, or query `cusaMelt` metadata
- Filters: Sport, School (home or opponent), Date range, Phase
- Result row: thumbnail, game date, matchup, sport, school, phase, download link

### Request form (production companies)
- Fields: Production Company, Contact, Sport(s), School(s), Date Range, Phase, Notes, Deadline
- Writes to `_ADMIN/Melt Request Log/` (Box ID `379507677283`) or to a SharePoint list `CUSA_Melt_Request_Log` for Power Automate parity

---

## 11. Implementation Status

| Item | Status |
|---|---|
| Box folder structure (89 folders) | ✅ BUILT |
| `cusaMelt` metadata template (7 fields) | ✅ BUILT |
| File Request URLs (7) | ✅ LIVE |
| `melt_hub_config.json` populated | ✅ COMPLETE |
| `CUSA Melt Hub - Production Viewers` Box group | ⏳ TBD |
| Per-school editor groups (10) | ⏳ TBD |
| Collaborator permissions applied per §6 | ⏳ TBD |
| Website (school upload page, catalog, request form) | ⏳ Claude Code build |

### Sequencing recommendation
- **Now:** hand `CUSA_Melt_Hub_Structure.md` (this doc) + `melt_hub_config.json` to Claude Code to start the website build.
- **Before vendor onboarding:** create `CUSA Melt Hub - Production Viewers` group and apply collaborations. Defer until first vendor is ready to be added — no urgency for an empty group.
- **Before season start:** apply per-school editor permissions so each school sees only their own folder as Editor.
