/**
 * box-sync-names — Pulls each commercial's current Box filename and updates
 * commercials.name in Supabase if it has drifted (e.g. someone renamed the
 * file in Box). Triggered manually from the Commercials Hub Admin Panel via
 * the "Sync filenames from Box" button.
 *
 * Auth: shared-secret model matching the rest of the Commercials Hub admin
 *   surface — client sends X-Admin-Pw-Hash equal to the SHA-256 hash of the
 *   admin password, function compares to env var.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL                — already set
 *   SUPABASE_SERVICE_KEY        — Supabase service-role key
 *   BOX_CONFIG_JSON             — Box JWT app config.json (already set)
 *   COMMERCIALS_ADMIN_PW_HASH   — sha-256 hex of the Commercials Hub admin
 *                                 password (matches ADMIN_PW_HASH constant
 *                                 in commercials.html)
 */

const BoxSDK = require('box-node-sdk');
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-admin-pw-hash'
};

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

let _supabase = null;
function supabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    const missing = [];
    if (!url) missing.push('SUPABASE_URL');
    if (!key) missing.push('SUPABASE_SERVICE_KEY');
    if (missing.length) throw new Error(`Missing Netlify env var(s): ${missing.join(', ')}`);
    _supabase = createClient(url, key, { auth: { persistSession: false } });
  }
  return _supabase;
}

let _boxClient = null;
function boxClient() {
  if (!_boxClient) {
    const cfg = process.env.BOX_CONFIG_JSON;
    if (!cfg) throw new Error('BOX_CONFIG_JSON env var missing');
    let parsed;
    try { parsed = JSON.parse(cfg); }
    catch (e) { throw new Error('BOX_CONFIG_JSON is not valid JSON: ' + e.message); }
    const sdk = BoxSDK.getPreconfiguredInstance(parsed);
    _boxClient = sdk.getAppAuthClient('enterprise');
  }
  return _boxClient;
}

async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...await Promise.all(chunk.map(fn)));
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return jsonResponse(405, { error: 'Method not allowed' });

  const expected = (process.env.COMMERCIALS_ADMIN_PW_HASH || '').toLowerCase().trim();
  const provided = (event.headers['x-admin-pw-hash'] || event.headers['X-Admin-Pw-Hash'] || '').toLowerCase().trim();
  if (!expected) return jsonResponse(500, { error: 'COMMERCIALS_ADMIN_PW_HASH env var missing' });
  if (!provided || provided !== expected) return jsonResponse(401, { error: 'Unauthorized' });

  let sb, box;
  try { sb = supabase(); box = boxClient(); }
  catch (e) { return jsonResponse(500, { error: e.message }); }

  const { data: rows, error } = await sb.from('commercials')
    .select('id, name, box_file_id')
    .not('box_file_id', 'is', null);
  if (error) return jsonResponse(500, { error: error.message });

  const candidates = (rows || []).filter(r => r.box_file_id && String(r.box_file_id).trim());
  if (!candidates.length) return jsonResponse(200, { updated: 0, unchanged: 0, missing: 0, errors: [], total: 0 });

  const results = await inChunks(candidates, 5, async (c) => {
    try {
      const file = await box.files.get(String(c.box_file_id).trim(), { fields: 'id,name' });
      const newName = (file && file.name) ? String(file.name) : '';
      if (!newName) return { kind: 'missing', id: c.id, name: c.name };
      if (newName === c.name) return { kind: 'unchanged' };
      const { error: upErr } = await sb.from('commercials')
        .update({ name: newName }).eq('id', c.id);
      if (upErr) return { kind: 'error', id: c.id, name: c.name, error: upErr.message };
      return { kind: 'updated', id: c.id, oldName: c.name, newName };
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        return { kind: 'missing', id: c.id, name: c.name };
      }
      return { kind: 'error', id: c.id, name: c.name, error: (e && e.message) || String(e) };
    }
  });

  const summary = {
    total: candidates.length,
    updated: results.filter(r => r.kind === 'updated').length,
    unchanged: results.filter(r => r.kind === 'unchanged').length,
    missing: results.filter(r => r.kind === 'missing').length,
    errors: results.filter(r => r.kind === 'error'),
    renames: results.filter(r => r.kind === 'updated').map(r => ({ id: r.id, oldName: r.oldName, newName: r.newName })),
    missingFiles: results.filter(r => r.kind === 'missing').map(r => ({ id: r.id, name: r.name }))
  };
  return jsonResponse(200, summary);
};
