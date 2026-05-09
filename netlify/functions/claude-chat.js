/**
 * claude-chat — Netlify Function that proxies a chat request to Anthropic's
 * Claude API. Used by the "Chat with Support" widget on hub.html.
 *
 * Side effects:
 *   • Fetches active chat_faq entries (app='production_hub' OR 'both') from
 *     Supabase and injects them into the system prompt so Claude can refer
 *     redundant questions back to the FAQ via [FAQ:slug] markers.
 *   • Logs every turn to chat_logs (with the caller's email/role as supplied
 *     by the front-end localStorage user object — best-effort, not trusted).
 *
 * Env vars (Netlify):
 *   ANTHROPIC_API_KEY  — required. Console: console.anthropic.com → API Keys.
 *   CLAUDE_CHAT_MODEL  — optional. Defaults to claude-sonnet-4-6.
 *   SUPABASE_URL       — already configured for this site.
 *   SUPABASE_ANON_KEY  — already configured (writes use the public RLS policy).
 *   CHAT_ALLOWED_HOSTS — optional comma-separated extra hosts.
 *
 * Safety / abuse mitigation:
 *   - Referer-origin check pinned to known Hub domains (Netlify + localhost).
 *   - max_tokens capped at 1500 server-side; user input clipped.
 *   - Prompt caching on the system prompt keeps per-turn cost low.
 *   - System prompt instructs Claude to escalate destructive/code-level
 *     work to Keith rather than attempting it.
 */

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const MODEL = process.env.CLAUDE_CHAT_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const MAX_USER_CHARS = 6000;
const MAX_HISTORY = 20;
const APP_KEY = 'production_hub';

// Accept any *.netlify.app host plus localhost. To allow a custom domain
// later, set CHAT_ALLOWED_HOSTS in Netlify (comma-separated, e.g.
// "cusa-tools.com,staging.cusa-tools.com").
const ALLOWED_HOST_SUFFIXES = [
  'netlify.app',
  'localhost',
  ...(process.env.CHAT_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
];

const SYSTEM_PROMPT = `You are the CUSA × ESPN Production Hub support assistant. You help conference staff and school operators diagnose and resolve issues with the Production Hub web tools. You are embedded in a chat widget on the Production Hub home page.

# About the Hub

The Production Hub is a Netlify-hosted set of internal web tools maintained by Keith King (kking@conferenceusa.com). It runs on vanilla HTML/JS pages backed by Supabase, with a handful of Netlify Functions for proxies (Box uploads, CORS-safe fetches, Google Sheets ingest). Source repo: espn-equipment-tracker.

# Pages / tools

- Production Hub home (hub.html) — landing page with cards linking to each tool.
- Production Compliance (compliance.html) — equipment tracking and ESPN standards compliance across CUSA member schools. Per-school login.
- Commercials (commercials.html) — ESPN+ commercial formats, ad schedule, FFmpeg slate builder. Box-backed uploads.
- Viewership Tracker (viewership.html) — ESPN+ DTC viewership data by sport/school/period.
- Schedule Submissions (schedule.html) — School submissions for the ESPN broadcast schedule. Uses _TITLE.xlsx template.
- Xpression Hub (xpression-hub.html) — Master Roster + Master Schedule generators for ESPN Xpression production templates.
- Broadcast Melts (melts.html) — Filename builder + Box File Request links for melt uploads.
- Melt Archive (archive.html) — Browse historical Box game folders by access code.
- Highlight Request (highlight.html) — Admin-only automated player highlights from Box film.
- WSC Capture Portal (wsc-portal.html) — Master Schedule (Tata SRT) + Manual Capture for WSC AI clipping. Per-school + admin login. Tabs: Master Schedule, Manual Capture, WSC Stream Sheet, Multiviewer (super/Tata only), Settings (super only).

# Common issues + fixes you can walk users through

- Login won't accept password → confirm correct case-insensitive email; password resets go to Keith.
- Page seems blank or "Not Authorized" → admin sessions live in localStorage; sign in again from the gate page.
- Stats / schedule data looks stale → most pages cache 60s; hard-refresh (Cmd+Shift+R) usually clears it.
- Broken iframe / blank Google Sheet embed → sheet share permissions need to be "Anyone with the link → Viewer/Editor".
- WSC encoder dropdown won't gray out a conflict → conflict logic uses event_date + event_time on a 4-hour window. If event_time is missing or unparseable it falls back to same-day-only conflict.
- WSC encoder save fails on a SHSU baseball/soccer/VB row → those are external (Sidearm-scraped) events; the wsc_capture_status table now stores text IDs (migration wsc_capture_event_id_text.sql).

# Behavior rules

- Be concise. One or two short paragraphs unless the user asks for detail.
- Diagnose first: ask one or two clarifying questions if the issue isn't clear (which page, what they were doing, what they saw).
- Walk users through small, safe self-service steps: hard-refresh, sign out + back in, clear localStorage for one key, try a different browser, re-upload the file, check share permissions, etc.
- If the issue requires a CODE change, SCHEMA change, CREDENTIAL change, NEW DEPLOY, or anything that affects multiple users / production data: STOP. Summarize the issue clearly in one short paragraph, then say:
    "This needs Keith — please email kking@conferenceusa.com and paste the description above."
  Do not attempt to walk the user through editing files, running SQL, or pushing code themselves.
- Never claim to be making code changes — you are in a chat box and cannot edit the repo, run migrations, or deploy.
- Never ask for or echo passwords, API keys, or session tokens. If a user pastes credentials, tell them not to and to send them privately to Keith.
- If you don't know the answer with reasonable confidence, say so and escalate to Keith rather than guessing.
- If the user is upset or stuck, acknowledge the friction briefly, then move to action.

# FAQ referrals

You will receive a list of curated FAQ entries below (under "AVAILABLE FAQ"). When the user's question matches an FAQ entry well, point them to it explicitly using this exact marker syntax (one per line, no extra punctuation):

  [FAQ:slug-of-the-entry]

The Hub front-end will turn that marker into a clickable link to /faq.html#slug. Use the marker for repeat / well-known issues that already have a curated answer; you can still add a one-line summary alongside it. If no FAQ matches, just answer normally.

# Tone

Professional, calm, broadcast-ops-aware. The users you'll talk to are mostly school AV/broadcast staff and CUSA conference staff under deadline pressure. Get them unblocked fast.`;

/* ── Supabase REST helpers (no SDK to keep cold-start small) ────────── */

async function supabaseGet(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json'
    }
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function supabasePost(path, payload) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(payload)
    });
  } catch (_) { /* swallow — logging is best-effort */ }
}

async function loadActiveFaq() {
  // Active entries scoped to this app or marked 'both'. Cap at 60 entries
  // to keep the prompt bounded; sort_order then created_at asc.
  const path = `chat_faq?select=slug,app,category,question,answer,keywords&is_active=eq.true&app=in.(${APP_KEY},both)&order=sort_order.asc,created_at.asc&limit=60`;
  return (await supabaseGet(path)) || [];
}

function faqContextBlock(faq) {
  if (!faq.length) return 'AVAILABLE FAQ\n(no curated entries yet)';
  const lines = ['AVAILABLE FAQ — refer with [FAQ:slug] when relevant:'];
  for (const f of faq) {
    const cat = f.category ? ` (${f.category})` : '';
    const kw  = (f.keywords && f.keywords.length) ? `\n  keywords: ${f.keywords.join(', ')}` : '';
    // Trim each answer to ~400 chars in the prompt; full text lives in faq.html.
    const ans = String(f.answer || '').replace(/\s+/g, ' ').slice(0, 400);
    lines.push(`- [FAQ:${f.slug}]${cat} ${f.question}${kw}\n  summary: ${ans}`);
  }
  return lines.join('\n');
}

function extractFaqMarkers(text) {
  const out = new Set();
  const re = /\[FAQ:([a-z0-9][a-z0-9-_]+)\]/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(m[1].toLowerCase());
  return Array.from(out);
}

function originAllowed(event) {
  const ref = event.headers?.referer || event.headers?.referrer || '';
  const origin = event.headers?.origin || '';
  const probe = ref || origin;
  if (!probe) return false;
  try {
    const host = new URL(probe).host.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some(suffix =>
      host === suffix || host.endsWith('.' + suffix) || host.startsWith(suffix + ':')
    );
  } catch {
    return false;
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: Object.assign({}, cors, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return jsonResponse(405, { error: 'POST only' });

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse(503, {
      error: 'Chat is not configured yet — ANTHROPIC_API_KEY is missing in Netlify env. Please reach out to Keith (kking@conferenceusa.com).'
    });
  }
  if (!originAllowed(event)) {
    return jsonResponse(403, { error: 'Origin not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON' }); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return jsonResponse(400, { error: 'messages[] required' });

  const trimmed = messages.slice(-MAX_HISTORY).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, MAX_USER_CHARS)
  })).filter(m => m.content.trim().length > 0);

  if (!trimmed.length) return jsonResponse(400, { error: 'no usable content in messages' });

  // Caller-provided user (best-effort, from localStorage on the front-end).
  const u = (body.user && typeof body.user === 'object') ? body.user : {};
  const userEmail   = u.email ? String(u.email).slice(0, 200).toLowerCase() : null;
  const userDisplay = u.display_name ? String(u.display_name).slice(0, 120) : null;
  const userRole    = u.role ? String(u.role).slice(0, 32) : null;
  const conversationId = body.conversation_id ? String(body.conversation_id).slice(0, 64) : null;

  const lastUserMsg = trimmed.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

  // Pull FAQ context concurrently with assembling the request.
  const faqList = await loadActiveFaq();
  const systemPrompt = SYSTEM_PROMPT + '\n\n' + faqContextBlock(faqList);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':     'application/json',
        'x-api-key':        ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:       MODEL,
        max_tokens:  MAX_TOKENS,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ],
        messages: trimmed
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      await supabasePost('chat_logs', {
        app: APP_KEY,
        conversation_id: conversationId,
        message_index: trimmed.length - 1,
        user_email: userEmail,
        user_display_name: userDisplay,
        user_role: userRole,
        user_message: lastUserMsg,
        assistant_reply: null,
        model: MODEL,
        faq_slugs_referenced: null
      });
      return jsonResponse(r.status, {
        error: 'Anthropic API error',
        detail: txt.slice(0, 600)
      });
    }
    const data = await r.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    const referencedSlugs = extractFaqMarkers(reply);

    await supabasePost('chat_logs', {
      app: APP_KEY,
      conversation_id: conversationId,
      message_index: trimmed.length - 1,
      user_email: userEmail,
      user_display_name: userDisplay,
      user_role: userRole,
      user_message: lastUserMsg,
      assistant_reply: reply,
      model: data.model || MODEL,
      input_tokens:        data.usage?.input_tokens ?? null,
      output_tokens:       data.usage?.output_tokens ?? null,
      cache_read_tokens:   data.usage?.cache_read_input_tokens ?? null,
      cache_creation_tokens: data.usage?.cache_creation_input_tokens ?? null,
      faq_slugs_referenced: referencedSlugs.length ? referencedSlugs : null
    });

    return jsonResponse(200, {
      reply,
      faq_slugs: referencedSlugs,
      usage: data.usage,
      stop_reason: data.stop_reason,
      model: data.model
    });
  } catch (e) {
    return jsonResponse(500, {
      error: 'Function error',
      detail: String(e?.message || e)
    });
  }
};
