# CUSA Melt Archive — Browse & Request Spec (v3.1)

**Status:** Approach finalized. Tree builder run successfully (5,242 game folders captured). Ready for Claude Code handoff.

**Goal:** Give broadcast partners a self-serve way to identify the melt they need from the live Box archive (all 9 years), then request access. Approval is manual; once granted, an access code on the Hub unlocks the embedded folder for browsing/download.

**Key design move:** No catalog. No parser. The Hub displays Box folder names exactly as they appear, and the producer does the cognitive work of identifying their match.

---

## What changed in v3.1

Closes a gap flagged during review: **Box's embed widget requires a shared link URL, not a folder ID.** The approve action now generates a shared link via the Box API at the moment of approval and stores its URL alongside the access code. Producer never sees the shared link directly — only the code.

---

## Why this approach works

Earlier approaches tried to extract structured metadata from inconsistently-named Box folders (`Jax State at Air Force` vs `Hawai'i at Sam Houston (Sept 14th - Week 3)` vs `MELT(USMvsFAU).mp4`). That parsing was always going to be fragile. This design treats the messiness as a feature: the producer who knows what game they want will recognize it from the folder name regardless of format. The Hub's job is just to surface those names quickly.

---

## Architecture (3 components)

### 1. Folder tree JSON (`melt_archive_tree.json`)
- Single static file, refreshed quarterly + on-demand
- Contains: every Year → Sport → School → Game folder name and Box folder ID
- ~1 MB file size estimate
- Built by the `build_archive_tree.py` script (no parsing logic, just folder enumeration)
- Lives in the website's static assets

### 2. Hub `/archive` page (Claude Code build)
- Loads `melt_archive_tree.json` on page load
- Cascading dropdowns: Year → Sport → School → Game folder (each populated based on prior selection)
- Each game folder displays its name **exactly as on Box** — no normalization
- "Request Access" button on the selected game folder
- Request form fields:
  - Required: Full Name, Email
  - Optional: Company, Phone, Project name, Intended use, Air date / deadline, Notes
  - Acknowledgment checkbox
- Submission writes to:
  - SharePoint list `CUSA_Melt_Archive_Requests` (with selected Box folder ID for one-click admin lookup)
  - Power Automate flow fires email notification to Keith with all fields

### 3. Code unlock UI (Claude Code build)
- Separate panel on `/archive`: "Already have an access code? Enter here."
- Producer enters code → Hub validates against SharePoint list `CUSA_Melt_Archive_Codes`
- On valid code, Hub fetches the stored Box shared link URL and renders the folder via Box embed widget
- Code (and the underlying shared link) expire automatically per their expiration date

---

## Approve action — full flow (the part that closes the v3 gap)

When Keith clicks Approve on a pending request:

1. **Backend generates an access code** — 8-12 character alphanumeric, system-generated, must not collide with active codes
2. **Backend calls the Box API** to create a shared link on the requested folder:
   ```
   PUT https://api.box.com/2.0/folders/{folder_id}
   Authorization: Bearer <service account token>
   Content-Type: application/json

   {
     "shared_link": {
       "access": "open",
       "unshared_at": "<code expiration ISO timestamp, default +14 days>",
       "permissions": {
         "can_download": true,
         "can_preview": true
       }
     }
   }
   ```
3. **Box returns the folder object** with the new `shared_link.url` populated (format: `https://app.box.com/s/<token>`)
4. **Backend writes a row to `CUSA_Melt_Archive_Codes`** containing:
   - The access code (what the producer types)
   - The folder ID
   - The shared link URL (private — never shown to producer)
   - Expiration timestamp
   - Reference to the originating request
5. **Backend updates the originating request** in `CUSA_Melt_Archive_Requests` to status = Approved
6. **Power Automate sends the producer an email** with: the access code, expiration, and instructions to enter it on `/archive`

**Note:** The shared link is `access: "open"` (anyone with the URL can view) but the URL is never exposed publicly — the Hub's code unlock is the real access gate. The shared link is essentially a Box-internal handle the embed widget needs.

---

## Code unlock — full flow

1. Producer goes to `/archive` and enters their code in the unlock field
2. Backend looks up the code in `CUSA_Melt_Archive_Codes`
3. Validation rules (any failure → error message, increment failed-attempt counter):
   - Code exists
   - Status = Active (not Expired or Revoked)
   - `expires_at` > now
4. On success: Hub renders Box embed widget with `src` = stored `shared_link_url`
5. Producer browses files within the embed, downloads what they need
6. (Optional) Track unlocks per code for audit (count of times the code was successfully entered)

---

## Revocation / Expiration

- Codes auto-expire when `expires_at` passes — Box also auto-removes the shared link via `unshared_at` set during the approve action
- Manual revoke action in admin panel:
  1. Update code Status to Revoked in `CUSA_Melt_Archive_Codes`
  2. Call Box API to remove the shared link:
     ```
     PUT https://api.box.com/2.0/folders/{folder_id}
     {"shared_link": null}
     ```
- Producer attempting to use an expired/revoked code gets an error message with a "Submit a new request" link

---

## Admin Interface (Claude Code build)

Keith-only panel on the Hub:

- **Pending requests view** — list of submissions from `CUSA_Melt_Archive_Requests`, sortable by submission time
- **Approve action** — runs the full flow above (generate code, mint shared link, write to codes list, email requester)
- **Decline action** — sends a courtesy email with optional reason; updates request status
- **Active codes view** — list of unexpired codes with expiration timestamps; revoke option
- **Manual code creation** — bypass the request form to create a code directly (useful for trusted partners requesting verbally — admin enters folder ID and requester email, system runs the same Approve flow)

---

## SharePoint Lists

### `CUSA_Melt_Archive_Requests`
| Field | Type | Notes |
|---|---|---|
| Request ID | Auto | |
| Submitted At | DateTime | |
| Full Name | Text | required |
| Email | Email | required |
| Company | Text | optional |
| Phone | Text | optional |
| Project Name | Text | optional |
| Intended Use | Choice | Broadcast / Social cut / Archival / Other |
| Deadline | Date | optional |
| Notes | Multi-line text | optional |
| Selected Year | Text | from dropdown |
| Selected Sport | Text | |
| Selected School | Text | |
| Selected Game | Text | folder name as displayed |
| Box Folder ID | Text | for one-click lookup |
| Status | Choice | Pending / Approved / Declined |
| Approved By | Text | Keith |
| Approved At | DateTime | |

### `CUSA_Melt_Archive_Codes`
| Field | Type | Notes |
|---|---|---|
| Code | Text | 8-12 char alphanumeric, system-generated |
| Box Folder ID | Text | the folder this code unlocks |
| Folder Display Name | Text | for admin readability |
| **Shared Link URL** | Text | private — `https://app.box.com/s/<token>` from Box API |
| Expires At | DateTime | default = approved_at + 14 days |
| Created From Request | Lookup | reference to request row |
| Requester Email | Email | for revocation contact |
| Status | Choice | Active / Expired / Revoked |
| Created At | DateTime | |
| Unlock Count | Number | optional — increment on each successful code entry |

---

## End-to-End Flow

1. Producer visits Hub `/archive`
2. Selects: Year → Sport → School → Game folder (cascading dropdowns from `melt_archive_tree.json`)
3. Clicks "Request Access" → fills form → submits
4. Power Automate notifies Keith with all details
5. Keith reviews, opens admin panel, clicks Approve, sets expiration (or accepts default 14 days)
6. **System generates code AND mints Box shared link** in one operation; stores both in SharePoint
7. Email sent to producer with the code + expiration
8. Producer returns to Hub `/archive`, enters code in the unlock field
9. Hub validates code, looks up the shared link URL, renders Box embed widget
10. Producer browses files, downloads what they need
11. Code and shared link auto-expire on the same date. Subsequent unlocks fail.
12. Producer can submit a new request if they need extended or repeat access

---

## Box API Permissions Required

The backend needs a Box service account (or long-lived OAuth token) with these scopes on the relevant folders:
- **Read folders** (already required for shared link creation)
- **Manage shared links** — `PUT /folders/{id}` with shared_link payload
- **Optional: Manage embed links** — same endpoint with `embed_url` permissions if you want the Hub to use Box's embed iframe URL specifically rather than the standard shared link

A developer token won't work for production — those expire in 60 minutes. Use one of:
- **Service account with JWT app authentication** (recommended)
- **Long-lived OAuth refresh token** stored in the backend's secrets store

---

## Tree Refresh

The folder tree changes when:
- New game folders are added during current season
- New season starts (new top-level year folder)
- Folders renamed or reorganized in Box

Manual refresh: Keith runs `build_archive_tree.py` and re-deploys the resulting `melt_archive_tree.json` to the website. Quarterly is the default cadence.

For more frequent updates during peak season, Claude Code can wire the script to a Power Automate trigger that runs it on a schedule and pushes the updated JSON to the Hub's static assets folder.

---

## What Claude Code Builds

1. `/archive` page with cascading dropdowns (loads `melt_archive_tree.json`)
2. Request form + submission endpoint (writes to SharePoint, fires Power Automate)
3. Code unlock field + Box embed renderer (resolves code → shared link URL → embed)
4. Admin panel: pending requests view, approve/decline actions, active codes view, manual code creation
5. Backend service that calls Box API for shared link creation/removal (needs service account creds)
6. Power Automate flows: request-submitted notification, approval email with code, decline email
7. SharePoint list schemas (per above)

---

## Build Order

1. ✅ Tree builder script written and run (`melt_archive_tree.json` produced — 5,242 game folders)
2. ⏳ Set up Box service account with shared link management permissions
3. ⏳ Hand JSON + this spec to Claude Code
4. ⏳ Claude Code builds the `/archive` page, request flow, code unlock, admin panel, backend
5. ⏳ Soft launch with one trusted partner
6. ⏳ Schedule quarterly tree refreshes
