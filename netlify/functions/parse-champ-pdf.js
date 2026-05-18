/**
 * parse-champ-pdf — turns a CBSSN championship format PDF into the same
 * structured JSON the XLSX template produces, so the Championships tab on
 * commercials.html can render the segment table for sports where the
 * network ships a PDF instead of a spreadsheet.
 *
 * Request body (JSON):
 *   {
 *     sport_key:   'baseball' | 'football' | 'mens_basketball' | 'womens_basketball' | 'softball',
 *     sport_name:  'Baseball' (optional, for the prompt),
 *     filename:    'CUSA_Baseball_Championship.pdf',
 *     pdf_base64:  '<base64 PDF, NOT data: prefixed>'
 *   }
 *
 * Response: { ok: true, parsed: { name, meta, segments, floaters, notes } }
 *
 * Auth: X-Admin-Pw-Hash header must match ADMIN_PW_HASH (same legacy hash
 * used everywhere in commercials.html). Belt-and-suspenders origin check
 * pinned to *.netlify.app + localhost.
 *
 * Env (Netlify):
 *   ANTHROPIC_API_KEY  — required. Already set for claude-chat.js.
 *   CLAUDE_CHAT_MODEL  — optional. Defaults to claude-sonnet-4-6.
 *   CHAT_ALLOWED_HOSTS — optional. Comma-separated extra hosts.
 */

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-admin-pw-hash'
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_CHAT_MODEL || 'claude-sonnet-4-6';
// Mirrors the ADMIN_PW_HASH constant baked into commercials.html — the
// legacy admin password's SHA-256 hex. Anyone hitting this function must
// be authenticated as that admin in the browser already.
const ADMIN_PW_HASH = '9a874f8b06ebb0eb63336db78b70ca149513a237de8395d8e858ee8f0c702ae2';

const ALLOWED_HOST_SUFFIXES = [
  'netlify.app',
  'localhost',
  ...(process.env.CHAT_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
];

const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MB — well over a typical format PDF.

const SYSTEM_PROMPT = `You extract CBS Sports Network (CBSSN) championship broadcast format data from PDFs into strict JSON. The output is consumed by the CUSA Commercials Hub Championships tab, which renders a segment-by-segment timing table identical to its other championship formats.

Return ONLY valid JSON matching this exact shape (no commentary, no Markdown code fences):

{
  "name": "<short sport name, e.g. 'Baseball'>",
  "meta": {
    "YEAR":      "<season or air year, e.g. '2025-26'>",
    "NETWORK":   "CBS Sports Network",
    "SPORT":     "<full event name, e.g. 'CUSA Baseball Championship'>",
    "FORMAT_ID": "<network format id or '—' if not in PDF>",
    "AIR_DATE":  "<air date string from PDF, omit the field entirely if not present>"
  },
  "segments": [
    { "num": 1, "name": "<segment name>", "brk": "<break label/number>", "dur": "<MM:SS>", "local": "<MM:SS or omit>", "psa": "<MM:SS or omit>" }
  ],
  "floaters": [
    { "letter": "<A/B/C>", "dur": "<MM:SS>", "note": "<short note>" }
  ],
  "notes": [
    { "title": "<rule title>", "body": "<rule body>" }
  ]
}

Hard rules:
- Output strict JSON only. No prose. No code fences. No trailing commas.
- "segments" is a flat ordered list of every break/segment in the PDF, numbered consecutively from 1.
- For wrap-up / close / sign-off segments with no commercial, leave "dur" as an empty string and omit "brk" if absent.
- Time format must be MM:SS (e.g. "1:30", "2:00"). Drop a leading zero on minutes.
- Omit "local" or "psa" fields when the PDF does not specify them for that break.
- If the PDF has no floaters or notes, return empty arrays — never null.
- If a required field is genuinely missing, use "—" rather than guessing.
- Preserve the network's exact segment names (e.g. "Top of 1st", "Halftime", "Mid 3rd Quarter"). Do not paraphrase.

Reference shape (CUSA Softball Championship — use as a structural template, not the literal data):

{
  "name": "Softball",
  "meta": { "YEAR": "2026", "NETWORK": "CBS Sports Network", "SPORT": "CUSA Softball Championship", "FORMAT_ID": "CUSASOF2024", "AIR_DATE": "Sat May 09, 2026 · 12:00–2:00 PM ET" },
  "segments": [
    { "num": 1,  "name": "Open",           "brk": "1",  "dur": "2:00", "local": "1:30" },
    { "num": 2,  "name": "Top of 1st",     "brk": "2",  "dur": "1:00" },
    { "num": 6,  "name": "Top of 3rd",     "brk": "6",  "dur": "1:45", "local": "1:30" },
    { "num": 16, "name": "Wrap-up / Close","brk": "",   "dur": "" }
  ],
  "floaters": [
    { "letter": "A", "dur": "0:30", "note": "Floater A" }
  ],
  "notes": [
    { "title": "Bottom of 7th Not Played", "body": "If the bottom of the 7th is not played, breaks 14 and 15 combine for a 3:00 break." }
  ]
}`;

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: Object.assign({}, cors, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload)
  };
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

// Be liberal in what we accept from the model — strip ```json fences,
// leading prose, trailing commas — but the prompt asks for strict JSON
// so this is just a safety net.
function extractJsonObject(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.indexOf('{');
  const last  = t.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  let candidate = t.slice(first, last + 1);
  // Remove trailing commas before } or ].
  candidate = candidate.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(candidate); }
  catch { return null; }
}

function validateParsed(j) {
  if (!j || typeof j !== 'object') return 'response is not an object';
  if (typeof j.name !== 'string' || !j.name.trim()) return 'missing name';
  if (!j.meta || typeof j.meta !== 'object') return 'missing meta object';
  if (!Array.isArray(j.segments)) return 'segments must be an array';
  if (!j.segments.length) return 'segments is empty — PDF parse failed';
  // Normalise floaters/notes to arrays.
  if (!Array.isArray(j.floaters)) j.floaters = [];
  if (!Array.isArray(j.notes))    j.notes    = [];
  // Each segment must at least have name + dur fields (dur may be empty for
  // wrap-ups). num should be sequential; if missing, fill it in.
  j.segments.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    if (typeof s.num !== 'number' || !Number.isFinite(s.num)) s.num = i + 1;
    s.brk  = s.brk  != null ? String(s.brk)  : '';
    s.dur  = s.dur  != null ? String(s.dur)  : '';
    s.name = s.name != null ? String(s.name) : '';
    if (s.local != null) s.local = String(s.local);
    if (s.psa   != null) s.psa   = String(s.psa);
  });
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return jsonResponse(405, { ok: false, error: 'POST only' });

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse(503, { ok: false, error: 'ANTHROPIC_API_KEY missing in Netlify env.' });
  }
  if (!originAllowed(event)) {
    return jsonResponse(403, { ok: false, error: 'Origin not allowed' });
  }
  const adminHash = (event.headers['x-admin-pw-hash'] || event.headers['X-Admin-Pw-Hash'] || '').trim();
  if (adminHash !== ADMIN_PW_HASH) {
    return jsonResponse(401, { ok: false, error: 'Admin authentication required' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { ok: false, error: 'Invalid JSON body' }); }

  const sportKey  = String(body.sport_key  || '').trim();
  const sportName = String(body.sport_name || '').trim();
  const filename  = String(body.filename   || '').trim();
  const b64       = String(body.pdf_base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!sportKey)        return jsonResponse(400, { ok: false, error: 'sport_key required' });
  if (!b64)             return jsonResponse(400, { ok: false, error: 'pdf_base64 required' });

  // Cheap sanity check on the decoded size — full Buffer decode is wasteful
  // server-side; estimate from base64 length (4 chars ≈ 3 bytes).
  const approxBytes = Math.floor(b64.length * 0.75);
  if (approxBytes > MAX_PDF_BYTES) {
    return jsonResponse(413, { ok: false, error: `PDF is too large (${Math.round(approxBytes/1024/1024)} MB · max ${Math.round(MAX_PDF_BYTES/1024/1024)} MB).` });
  }

  const userText =
    `Extract the structured championship format JSON from the attached PDF.\n\n` +
    `sport_key: ${sportKey}\n` +
    (sportName ? `sport_name: ${sportName}\n` : '') +
    (filename  ? `filename:  ${filename}\n`  : '') +
    `\nReturn the JSON object only. No prose.`;

  let apiRes;
  try {
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 4000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: b64 }
              },
              { type: 'text', text: userText }
            ]
          }
        ]
      })
    });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'Anthropic request failed', detail: String(e?.message || e).slice(0, 400) });
  }

  if (!apiRes.ok) {
    const txt = await apiRes.text().catch(() => '');
    return jsonResponse(apiRes.status, {
      ok: false,
      error: 'Anthropic API error',
      detail: txt.slice(0, 600)
    });
  }

  let data;
  try { data = await apiRes.json(); }
  catch (e) { return jsonResponse(502, { ok: false, error: 'Bad JSON from Anthropic', detail: String(e?.message || e) }); }

  const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const parsed = extractJsonObject(reply);
  if (!parsed) {
    return jsonResponse(422, {
      ok: false,
      error: 'Claude did not return parseable JSON. The PDF may be unusual or the network may have changed its template.',
      detail: reply.slice(0, 400)
    });
  }

  const validationErr = validateParsed(parsed);
  if (validationErr) {
    return jsonResponse(422, {
      ok: false,
      error: 'Parsed JSON did not match the expected shape: ' + validationErr,
      detail: JSON.stringify(parsed).slice(0, 600)
    });
  }

  return jsonResponse(200, {
    ok: true,
    parsed,
    usage: data.usage || null,
    model: data.model || MODEL
  });
};
