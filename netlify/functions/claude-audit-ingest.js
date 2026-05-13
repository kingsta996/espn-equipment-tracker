/**
 * claude-audit-ingest — Netlify Function that receives Claude Code tool-call
 * events from the http hook chain in Keith's ~/.claude/settings.json and
 * writes them into the claude_audit_events Supabase table.
 *
 * The local file at ~/claude-audit/YYYY-MM-DD.log remains the chain-of-custody
 * source of truth — this endpoint mirrors events to the cloud so the Hub admin
 * pages can render the Claude Audit dashboards.
 *
 * Request shape (one event per POST, what Claude Code sends to http hooks):
 *   POST /.netlify/functions/claude-audit-ingest
 *   Headers: Authorization: Bearer <CLAUDE_AUDIT_INGEST_TOKEN>
 *            x-claude-event: <PreToolUse | PostToolUse | PostToolUseFailure |
 *                             UserPromptSubmit | SessionStart | Stop | Notification>
 *            x-claude-host:  <hostname>
 *            x-claude-user:  <$USER>
 *            x-claude-cwd:   <$PWD>
 *   Body:    { session_id, tool_name?, tool_input?, tool_response?, prompt? }
 *
 * The hook headers carry context the JSON body doesn't (event name, host,
 * cwd) so we don't have to re-template the body per event.
 *
 * Env vars (Netlify):
 *   CLAUDE_AUDIT_INGEST_TOKEN — required. Shared secret matching the
 *                               Authorization header set in settings.json.
 *   SUPABASE_URL              — already configured for this site.
 *   SUPABASE_SERVICE_ROLE_KEY — already configured. Required for inserts
 *                               (the table's RLS allows anon SELECT only).
 *
 * Best-effort design: the response is intentionally minimal and the function
 * never throws to the hook — a failed ingest must not block Keith's session.
 */

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-claude-event, x-claude-host, x-claude-user, x-claude-cwd'
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INGEST_TOKEN = process.env.CLAUDE_AUDIT_INGEST_TOKEN;

const ALLOWED_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'UserPromptSubmit', 'SessionStart', 'Stop', 'Notification'
]);

const MAX_INPUT_CHARS    = 60_000;   // truncate any single JSON field to keep rows bounded
const MAX_RESPONSE_CHARS = 4_000;

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: Object.assign({}, cors, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload)
  };
}

function clampJson(obj, maxChars) {
  if (obj == null) return null;
  const s = JSON.stringify(obj);
  if (s.length <= maxChars) return obj;
  return { _truncated: true, _chars: s.length, preview: s.slice(0, maxChars) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return jsonResponse(405, { error: 'POST only' });

  if (!INGEST_TOKEN) return jsonResponse(503, { error: 'CLAUDE_AUDIT_INGEST_TOKEN not configured' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse(503, { error: 'Supabase not configured' });

  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (auth !== 'Bearer ' + INGEST_TOKEN) return jsonResponse(401, { error: 'Unauthorized' });

  const eventName = String(event.headers?.['x-claude-event'] || '').trim();
  if (!ALLOWED_EVENTS.has(eventName)) {
    return jsonResponse(400, { error: 'Unknown or missing x-claude-event header' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  const nowIso     = new Date().toISOString();
  const sessionId  = body.session_id ? String(body.session_id).slice(0, 128) : null;
  const toolName   = body.tool_name  ? String(body.tool_name).slice(0, 200) : null;
  const cwd        = event.headers?.['x-claude-cwd']  ? String(event.headers['x-claude-cwd']).slice(0, 2000)  : null;
  const host       = event.headers?.['x-claude-host'] ? String(event.headers['x-claude-host']).slice(0, 200)  : null;
  const osUser     = event.headers?.['x-claude-user'] ? String(event.headers['x-claude-user']).slice(0, 200)  : null;

  // Build the input payload by event type.
  let input = null;
  if (eventName === 'UserPromptSubmit') {
    input = { prompt: String(body.prompt || '').slice(0, MAX_INPUT_CHARS) };
  } else if (eventName === 'SessionStart' || eventName === 'Stop') {
    input = null;
  } else if (eventName === 'Notification') {
    input = clampJson(body, MAX_INPUT_CHARS);
  } else {
    input = clampJson(body.tool_input || null, MAX_INPUT_CHARS);
  }

  // Status + response for post-tool events.
  let status   = null;
  let response = null;
  if (eventName === 'PostToolUse')         status = 'success';
  else if (eventName === 'PostToolUseFailure') {
    status   = 'failure';
    response = clampJson(body.tool_response || null, MAX_RESPONSE_CHARS);
  }

  const row = {
    ts: nowIso,
    event: eventName,
    tool: toolName,
    input,
    response,
    status,
    cwd,
    session_id: sessionId,
    host,
    os_user: osUser
  };

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/claude_audit_events', {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) {
      const txt = await r.text();
      return jsonResponse(r.status, { error: 'Supabase insert failed', detail: txt.slice(0, 400) });
    }
    return jsonResponse(204, { ok: true });
  } catch (e) {
    return jsonResponse(500, { error: 'Ingest error', detail: String(e?.message || e) });
  }
};
