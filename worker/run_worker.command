#!/usr/bin/env bash
# Double-clickable launcher for the CUSA Highlight Worker.
# Sets up a venv on first run, then runs the worker. Logs to the terminal.

set -e

cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
  echo "[setup] Creating Python venv (first run only)…"
  python3 -m venv venv
  # shellcheck disable=SC1091
  source venv/bin/activate
  echo "[setup] Installing requirements…"
  pip install --upgrade pip
  pip install -r requirements.txt
else
  # shellcheck disable=SC1091
  source venv/bin/activate
fi

if [ ! -f ".env" ]; then
  echo
  echo "ERROR: worker/.env not found. Copy .env.example to .env and fill in"
  echo "       SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running."
  echo
  exit 1
fi

exec python cusa_highlight_worker.py
