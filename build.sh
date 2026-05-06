#!/usr/bin/env bash
# Injects Supabase credentials and a build version stamp into config.js at
# build time. Netlify runs this before serving the site. Pages can read
# window.BUILD_VERSION to confirm what's deployed (defaults to "dev" when
# config.js isn't generated, e.g. opening the file locally).
set -e

SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +"%Y-%m-%d %H:%M UTC")"

cat > config.js <<EOF
window.SUPABASE_URL = '${SUPABASE_URL}';
window.SUPABASE_ANON_KEY = '${SUPABASE_ANON_KEY}';
window.BUILD_VERSION = '${SHORT_SHA} ${BUILD_TIME}';
EOF
echo "config.js generated (build ${SHORT_SHA} ${BUILD_TIME})."
