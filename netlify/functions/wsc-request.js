/**
 * wsc-request — Netlify Function backing wsc-request.html, the self-service
 * WSC capture request portal for non-admin staff.
 *
 * Three actions, routed by `?action=` query param:
 *
 *   POST ?action=auth
 *     Body: { email, password }
 *     Checks the submitted creds against WSC_REQUEST_USER / WSC_REQUEST_PASSWORD
 *     env vars. On match, returns an HMAC-signed session token (24h TTL).
 *     The shared-login model means no per-user identity — the token just
 *     proves "someone with the password is here." Per-request staff
 *     identity is collected on the form (staff_initials).
 *
 *   POST ?action=submit-roku   (requires Authorization: Bearer <token>)
 *     Body: { encoder_id, search_query, result_index, kickoff_at, trigger_at,
 *             matchup_label, sport }
 *     Inserts a row into wsc_espn_macros using the service-role key. We
 *     don't call wsc_espn_macro_upsert() because that RPC is hard-gated to
 *     kking@conferenceusa.com only — a deliberate guard to keep the macro
 *     scheduler super-admin-only. The Netlify function is the trust
 *     boundary for shared-login staff: it validates the session token,
 *     then writes directly with service-role privileges.
 *
 *   POST ?action=confirm-clipro   (requires Authorization: Bearer <token>)
 *     Body: { macroId, staff_initials, staff_name?, school, opponent,
 *             sport, encoder_id, search_query, result_index, kickoff_at,
 *             trigger_at, notes? }
 *     Inserts a row into wsc_requests, tying the staff identity + Clipro
 *     confirmation to the macro that was created in submit-roku.
 *
 * Env vars (Netlify):
 *   WSC_REQUEST_USER         — required. Shared login email.
 *   WSC_REQUEST_PASSWORD     — required. Shared login password.
 *   WSC_REQUEST_TOKEN_SECRET — required. Random secret used to HMAC session
 *                              tokens (any 32+ char string, e.g.
 *                              `openssl rand -hex 32`).
 *   SUPABASE_URL             — already configured for this site.
 *   SUPABASE_SERVICE_ROLE_KEY — already configured. Required to bypass RLS
 *                              on wsc_espn_macros + wsc_requests inserts.
 */

const crypto = require('crypto');

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type'
};

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: Object.assign({}, cors, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload)
  };
}

function signToken(secret, email, expiresEpoch) {
  const msg = `${email}|${expiresEpoch}`;
  const hmac = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  // Pack as `<base64-email>.<expires>.<hmac>` — newline-free, URL-safe enough
  // for an Authorization header.
  const b64Email = Buffer.from(email, 'utf8').toString('base64url');
  return `${b64Email}.${expiresEpoch}.${hmac}`;
}

function verifyToken(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [b64Email, expiresStr, hmac] = parts;
  let email;
  try { email = Buffer.from(b64Email, 'base64url').toString('utf8'); }
  catch { return null; }
  const expiresEpoch = parseInt(expiresStr, 10);
  if (!Number.isFinite(expiresEpoch)) return null;
  if (Date.now() / 1000 > expiresEpoch) return null;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${email}|${expiresEpoch}`).digest('hex');
  // Constant-time compare to avoid timing leaks.
  const a = Buffer.from(hmac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { email, expiresEpoch };
}

function requireAuth(event) {
  const secret = process.env.WSC_REQUEST_TOKEN_SECRET;
  if (!secret) return { error: jsonResponse(503, { error: 'token secret not configured' }) };
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const claims = verifyToken(secret, token);
  if (!claims) return { error: jsonResponse(401, { error: 'Invalid or expired session' }) };
  return { claims };
}

async function supabaseInsert(table, row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { ok: false, status: 503, detail: 'Supabase not configured' };
  }
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    const txt = await r.text();
    return { ok: false, status: r.status, detail: txt.slice(0, 600) };
  }
  const data = await r.json();
  return { ok: true, row: Array.isArray(data) ? data[0] : data };
}

// ──────────────────────────────────────────────────────────────────────────
// Action handlers
// ──────────────────────────────────────────────────────────────────────────

function actionAuth(body) {
  const expectedUser = process.env.WSC_REQUEST_USER;
  const expectedPass = process.env.WSC_REQUEST_PASSWORD;
  const secret       = process.env.WSC_REQUEST_TOKEN_SECRET;
  if (!expectedUser || !expectedPass || !secret) {
    return jsonResponse(503, { error: 'Portal not configured' });
  }
  const email    = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  // Constant-time-ish compare. Length mismatch is leaked but acceptable
  // here — the shared password isn't a per-user secret.
  const emailMatch = email === expectedUser.trim().toLowerCase();
  const passMatch  = password.length === expectedPass.length &&
    crypto.timingSafeEqual(
      Buffer.from(password.padEnd(expectedPass.length, '\0')),
      Buffer.from(expectedPass.padEnd(expectedPass.length, '\0'))
    );

  if (!emailMatch || !passMatch) {
    // Single error message — don't reveal which field is wrong.
    return jsonResponse(401, { error: 'Invalid email or password' });
  }

  const expiresEpoch = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = signToken(secret, email, expiresEpoch);
  return jsonResponse(200, { token, expiresAt: expiresEpoch * 1000 });
}

async function actionSubmitRoku(body) {
  const encoder_id   = String(body.encoder_id || '').trim();
  const search_query = String(body.search_query || '').trim();
  const result_index = Number.isFinite(body.result_index) ? body.result_index : 0;
  const kickoff_at   = String(body.kickoff_at || '').trim();
  const trigger_at_raw = body.trigger_at ? String(body.trigger_at).trim() : '';
  const matchup_label = body.matchup_label ? String(body.matchup_label).slice(0, 200) : null;
  const sport         = body.sport ? String(body.sport).slice(0, 40) : null;

  // Mirror the constraints from wsc_espn_macros + the RPC.
  if (!/^CUSA([1-9]|10)$/.test(encoder_id)) {
    return jsonResponse(400, { error: `Invalid encoder: ${encoder_id}` });
  }
  if (search_query.length < 1 || search_query.length > 100) {
    return jsonResponse(400, { error: 'Search query must be 1–100 chars' });
  }
  if (result_index < 0 || result_index > 20) {
    return jsonResponse(400, { error: 'Result index must be 0–20' });
  }
  const kickoffMs = Date.parse(kickoff_at);
  if (!Number.isFinite(kickoffMs)) {
    return jsonResponse(400, { error: 'Invalid kickoff time' });
  }
  let triggerIso;
  if (trigger_at_raw) {
    const t = Date.parse(trigger_at_raw);
    if (!Number.isFinite(t)) return jsonResponse(400, { error: 'Invalid trigger time' });
    triggerIso = new Date(t).toISOString();
  } else {
    // Default to kickoff − 4 minutes, matching wsc_espn_macro_upsert.
    triggerIso = new Date(kickoffMs - 4 * 60 * 1000).toISOString();
  }
  const kickoffIso = new Date(kickoffMs).toISOString();

  const row = {
    created_by_email: 'wsc-request@cusa',
    encoder_id,
    search_query,
    result_index,
    trigger_at: triggerIso,
    kickoff_at: kickoffIso,
    sport,
    matchup_label,
    status: 'pending'
  };

  const r = await supabaseInsert('wsc_espn_macros', row);
  if (!r.ok) return jsonResponse(r.status || 500, { error: 'Could not schedule macro', detail: r.detail });
  return jsonResponse(200, {
    macroId: r.row.id,
    encoder_id: r.row.encoder_id,
    trigger_at: r.row.trigger_at,
    kickoff_at: r.row.kickoff_at
  });
}

async function actionConfirmClipro(body) {
  const macroId         = body.macroId    ? String(body.macroId)    : null;
  const dispatchId      = body.dispatchId ? String(body.dispatchId) : null;
  const staff_initials  = String(body.staff_initials || '').trim().slice(0, 12);
  const staff_name      = body.staff_name ? String(body.staff_name).slice(0, 120) : null;
  const school          = String(body.school   || '').trim().slice(0, 80);
  const opponent        = String(body.opponent || '').trim().slice(0, 80);
  const sport           = body.sport ? String(body.sport).trim().slice(0, 40) : null;
  const encoder_id      = body.encoder_id ? String(body.encoder_id).trim() : null;
  const search_query    = body.search_query ? String(body.search_query).slice(0, 100) : null;
  const result_index    = Number.isFinite(body.result_index) ? body.result_index : null;
  const kickoff_at      = String(body.kickoff_at || '').trim();
  const trigger_at_raw  = body.trigger_at ? String(body.trigger_at).trim() : '';
  const notes           = body.notes ? String(body.notes).slice(0, 500) : null;

  if (!staff_initials) return jsonResponse(400, { error: 'Staff initials required' });
  if (!school)         return jsonResponse(400, { error: 'School required' });
  if (!opponent)       return jsonResponse(400, { error: 'Opponent required' });
  if (!macroId && !dispatchId) {
    return jsonResponse(400, { error: 'macroId or dispatchId required' });
  }
  // Encoder is only required for the legacy Roku path. Laptop dispatches
  // identify the laptop via dispatchId / dispatches table.
  if (encoder_id && !/^CUSA([1-9]|10)$/.test(encoder_id)) {
    return jsonResponse(400, { error: 'Invalid encoder' });
  }
  // wsc_requests.encoder_id is NOT NULL with a CUSA-only CHECK at the
  // moment. For laptop dispatches we stash the laptop_id label in that
  // column so admin views still have something to show — but only if
  // the schema allows. If you'd rather keep encoder_id strict, add a
  // separate migration to drop the CHECK; for now we require the form
  // to pass *some* encoder_id (real or 'CUSA1' placeholder) only for
  // legacy Roku requests, and we accept laptop dispatches without one.
  const kickoffMs = Date.parse(kickoff_at);
  if (!Number.isFinite(kickoffMs)) return jsonResponse(400, { error: 'Invalid kickoff time' });

  const row = {
    staff_initials,
    staff_name,
    school,
    opponent,
    sport,
    espn_macro_id:      macroId,
    laptop_dispatch_id: dispatchId,
    encoder_id:         encoder_id || null,
    search_query,
    result_index,
    kickoff_at: new Date(kickoffMs).toISOString(),
    trigger_at: trigger_at_raw ? new Date(Date.parse(trigger_at_raw)).toISOString() : null,
    notes
  };

  const r = await supabaseInsert('wsc_requests', row);
  if (!r.ok) return jsonResponse(r.status || 500, { error: 'Could not log request', detail: r.detail });
  return jsonResponse(200, { requestId: r.row.id, created_at: r.row.created_at });
}

async function actionSubmitLaptop(body) {
  const laptop_id    = String(body.laptop_id || '').trim();
  const launch_url   = String(body.launch_url || '').trim();
  const kickoff_at   = String(body.kickoff_at || '').trim();
  const trigger_at_raw = body.trigger_at ? String(body.trigger_at).trim() : '';
  const matchup_label = body.matchup_label ? String(body.matchup_label).slice(0, 200) : null;
  const sport         = body.sport ? String(body.sport).slice(0, 40) : null;
  const espn_event_id = body.espn_event_id ? String(body.espn_event_id).slice(0, 80) : null;
  const notes         = body.notes ? String(body.notes).slice(0, 500) : null;

  if (laptop_id !== 'LAPTOP-A' && laptop_id !== 'LAPTOP-B') {
    return jsonResponse(400, { error: `Invalid laptop: ${laptop_id}` });
  }
  if (!/^https?:\/\//i.test(launch_url) || launch_url.length > 2000) {
    return jsonResponse(400, { error: 'launch_url must be a valid http(s) URL (≤ 2000 chars)' });
  }
  const kickoffMs = Date.parse(kickoff_at);
  if (!Number.isFinite(kickoffMs)) {
    return jsonResponse(400, { error: 'Invalid kickoff time' });
  }
  let triggerIso;
  if (trigger_at_raw) {
    const t = Date.parse(trigger_at_raw);
    if (!Number.isFinite(t)) return jsonResponse(400, { error: 'Invalid trigger time' });
    triggerIso = new Date(t).toISOString();
  } else {
    // Default trigger: kickoff − 4 minutes, matching the Roku macro path.
    triggerIso = new Date(kickoffMs - 4 * 60 * 1000).toISOString();
  }
  const kickoffIso = new Date(kickoffMs).toISOString();

  const row = {
    created_by_email: 'wsc-request@cusa',
    laptop_id,
    launch_url,
    trigger_at: triggerIso,
    kickoff_at: kickoffIso,
    matchup_label,
    sport,
    espn_event_id,
    notes,
    status: 'pending'
  };

  const r = await supabaseInsert('wsc_laptop_dispatches', row);
  if (!r.ok) return jsonResponse(r.status || 500, { error: 'Could not schedule dispatch', detail: r.detail });
  return jsonResponse(200, {
    dispatchId: r.row.id,
    laptop_id:  r.row.laptop_id,
    launch_url: r.row.launch_url,
    trigger_at: r.row.trigger_at,
    kickoff_at: r.row.kickoff_at
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Entry
// ──────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return jsonResponse(405, { error: 'POST only' });

  const action = (event.queryStringParameters?.action || '').trim();

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  if (action === 'auth') {
    return actionAuth(body);
  }

  // All other actions require a valid session token.
  const auth = requireAuth(event);
  if (auth.error) return auth.error;

  if (action === 'submit-roku')    return await actionSubmitRoku(body);
  if (action === 'submit-laptop')  return await actionSubmitLaptop(body);
  if (action === 'confirm-clipro') return await actionConfirmClipro(body);

  return jsonResponse(400, { error: `Unknown action: ${action}` });
};
