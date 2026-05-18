# WSC Laptop Browser-Launch Agent

A tiny Python daemon that runs on each capture laptop (LAPTOP-A / LAPTOP-B)
and opens the ESPN watch URL in the laptop's logged-in browser at scheduled
trigger times. Drives the OBS+RTMP capture pipeline from the self-service
WSC request portal at `wsc-request.html`.

## How it fits

1. Staff submits a request at `wsc-request.html` → row written to
   Supabase table `wsc_laptop_dispatches` (status `pending`, trigger_at
   set to kickoff − 4 min).
2. Each laptop runs this agent, polling Supabase every 30s for its own
   pending rows.
3. When `trigger_at <= now + LEAD_TIME_S`, agent runs
   `open -a "Google Chrome" <launch_url>` and flips the row to
   `launched` with a `launched_at` + `result_log`.
4. OBS on the laptop captures the browser screen + sends RTMP to WSC.

## Setup (per laptop)

```bash
cd /path/to/wsc-laptop-agent

# 1. Copy the env template and fill it in
cp .env.example .env
$EDITOR .env             # set LAPTOP_ID, SUPABASE_URL, SUPABASE_ANON_KEY

# 2. Sanity check — print pending dispatches without launching anything
set -a; source .env; set +a
python3 wsc_laptop_agent.py --once --dry-run

# 3. One real tick (will actually open a browser if anything's due)
python3 wsc_laptop_agent.py --once

# 4. Run as a long loop
python3 wsc_laptop_agent.py
```

No third-party deps — `urllib` + `subprocess` from stdlib.

## Browser prep

The agent uses `open -a "Google Chrome" <url>`, which opens the URL in
whichever profile of Chrome is currently default. Two things matter:

- **ESPN+ must be logged in** in the default Chrome profile. The agent
  doesn't handle auth; it relies on the browser's existing session.
- **Pop the window full-screen + start OBS scene** is a manual step
  the laptop operator does. The agent's job ends at "URL is open in
  the foreground tab."

If you'd rather route to Safari or Edge, set `BROWSER_APP=Safari` (or
the exact `.app` bundle name) in `.env`.

## Auto-start with LaunchAgent (later)

Once you've validated the manual run, install the LaunchAgent so the
script restarts on login:

```bash
# Save as ~/Library/LaunchAgents/com.cusa.wsc-laptop-agent.plist
# Edit the absolute paths + env vars for this laptop, then:
launchctl load ~/Library/LaunchAgents/com.cusa.wsc-laptop-agent.plist
launchctl start com.cusa.wsc-laptop-agent
```

A starter plist template is in this directory as
`com.cusa.wsc-laptop-agent.plist.template`.

## Troubleshooting

- **"No pending dispatches" but the request portal shows one**: confirm
  `LAPTOP_ID` matches exactly (`LAPTOP-A` vs `LAPTOP-B`) — case + hyphen
  are strict.
- **Agent fires but browser doesn't open**: macOS may have lost the
  default-app binding. Test by running `open -a "Google Chrome"
  "https://espn.com"` from the same shell.
- **Row goes to `failed` instead of `launched`**: check
  `wsc_laptop_dispatches.result_log` in Supabase — the agent stores the
  subprocess return code + stderr there.
- **Polling but never firing**: confirm system clock is accurate
  (`sntp time.apple.com`). The agent compares `trigger_at` (UTC) to
  `datetime.now(UTC)`.

## Security note

The agent uses the **anon** Supabase key, the same one that's
client-shipped in `config.js`. RLS on `wsc_laptop_dispatches` allows
anon SELECT/UPDATE/INSERT/DELETE — the trust boundary is the laptop
itself (which only trusted operators can log in to), not the key.

If you want a stricter posture, split the agent off to a
service-role key delivered out-of-band and tighten the RLS UPDATE
policy to deny anon writes. Not necessary for v1.
