/**
 * box-archive — Netlify Function for Melt Archive admin actions.
 *
 * Actions:
 *   mint   — Mint a Box shared link on a folder, generate an access code,
 *            insert into melt_archive_codes, mark the originating request
 *            (if any) as Approved.
 *   revoke — Null the Box shared link on the folder, mark the code Revoked.
 *
 * Auth (light): admin email + sha-256 password hash sent in headers.
 *   X-Admin-Email: <email>
 *   X-Admin-Pw-Hash: <hex>
 * Function looks up admin_users; row must exist + be active + hash must match.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL          — already set (used by build.sh)
 *   SUPABASE_SERVICE_KEY  — Supabase service-role key (Settings → API)
 *   BOX_CONFIG_JSON       — full contents of the JWT app's config.json
 *                           (Box dev console → JWT app → "Generate Public/
 *                            Private Keypair" → download config.json →
 *                            paste the entire JSON as the env var value)
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

async function generateUniqueCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // omit ambiguous I/L/O/0/1
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const { data } = await supabase()
      .from('melt_archive_codes')
      .select('code').eq('code', code).maybeSingle();
    if (!data) return code;
  }
  throw new Error('Could not generate a unique access code after 10 attempts');
}

async function logActivity(admin, action, target, details) {
  try {
    await supabase().from('admin_activity_log').insert({
      email: admin.email,
      display_name: admin.display_name,
      app: 'archive',
      action, target, details
    });
  } catch (e) { /* best-effort */ }
}

async function handleMint(body, admin) {
  const { folder_id, expires_at, requester_email, request_id } = body;
  if (!folder_id || !expires_at) return jsonResponse(400, { error: 'folder_id and expires_at are required' });

  // 1. Mint shared link on the Box folder
  let folder;
  try {
    folder = await boxClient().folders.update(folder_id, {
      shared_link: {
        access: 'open',
        unshared_at: expires_at,
        permissions: { can_download: true, can_preview: true }
      }
    });
  } catch (e) {
    return jsonResponse(500, { error: 'Box API failed: ' + (e.message || e) });
  }
  const sharedUrl = folder?.shared_link?.url;
  if (!sharedUrl) return jsonResponse(500, { error: 'Box did not return a shared link URL' });

  // 2. Generate unique code
  const code = await generateUniqueCode();

  // 3. Insert codes row
  const { error: insertErr } = await supabase().from('melt_archive_codes').insert({
    code,
    box_folder_id: String(folder_id),
    folder_display_name: folder.name || null,
    shared_link_url: sharedUrl,
    expires_at,
    created_from_request: request_id || null,
    requester_email: requester_email || null,
    status: 'Active'
  });
  if (insertErr) return jsonResponse(500, { error: 'Code insert failed: ' + insertErr.message });

  // 4. Update originating request to Approved (if any)
  if (request_id) {
    await supabase().from('melt_archive_requests').update({
      status: 'Approved',
      approved_by: admin.email,
      approved_at: new Date().toISOString()
    }).eq('id', request_id);
  }

  await logActivity(admin, 'add', `archive_code:${code}`,
    `Approved access to ${folder.name || folder_id} for ${requester_email || 'manual entry'} (expires ${expires_at})`);

  return jsonResponse(200, {
    code,
    folder_id: String(folder_id),
    folder_name: folder.name || null,
    shared_url: sharedUrl,
    expires_at
  });
}

async function handleRevoke(body, admin) {
  const { code } = body;
  if (!code) return jsonResponse(400, { error: 'code is required' });

  const { data: row, error: lookupErr } = await supabase()
    .from('melt_archive_codes').select('*').eq('code', code).maybeSingle();
  if (lookupErr) return jsonResponse(500, { error: 'Lookup failed: ' + lookupErr.message });
  if (!row) return jsonResponse(404, { error: 'Code not found' });

  // Null the shared link on Box (best-effort — even if it fails, mark Revoked)
  let boxOk = false;
  try {
    await boxClient().folders.update(row.box_folder_id, { shared_link: null });
    boxOk = true;
  } catch (e) {
    console.warn('Box revoke failed:', e.message);
  }

  const { error: updErr } = await supabase().from('melt_archive_codes')
    .update({ status: 'Revoked' }).eq('code', code);
  if (updErr) return jsonResponse(500, { error: 'Status update failed: ' + updErr.message });

  await logActivity(admin, 'delete', `archive_code:${code}`,
    `Revoked access to ${row.folder_display_name || row.box_folder_id}${boxOk ? '' : ' (Box link removal failed)'}`);

  return jsonResponse(200, { ok: true, box_revoked: boxOk });
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
    if (body.action === 'mint')   return await handleMint(body, admin);
    if (body.action === 'revoke') return await handleRevoke(body, admin);
    return jsonResponse(400, { error: 'Unknown action — expected "mint" or "revoke"' });
  } catch (e) {
    console.error('box-archive error:', e);
    return jsonResponse(500, { error: 'Internal error: ' + (e.message || e) });
  }
};
