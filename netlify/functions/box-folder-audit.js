/**
 * box-folder-audit — scan the Box destination folders that back our File
 * Request URLs and flag uploads that bypassed the request (i.e. files where
 * created_by != folder owner). Used by /box-audit.html and a weekly digest.
 *
 * Folders are sourced from two Supabase tables:
 *   melt_config              — per-sport regular-season broadcast melts
 *   championship_box_links   — per-sport (+ optional subcategory) championship uploads
 * Each row must have a non-empty folder_id for it to be audited.
 *
 * Bypass detection (primary signal):
 *   A File Request upload arrives in Box as if the folder owner uploaded it,
 *   so created_by.login == folder.owned_by.login. A collaborator dragging a
 *   file directly into the folder shows up as the collaborator. We flag any
 *   item whose created_by.login does NOT match the folder owner (or the
 *   known-owner allowlist below as a safety net for sub-account ownership).
 *
 * Move-into-folder detection (best-effort secondary):
 *   We attempt the Box Enterprise Events API for ITEM_MOVE / ITEM_COPY
 *   events targeting our audit folders. If the JWT app doesn't have the
 *   admin-logs scope this fails 403; we report `events_available: false`
 *   per folder and let the UI surface the limitation.
 *
 * Pending overdue (melts only):
 *   Cross-references schedule_events + melt_uploads to surface events older
 *   than the audit window that still have no upload tracker row.
 *
 * Auth:
 *   Same pattern as box-archive.js — X-Admin-Email + X-Admin-Pw-Hash.
 *   The scheduled GitHub Action will send X-Audit-Secret matching
 *   AUDIT_DIGEST_SECRET env var to bypass interactive auth.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, BOX_CONFIG_JSON
 *   AUDIT_DIGEST_SECRET (optional, for the scheduled digest)
 *   AUDIT_KNOWN_OWNERS  (optional, comma-separated owner emails;
 *                        defaults to kking@conferenceusa.com)
 */

const BoxSDK = require('box-node-sdk');
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-admin-email, x-admin-pw-hash, x-audit-secret'
};

const ITEM_FIELDS = [
  'name', 'size', 'type',
  'created_at', 'modified_at', 'content_modified_at',
  'created_by', 'modified_by',
  'parent', 'description', 'item_status',
  'file_version'
].join(',');

const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'mxf', 'avi', 'wmv', 'mkv', 'ts', 'mts', 'm2ts']);

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

function knownOwners() {
  const raw = process.env.AUDIT_KNOWN_OWNERS || 'kking@conferenceusa.com';
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

async function verifyCaller(event) {
  // Scheduled-digest path: shared secret in header.
  const secret = (event.headers['x-audit-secret'] || event.headers['X-Audit-Secret'] || '').trim();
  if (secret && process.env.AUDIT_DIGEST_SECRET && secret === process.env.AUDIT_DIGEST_SECRET) {
    return { email: 'audit-digest@system', display_name: 'Scheduled digest', via: 'secret' };
  }

  // Interactive admin path: email + hash matched against admin_users.
  const email = (event.headers['x-admin-email'] || event.headers['X-Admin-Email'] || '').toLowerCase().trim();
  const hash  = (event.headers['x-admin-pw-hash'] || event.headers['X-Admin-Pw-Hash'] || '').trim();
  if (!email || !hash) return null;
  const { data, error } = await supabase()
    .from('admin_users')
    .select('email, pw_hash, display_name, is_active')
    .eq('email', email)
    .maybeSingle();
  if (error || !data || !data.is_active || data.pw_hash !== hash) return null;
  return { email: data.email, display_name: data.display_name || data.email, via: 'admin' };
}

/* ── Source loading ─────────────────────────────────────────────────── */

async function loadAuditSources() {
  // melt_config rows
  const meltRes = await supabase()
    .from('melt_config')
    .select('sport, file_request_url, folder_id')
    .not('folder_id', 'is', null);
  if (meltRes.error) throw new Error('melt_config load: ' + meltRes.error.message);

  // championship_box_links rows
  const champRes = await supabase()
    .from('championship_box_links')
    .select('id, sport, label, subcategory, url, folder_id')
    .not('folder_id', 'is', null);
  if (champRes.error) throw new Error('championship_box_links load: ' + champRes.error.message);

  const sources = [];
  (meltRes.data || []).forEach(r => {
    const fid = (r.folder_id || '').trim();
    if (!fid) return;
    sources.push({
      source: 'melt',
      sport: r.sport,
      label: `${r.sport} Melts`,
      subcategory: null,
      folder_id: fid,
      request_url: r.file_request_url || null
    });
  });
  (champRes.data || []).forEach(r => {
    const fid = (r.folder_id || '').trim();
    if (!fid) return;
    sources.push({
      source: 'championship',
      sport: r.sport,
      label: r.label,
      subcategory: r.subcategory || null,
      folder_id: fid,
      request_url: r.url || null
    });
  });
  return sources;
}

/* ── Box helpers ────────────────────────────────────────────────────── */

async function getFolderOwner(client, folderId) {
  try {
    const f = await client.folders.get(folderId, { fields: 'owned_by' });
    return (f && f.owned_by && f.owned_by.login) ? f.owned_by.login.toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

async function listFolderItems(client, folderId, sinceMs) {
  const items = [];
  const LIMIT = 1000;
  let offset = 0;
  for (let page = 0; page < 10; page++) {   // hard cap 10k items per folder
    let res;
    try {
      res = await client.folders.getItems(folderId, { fields: ITEM_FIELDS, limit: LIMIT, offset });
    } catch (e) {
      throw new Error('listItems(' + folderId + '): ' + (e.message || e));
    }
    const entries = (res && res.entries) || [];
    for (const it of entries) {
      if (it.type !== 'file') continue;
      // Skip stuff older than the audit window — keeps the payload small.
      const createdMs = it.created_at ? Date.parse(it.created_at) : 0;
      const modifiedMs = it.modified_at ? Date.parse(it.modified_at) : createdMs;
      if (Math.max(createdMs, modifiedMs) < sinceMs) continue;
      items.push(it);
    }
    if (entries.length < LIMIT) break;
    offset += LIMIT;
  }
  return items;
}

async function tryFetchMoveEvents(client, sinceIso, folderIds) {
  // Returns a Map<file_id, true> for files that appeared in our audit
  // folders via a MOVE/COPY (not a direct upload). Best-effort: if the JWT
  // app doesn't have admin-logs scope, returns null and the UI knows move
  // detection isn't available.
  try {
    const events = await client.events.getEnterpriseEvents({
      stream_type: 'admin_logs',
      event_type:  'ITEM_MOVE,ITEM_COPY',
      created_after: sinceIso,
      limit: 500
    });
    const out = new Map();
    const folderSet = new Set(folderIds.map(String));
    for (const ev of (events && events.entries) || []) {
      // ev.source = the moved/copied item. ev.additional_details may have
      // parent info. For ITEM_MOVE, ev.source.parent is the new parent.
      const newParent = ev.source && ev.source.parent && ev.source.parent.id;
      if (!newParent || !folderSet.has(String(newParent))) continue;
      const fid = ev.source && ev.source.id;
      if (fid) out.set(String(fid), ev.event_type);
    }
    return { ok: true, map: out };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

/* ── Pending-overdue cross-reference (melts only) ───────────────────── */

async function loadPendingOverdue(sinceIso) {
  // schedule_events past their event_date and older than the audit window
  // that still don't have a melt_uploads row.
  const cutoff = new Date(sinceIso);
  const cutoffYmd = cutoff.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  try {
    const sched = await supabase().from('schedule_events')
      .select('id, sport, season, event_date, home, away')
      .lt('event_date', today)
      .gte('event_date', cutoffYmd)
      .limit(2000);
    if (sched.error) throw sched.error;
    const events = sched.data || [];
    if (!events.length) return [];
    const ids = events.map(e => e.id);
    const ups = await supabase().from('melt_uploads').select('schedule_event_id').in('schedule_event_id', ids);
    if (ups.error) throw ups.error;
    const have = new Set((ups.data || []).map(r => r.schedule_event_id));
    const todayMs = Date.parse(today + 'T00:00:00Z');
    return events
      .filter(e => !have.has(e.id))
      .map(e => ({
        source: 'melt',
        sport: e.sport,
        event_id: e.id,
        event_date: e.event_date,
        home: e.home, away: e.away,
        days_overdue: Math.max(0, Math.round((todayMs - Date.parse(e.event_date + 'T00:00:00Z')) / 86400000))
      }))
      .sort((a, b) => b.days_overdue - a.days_overdue);
  } catch (e) {
    // schedule_events / melt_uploads may not exist on every deploy.
    return [];
  }
}

/* ── Handler ────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return jsonResponse(405, { error: 'POST only' });

  const caller = await verifyCaller(event);
  if (!caller) return jsonResponse(401, { error: 'Unauthorized' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { error: 'Invalid JSON' }); }

  const days = Math.max(1, Math.min(90, Number(body.days) || 7));
  const sinceMs = Date.now() - days * 86400000;
  const sinceIso = new Date(sinceMs).toISOString();
  const sourceFilter = String(body.source || 'all').toLowerCase();   // 'all' | 'melt' | 'championship'

  let sources;
  try { sources = await loadAuditSources(); }
  catch (e) { return jsonResponse(500, { error: 'Could not load audit sources', detail: String(e.message || e) }); }
  if (sourceFilter !== 'all') sources = sources.filter(s => s.source === sourceFilter);

  const owners = knownOwners();
  const client = boxClient();

  // Pre-resolve each folder's owner once.
  const folderIds = Array.from(new Set(sources.map(s => s.folder_id)));
  const moveLookup = await tryFetchMoveEvents(client, sinceIso, folderIds);

  const ownerByFolder = {};
  await Promise.all(folderIds.map(async fid => {
    const o = await getFolderOwner(client, fid);
    if (o) {
      ownerByFolder[fid] = o;
      owners.add(o);
    }
  }));

  const folders = [];
  const files = [];

  for (const src of sources) {
    const folderInfo = {
      source: src.source,
      sport: src.sport,
      label: src.label,
      subcategory: src.subcategory,
      folder_id: src.folder_id,
      folder_owner: ownerByFolder[src.folder_id] || null,
      file_count: 0,
      bypass_count: 0,
      move_count: 0,
      events_available: !!(moveLookup && moveLookup.ok),
      error: null
    };
    let items;
    try {
      items = await listFolderItems(client, src.folder_id, sinceMs);
    } catch (e) {
      folderInfo.error = String(e.message || e).slice(0, 300);
      folders.push(folderInfo);
      continue;
    }
    folderInfo.file_count = items.length;
    for (const it of items) {
      const createdBy = (it.created_by && it.created_by.login || '').toLowerCase();
      const createdByName = (it.created_by && it.created_by.name) || createdBy;
      const isBypass = createdBy && !owners.has(createdBy);
      const moveType = moveLookup && moveLookup.ok ? moveLookup.map.get(String(it.id)) : null;
      const isMove = !!moveType;
      const ext = (it.name || '').split('.').pop().toLowerCase();
      const isNonVideo = ext && !VIDEO_EXTS.has(ext);
      const flags = [];
      if (isBypass) flags.push('BYPASS');
      if (isMove)   flags.push(moveType === 'ITEM_COPY' ? 'COPIED' : 'MOVED');
      if (isNonVideo) flags.push('NON_VIDEO');

      if (isBypass) folderInfo.bypass_count++;
      if (isMove)   folderInfo.move_count++;

      files.push({
        source:           src.source,
        sport:            src.sport,
        label:            src.label,
        subcategory:      src.subcategory,
        folder_id:        src.folder_id,
        file_id:          it.id,
        filename:         it.name,
        size_bytes:       it.size || 0,
        created_at:       it.created_at,
        modified_at:      it.modified_at,
        content_modified_at: it.content_modified_at || null,
        created_by_email: createdBy || null,
        created_by_name:  createdByName,
        is_bypass:        isBypass,
        is_moved:         isMove,
        is_non_video:     isNonVideo,
        flags
      });
    }
    folders.push(folderInfo);
  }

  // Sort files: bypasses first, then most recent first.
  files.sort((a, b) => {
    if (a.is_bypass !== b.is_bypass) return a.is_bypass ? -1 : 1;
    return String(b.modified_at || b.created_at || '').localeCompare(String(a.modified_at || a.created_at || ''));
  });

  const pendingOverdue = (sourceFilter !== 'championship') ? await loadPendingOverdue(sinceIso) : [];

  // Best-effort log
  try {
    await supabase().from('admin_activity_log').insert({
      admin_email: caller.email,
      action: 'box_audit_run',
      target: `since=${sinceIso} source=${sourceFilter} folders=${folders.length}`,
      details: `files=${files.length} bypasses=${files.filter(f => f.is_bypass).length}`
    });
  } catch (_) { /* table may not exist on every deploy */ }

  return jsonResponse(200, {
    ok: true,
    generated_at: new Date().toISOString(),
    since_iso: sinceIso,
    days,
    source_filter: sourceFilter,
    owners: Array.from(owners),
    move_events_available: !!(moveLookup && moveLookup.ok),
    move_events_error: moveLookup && !moveLookup.ok ? moveLookup.error : null,
    folders,
    files,
    pending_overdue: pendingOverdue,
    summary: {
      folders_total:   folders.length,
      folders_errored: folders.filter(f => f.error).length,
      files_total:     files.length,
      bypass_total:    files.filter(f => f.is_bypass).length,
      move_total:      files.filter(f => f.is_moved).length,
      pending_total:   pendingOverdue.length
    }
  });
};
