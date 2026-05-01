/**
 * box-highlights — Netlify Function for the Highlight Request workflow.
 *
 * Actions (POST body { action, ... }):
 *   approve         — Move a Pending request to Approved
 *   decline         — Move a Pending request to Declined
 *   retry           — Reset a Failed/Complete row to Approved
 *   force_reset     — Reset a Processing row whose worker died
 *   delete          — Delete a row (cascades to processing log)
 *   sweep_stale     — Call sweep_stale_highlight_jobs RPC
 *   get_share_link  — Mint a 30-day Box shared link on the output folder
 *
 * Auth: admin email + sha-256 password hash sent in headers.
 *   X-Admin-Email: <email>
 *   X-Admin-Pw-Hash: <hex>
 * Function looks up admin_users; row must exist + be active + hash must match.
 *
 * Required Netlify env vars (already set for box-archive — reused as-is):
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service-role key
 *   BOX_CONFIG_JSON       — JWT app config.json contents
 *
 * Dependencies live in the root package.json (Netlify's esbuild bundler
 * resolves from there). Do not add a function-local package.json.
 */

const BoxSDK = require('box-node-sdk');
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-admin-email, x-admin-pw-hash'
};

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

let _supabase = null;
function supabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY env var missing');
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

async function verifyAdmin(headers) {
  const email = (headers['x-admin-email'] || headers['X-Admin-Email'] || '').toLowerCase().trim();
  const hash  = (headers['x-admin-pw-hash'] || headers['X-Admin-Pw-Hash'] || '').trim();
  if (!email || !hash) return null;
  const { data, error } = await supabase()
    .from('admin_users')
    .select('email, pw_hash, display_name, is_active')
    .eq('email', email)
    .maybeSingle();
  if (error || !data || !data.is_active || data.pw_hash !== hash) return null;
  return { email: data.email, display_name: data.display_name || data.email };
}

async function logActivity(admin, action, target, details) {
  try {
    await supabase().from('admin_activity_log').insert({
      email: admin.email,
      display_name: admin.display_name,
      app: 'highlights',
      action, target, details
    });
  } catch (e) { /* best-effort */ }
}

async function loadRequest(requestId) {
  const { data, error } = await supabase()
    .from('highlight_requests').select('*').eq('id', requestId).maybeSingle();
  if (error) throw new Error('Lookup failed: ' + error.message);
  if (!data) throw new Error('Request not found');
  return data;
}

/* ── Action handlers ── */

async function handleApprove(body, admin) {
  const { request_id, admin_notes } = body;
  if (!request_id) return jsonResponse(400, { error: 'request_id is required' });

  const row = await loadRequest(request_id);
  const updates = {
    status: 'Approved',
    approved_by: admin.email,
    approved_at: new Date().toISOString()
  };
  if (admin_notes) {
    const prefix = row.notes ? row.notes + '\n\n' : '';
    updates.notes = prefix + `[admin ${admin.email} @ ${new Date().toISOString()}] ${admin_notes}`;
  }
  const { error } = await supabase().from('highlight_requests')
    .update(updates).eq('id', request_id);
  if (error) return jsonResponse(500, { error: 'Update failed: ' + error.message });

  await logActivity(admin, 'edit', `highlight_request:${request_id}`,
    `Approved request from ${row.requester_email} — jersey #${row.jersey_number} ${row.jersey_color}`);
  return jsonResponse(200, { ok: true });
}

async function handleDecline(body, admin) {
  const { request_id, reason } = body;
  if (!request_id) return jsonResponse(400, { error: 'request_id is required' });

  const row = await loadRequest(request_id);
  const { error } = await supabase().from('highlight_requests').update({
    status: 'Declined',
    declined_reason: reason || null,
    declined_at: new Date().toISOString(),
    approved_by: admin.email
  }).eq('id', request_id);
  if (error) return jsonResponse(500, { error: 'Update failed: ' + error.message });

  await logActivity(admin, 'edit', `highlight_request:${request_id}`,
    `Declined request from ${row.requester_email}: ${reason || 'no reason given'}`);
  return jsonResponse(200, { ok: true });
}

async function handleGetShareLink(body, admin) {
  const { request_id } = body;
  if (!request_id) return jsonResponse(400, { error: 'request_id is required' });

  const row = await loadRequest(request_id);
  if (!row.output_box_folder_id) {
    return jsonResponse(400, { error: 'No output_box_folder_id set on this request — has the worker finished?' });
  }

  const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

  let folder;
  try {
    folder = await boxClient().folders.update(row.output_box_folder_id, {
      shared_link: {
        access: 'open',
        unshared_at: expiresAt,
        permissions: { can_download: true, can_preview: true }
      }
    });
  } catch (e) {
    return jsonResponse(502, { error: 'Box API failed: ' + (e.message || e) });
  }
  const sharedUrl = folder?.shared_link?.url;
  if (!sharedUrl) return jsonResponse(502, { error: 'Box did not return a shared link URL' });

  await logActivity(admin, 'add', `highlight_share:${request_id}`,
    `Minted share link on folder ${row.output_box_folder_id} (expires ${expiresAt})`);
  return jsonResponse(200, { shared_url: sharedUrl, expires_at: expiresAt });
}

async function handleRetry(body, admin) {
  const { request_id } = body;
  if (!request_id) return jsonResponse(400, { error: 'request_id is required' });

  const { error } = await supabase().from('highlight_requests').update({
    status: 'Approved',
    error_message: null,
    processing_started_at: null,
    processing_completed_at: null,
    worker_host: null,
    last_heartbeat_at: null
  }).eq('id', request_id);
  if (error) return jsonResponse(500, { error: 'Update failed: ' + error.message });

  await logActivity(admin, 'edit', `highlight_request:${request_id}`, 'Retry triggered');
  return jsonResponse(200, { ok: true });
}

async function handleForceReset(body, admin) {
  const { request_id } = body;
  if (!request_id) return jsonResponse(400, { error: 'request_id is required' });

  const { error } = await supabase().from('highlight_requests').update({
    status: 'Approved',
    worker_host: null,
    processing_started_at: null,
    last_heartbeat_at: null,
    error_message: `Force-reset by ${admin.email} at ${new Date().toISOString()}`
  }).eq('id', request_id);
  if (error) return jsonResponse(500, { error: 'Update failed: ' + error.message });

  await logActivity(admin, 'edit', `highlight_request:${request_id}`,
    'Force-reset (worker presumed dead)');
  return jsonResponse(200, { ok: true });
}

async function handleSweepStale(body, admin) {
  const stale_minutes = Number.isFinite(body.stale_minutes) ? body.stale_minutes : 5;
  const { data, error } = await supabase().rpc('sweep_stale_highlight_jobs', { p_stale_minutes: stale_minutes });
  if (error) return jsonResponse(500, { error: 'Sweep failed: ' + error.message });
  const reset_count = typeof data === 'number' ? data : (data?.[0] ?? 0);

  await logActivity(admin, 'edit', 'highlight_sweep',
    `Reset ${reset_count} stale jobs (threshold: ${stale_minutes} min)`);
  return jsonResponse(200, { ok: true, reset_count });
}

async function handleDelete(body, admin) {
  const { request_id } = body;
  if (!request_id) return jsonResponse(400, { error: 'request_id is required' });

  const { error } = await supabase().from('highlight_requests').delete().eq('id', request_id);
  if (error) return jsonResponse(500, { error: 'Delete failed: ' + error.message });

  await logActivity(admin, 'delete', `highlight_request:${request_id}`, 'Deleted');
  return jsonResponse(200, { ok: true });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return jsonResponse(405, { error: 'Method not allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  const admin = await verifyAdmin(event.headers || {});
  if (!admin) return jsonResponse(401, { error: 'Unauthorized — invalid admin credentials' });

  try {
    switch (body.action) {
      case 'approve':        return await handleApprove(body, admin);
      case 'decline':        return await handleDecline(body, admin);
      case 'retry':          return await handleRetry(body, admin);
      case 'force_reset':    return await handleForceReset(body, admin);
      case 'sweep_stale':    return await handleSweepStale(body, admin);
      case 'delete':         return await handleDelete(body, admin);
      case 'get_share_link': return await handleGetShareLink(body, admin);
      default:
        return jsonResponse(400, { error: 'Unknown action — expected one of: approve, decline, retry, force_reset, sweep_stale, delete, get_share_link' });
    }
  } catch (e) {
    console.error('box-highlights error:', e);
    return jsonResponse(500, { error: 'Internal error: ' + (e.message || e) });
  }
};
