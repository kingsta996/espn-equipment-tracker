#!/usr/bin/env bash
# Injects Supabase credentials into config.js at build time.
# Netlify runs this before serving the site.
set -e
cat > config.js <<EOF
window.SUPABASE_URL = '${SUPABASE_URL}';
window.SUPABASE_ANON_KEY = '${SUPABASE_ANON_KEY}';
EOF
echo "config.js generated."
