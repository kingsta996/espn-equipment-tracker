/**
 * claude-audit-ui.js — shared Claude Audit dashboard, used by both Hubs.
 *
 * Mounts a four-pane UI into a container element (Overview, Full Log,
 * Risk Assessment, Download Report) backed by the claude_audit_events
 * Supabase table.
 *
 * Mirror the same file into:
 *   - /Movies/ESPN Equipment Tracker/claude-audit-ui.js   (Production Hub admin.html)
 *   - /Movies/cusa-creative-hub/claude-audit-ui.js        (Creative Hub admin.html)
 *
 * Usage from a Hub admin page:
 *   <script src="claude-audit-ui.js"></script>
 *   …
 *   ClaudeAudit.init({
 *     db:           supabaseClient,
 *     container:    document.getElementById('claude-audit'),
 *     repoFilter:   '%/ESPN Equipment Tracker%',   // SQL ILIKE pattern on cwd
 *     hubLabel:     'Production Hub',
 *     repoLabel:    'espn-equipment-tracker',
 *     getUser:      () => _currentUser,            // { email, display_name }
 *     requiredEmail:'kking@conferenceusa.com'      // optional admin gate
 *   });
 *
 * The module is self-contained — it injects its own CSS scoped under
 * .ca-root and writes only inside the given container.
 */

(function (global) {
  'use strict';

  /* ── Risk taxonomy ───────────────────────────────────────────────────── */

  // Heuristic rules applied to each event in order. First match wins.
  // Each rule returns a severity tag and a human-readable label that
  // describes what a bad actor could have done with the call.
  const RISK_RULES = [
    // ── CRITICAL: irreversible damage, credential exfiltration, privilege escalation
    { sev:'critical', label:'Recursive deletion',
      test: e => e.tool === 'Bash' && /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-r\b/i.test(cmd(e)) },
    { sev:'critical', label:'Privilege escalation (sudo)',
      test: e => e.tool === 'Bash' && /\bsudo\b/.test(cmd(e)) },
    { sev:'critical', label:'Credential / secret file access',
      test: e => /\/\.env\b|\.env$|\/credentials\b|\.aws\/credentials|\.ssh\/id_|netrc|\.kube\/config/i
                  .test(cmd(e) + ' ' + path(e)) },
    { sev:'critical', label:'Force / destructive git push',
      test: e => e.tool === 'Bash' && /git\s+push.*(--force|-f\b)|git\s+reset\s+--hard\s+\w+\/main/i.test(cmd(e)) },
    { sev:'critical', label:'Disk-wipe / format command',
      test: e => e.tool === 'Bash' && /\b(mkfs|dd\s+if=|diskutil\s+eraseDisk|format\s+\/q)/i.test(cmd(e)) },

    // ── HIGH: outbound exfiltration vectors, install attacks, cloud writes
    { sev:'high', label:'Outbound POST / upload (potential data exfil)',
      test: e => e.tool === 'Bash' && /\b(curl|wget|httpie|http)\b[^|;]*(--data|--data-binary|-d\s|\s-T\s|-X\s+(POST|PUT|PATCH))/i.test(cmd(e)) },
    { sev:'high', label:'Package install (supply-chain risk)',
      test: e => e.tool === 'Bash' && /\b(npm|yarn|pnpm|bun|brew|pip|pip3|gem|cargo|go)\s+(install|add|i)\b/i.test(cmd(e)) },
    { sev:'high', label:'MCP cloud write (Box / Drive / Gmail upload)',
      test: e => isMcp(e) && /(upload|copy|move|create|update|set_|add_|send_|share|delete)/i.test(e.tool) },
    { sev:'high', label:'Shell pipe to interpreter (curl | sh pattern)',
      test: e => e.tool === 'Bash' && /\|\s*(sh|bash|zsh|python|node|ruby|perl)\b/i.test(cmd(e)) },
    { sev:'high', label:'Edit/Write to credential or config file',
      test: e => (e.tool === 'Write' || e.tool === 'Edit') &&
                 /\.env\b|credentials|\.aws\/|\.ssh\/|netlify\.toml$|netlify\/functions\//i.test(path(e)) },
    { sev:'high', label:'Network listener (binding a port)',
      test: e => e.tool === 'Bash' && /\bnc\s+-l|ncat\s+-l|socat\s+.*LISTEN/i.test(cmd(e)) },

    // ── MEDIUM: cloud egress, code modifications, repo state changes
    { sev:'medium', label:'Outbound HTTP fetch',
      test: e => e.tool === 'WebFetch' || e.tool === 'WebSearch' },
    { sev:'medium', label:'MCP cloud read (Box / Drive download)',
      test: e => isMcp(e) && /(read|get_|download|list_|search|preview)/i.test(e.tool) },
    { sev:'medium', label:'MCP call (other)',
      test: e => isMcp(e) },
    { sev:'medium', label:'Git push',
      test: e => e.tool === 'Bash' && /git\s+push\b/.test(cmd(e)) },
    { sev:'medium', label:'Code modification',
      test: e => e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'NotebookEdit' },
    { sev:'medium', label:'Process / system command',
      test: e => e.tool === 'Bash' && /\b(kill|killall|pkill|launchctl|systemctl|service|crontab)\b/i.test(cmd(e)) },
    { sev:'medium', label:'Shell command (uncategorized)',
      test: e => e.tool === 'Bash' },

    // ── LOW: read-only, in-repo, status checks
    { sev:'low', label:'Read-only file access',
      test: e => e.tool === 'Read' || e.tool === 'Glob' || e.tool === 'Grep' },
    { sev:'low', label:'Task management',
      test: e => /^Task(Create|Update|List|Get|Output|Stop)$/.test(e.tool || '') },
    { sev:'low', label:'Schedule / monitor',
      test: e => /^(ScheduleWakeup|Monitor|Cron[A-Z])/.test(e.tool || '') }
  ];

  // Per-bucket "what a bad actor could have done" explainer.
  const RISK_EXPLAINER = {
    critical: 'A successful prompt injection here could destroy data, exfiltrate credentials, or take over the workstation. Each critical event needs individual review.',
    high:    'These calls can move data off the workstation, install untrusted code, or write to cloud storage. Review the targets; confirm the destinations are expected business endpoints.',
    medium:  'Routine but observable: outbound fetches, file edits, MCP calls, git pushes. A compromised session could use these to slowly drift data out — review counts and destinations, not every line.',
    low:     'Read-only, in-repo, or housekeeping operations. No realistic exfiltration risk in isolation.'
  };

  function cmd(e)    { return (e.input && (e.input.command || e.input.cmd)) || ''; }
  function path(e)   { const i = e.input || {}; return i.file_path || i.path || i.url || i.notebook_path || ''; }
  function isMcp(e)  { return (e.tool || '').startsWith('mcp__') || (e.tool || '').startsWith('mcp_'); }
  function isResolved(e) { return !!e.resolved_at; }
  // High + Critical events that need attention (PreToolUse + unresolved).
  function isActiveAlert(e) {
    if (e.event !== 'PreToolUse') return false;
    if (isResolved(e)) return false;
    const sev = classify(e).sev;
    return sev === 'critical' || sev === 'high';
  }

  function classify(e) {
    for (const r of RISK_RULES) {
      try { if (r.test(e)) return { sev: r.sev, label: r.label }; }
      catch (_) { /* keep going */ }
    }
    return { sev: 'low', label: 'Other' };
  }

  /* ── CSS (scoped under .ca-root) ─────────────────────────────────────── */

  const CSS = `
.ca-root { font-family: inherit; color: inherit; }
.ca-root * { box-sizing: border-box; }
.ca-banner { padding: 14px 16px; border-radius: 10px; background: linear-gradient(135deg, rgba(99,102,241,0.12), rgba(99,102,241,0.04)); border: 1px solid rgba(99,102,241,0.3); margin-bottom: 14px; display: flex; gap: 14px; align-items: flex-start; }
.ca-banner .icon { font-size: 22px; line-height: 1; }
.ca-banner h3 { font-size: 14px; margin: 0 0 4px; }
.ca-banner p { font-size: 12px; opacity: 0.75; margin: 0; line-height: 1.5; }
.ca-subtabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(127,127,127,0.25); margin-bottom: 14px; flex-wrap: wrap; }
.ca-subtabs button { background: transparent; color: inherit; border: 0; padding: 10px 16px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; border-bottom: 3px solid transparent; font-family: inherit; opacity: 0.6; }
.ca-subtabs button.active { opacity: 1; border-bottom-color: #EF4035; }
.ca-subtabs button:hover { opacity: 1; }
.ca-pane { display: none; }
.ca-pane.active { display: block; }
.ca-toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; font-size: 12px; }
.ca-toolbar select, .ca-toolbar input { background: rgba(127,127,127,0.08); color: inherit; border: 1px solid rgba(127,127,127,0.3); border-radius: 6px; padding: 6px 10px; font-size: 12px; font-family: inherit; }
.ca-toolbar input[type=search] { min-width: 220px; flex: 1; max-width: 360px; }
.ca-toolbar button { background: rgba(127,127,127,0.12); color: inherit; border: 1px solid rgba(127,127,127,0.3); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
.ca-toolbar button:hover { background: rgba(127,127,127,0.2); }
.ca-toolbar button.primary { background: #EF4035; color: #fff; border-color: #EF4035; }
.ca-toolbar button.primary:hover { background: #d4322a; }
.ca-toolbar .grow { flex: 1; }
.ca-live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; opacity: 0.75; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.25); background: rgba(127,127,127,0.06); white-space: nowrap; }
.ca-live .dot { width: 7px; height: 7px; border-radius: 50%; background: #16a34a; box-shadow: 0 0 0 0 rgba(22,163,74,0.6); animation: ca-live-pulse 1.8s ease-out infinite; }
.ca-live.paused { opacity: 0.5; }
.ca-live.paused .dot { background: #9ca3af; animation: none; box-shadow: none; }
@keyframes ca-live-pulse { 0% { box-shadow: 0 0 0 0 rgba(22,163,74,0.55); } 70% { box-shadow: 0 0 0 7px rgba(22,163,74,0); } 100% { box-shadow: 0 0 0 0 rgba(22,163,74,0); } }
.ca-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 18px; }
.ca-stat { background: rgba(127,127,127,0.06); border: 1px solid rgba(127,127,127,0.18); border-radius: 10px; padding: 12px 14px; }
.ca-stat .num { font-size: 22px; font-weight: 800; line-height: 1; margin-bottom: 4px; }
.ca-stat .lbl { font-size: 10.5px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.7px; font-weight: 700; }
.ca-stat.crit .num { color: #dc2626; }
.ca-stat.high .num { color: #ea580c; }
.ca-stat.med  .num { color: #ca8a04; }
.ca-stat.low  .num { color: #65a30d; }
.ca-sessions { display: flex; flex-direction: column; gap: 10px; }
.ca-session { border: 1px solid rgba(127,127,127,0.2); border-radius: 10px; padding: 12px 14px; background: rgba(127,127,127,0.03); }
.ca-session-head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; font-size: 12px; }
.ca-session-head .when { font-weight: 700; }
.ca-session-head .dur { opacity: 0.7; font-variant-numeric: tabular-nums; }
.ca-session-head .sid { font-size: 10.5px; opacity: 0.45; font-family: ui-monospace, 'Menlo', monospace; }
.ca-session-head .grow { flex: 1; }
.ca-session-summary { font-size: 12px; line-height: 1.6; opacity: 0.82; }
.ca-session-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; font-size: 10.5px; }
.ca-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.4px; }
.ca-pill.crit { background: rgba(220,38,38,0.18); color: #b91c1c; border: 1px solid rgba(220,38,38,0.35); }
.ca-pill.high { background: rgba(234,88,12,0.18); color: #c2410c; border: 1px solid rgba(234,88,12,0.35); }
.ca-pill.med  { background: rgba(202,138,4,0.18); color: #a16207; border: 1px solid rgba(202,138,4,0.35); }
.ca-pill.low  { background: rgba(101,163,13,0.18); color: #4d7c0f; border: 1px solid rgba(101,163,13,0.35); }
.ca-pill.tool { background: rgba(99,102,241,0.14); color: #4f46e5; border: 1px solid rgba(99,102,241,0.28); }
.ca-pill.event { background: rgba(127,127,127,0.12); color: inherit; border: 1px solid rgba(127,127,127,0.25); }
.ca-table { width: 100%; border-collapse: collapse; font-size: 12px; background: rgba(127,127,127,0.04); border: 1px solid rgba(127,127,127,0.18); border-radius: 10px; overflow: hidden; }
.ca-table th { text-align: left; padding: 9px 12px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 800; opacity: 0.65; border-bottom: 1px solid rgba(127,127,127,0.18); background: rgba(127,127,127,0.06); }
.ca-table td { padding: 9px 12px; border-bottom: 1px solid rgba(127,127,127,0.12); vertical-align: top; }
.ca-table tr:last-child td { border-bottom: 0; }
.ca-table tr:hover td { background: rgba(127,127,127,0.05); }
.ca-table td.col-ts { white-space: nowrap; font-variant-numeric: tabular-nums; opacity: 0.7; font-size: 11px; }
.ca-table td.col-tool { white-space: nowrap; }
.ca-table td.col-sev { white-space: nowrap; }
.ca-table td.col-input { font-family: ui-monospace, 'Menlo', monospace; font-size: 11px; word-break: break-word; max-width: 0; }
.ca-table td.col-input .preview { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ca-table td.col-input details { white-space: normal; }
.ca-table td.col-input details summary { cursor: pointer; }
.ca-table td.col-input pre { margin: 6px 0 0; padding: 8px; background: rgba(0,0,0,0.04); border: 1px solid rgba(127,127,127,0.18); border-radius: 6px; font-size: 10.5px; max-height: 240px; overflow: auto; }
.ca-risk-bucket { border: 1px solid rgba(127,127,127,0.2); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; background: rgba(127,127,127,0.03); }
.ca-risk-bucket.crit { border-color: rgba(220,38,38,0.4); background: rgba(220,38,38,0.04); }
.ca-risk-bucket.high { border-color: rgba(234,88,12,0.4); background: rgba(234,88,12,0.04); }
.ca-risk-bucket.med  { border-color: rgba(202,138,4,0.35); background: rgba(202,138,4,0.04); }
.ca-risk-bucket.low  { border-color: rgba(101,163,13,0.35); background: rgba(101,163,13,0.04); }
.ca-risk-bucket h4 { margin: 0 0 4px; font-size: 14px; display: flex; gap: 10px; align-items: center; }
.ca-risk-bucket h4 .count { font-weight: 800; }
.ca-risk-bucket .explainer { font-size: 12px; line-height: 1.55; opacity: 0.78; margin-bottom: 10px; }
.ca-risk-bucket .labels { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.ca-risk-bucket .labels .row { display: flex; gap: 10px; align-items: baseline; }
.ca-risk-bucket .labels .row .lbl { flex: 1; }
.ca-risk-bucket .labels .row .num { font-weight: 800; opacity: 0.7; font-variant-numeric: tabular-nums; }
.ca-risk-bucket .samples { margin-top: 10px; }
.ca-risk-bucket .samples details summary { cursor: pointer; font-size: 12px; font-weight: 700; opacity: 0.7; }
.ca-risk-bucket .samples .sample { font-family: ui-monospace, 'Menlo', monospace; font-size: 11px; padding: 6px 10px; margin: 6px 0; background: rgba(0,0,0,0.04); border-radius: 6px; border: 1px solid rgba(127,127,127,0.15); word-break: break-word; }
.ca-empty { text-align: center; padding: 40px 20px; opacity: 0.55; font-size: 13px; }
.ca-loading { text-align: center; padding: 30px; opacity: 0.6; font-size: 12px; }
.ca-restricted { padding: 24px; border: 1px dashed rgba(220,38,38,0.4); border-radius: 10px; background: rgba(220,38,38,0.04); text-align: center; }
.ca-restricted h3 { margin-bottom: 6px; color: #b91c1c; font-size: 15px; }
.ca-restricted p { font-size: 12px; opacity: 0.7; }
.ca-pagination { display: flex; gap: 10px; align-items: center; justify-content: center; margin-top: 14px; font-size: 12px; }
.ca-pagination button { background: rgba(127,127,127,0.12); border: 1px solid rgba(127,127,127,0.25); border-radius: 6px; padding: 4px 12px; font-weight: 700; cursor: pointer; font-family: inherit; color: inherit; }
.ca-pagination button:disabled { opacity: 0.4; cursor: default; }
.ca-stat .sub { font-size: 10px; opacity: 0.6; margin-top: 4px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; }
.ca-stat.crit.has-active, .ca-stat.high.has-active { border-color: currentColor; box-shadow: 0 0 0 1px currentColor inset; }
.ca-stat.all-clear .num { color: #16a34a; }
.ca-row-resolve { padding: 8px 12px; background: rgba(22,163,74,0.06); border-top: 1px dashed rgba(22,163,74,0.35); font-size: 11px; line-height: 1.55; }
.ca-row-resolve strong { color: #15803d; }
.ca-row-resolve .meta { opacity: 0.7; margin-right: 8px; }
.ca-row-resolve button { background: transparent; border: 1px solid rgba(127,127,127,0.3); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; font-family: inherit; color: inherit; margin-left: 6px; }
.ca-row-resolve button:hover { background: rgba(127,127,127,0.1); }
.ca-resolve-btn { background: #ea580c; color: #fff; border: 0; border-radius: 4px; padding: 4px 10px; font-size: 11px; font-weight: 700; cursor: pointer; font-family: inherit; margin-top: 4px; letter-spacing: 0.3px; }
.ca-resolve-btn.crit { background: #dc2626; }
.ca-resolve-btn:hover { filter: brightness(1.08); }
.ca-modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9999; align-items: center; justify-content: center; padding: 20px; }
.ca-modal-overlay.open { display: flex; }
.ca-modal { background: #fff; color: #222; border-radius: 10px; padding: 22px 24px; max-width: 520px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.35); max-height: 92vh; overflow-y: auto; }
.ca-modal h3 { margin-bottom: 6px; font-size: 16px; color: #111; }
.ca-modal .sev-line { font-size: 12px; margin-bottom: 14px; }
.ca-modal .sev-line .sev { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; font-size: 10px; margin-right: 6px; }
.ca-modal .sev-line .sev.crit { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; }
.ca-modal .sev-line .sev.high { background: #ffedd5; color: #c2410c; border: 1px solid #fdba74; }
.ca-modal .cmd-box { background: #f6f7f9; border: 1px solid #e3e6eb; border-radius: 6px; padding: 9px 12px; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; word-break: break-word; margin-bottom: 14px; max-height: 110px; overflow: auto; }
.ca-modal label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; font-weight: 700; margin-bottom: 5px; }
.ca-modal textarea { width: 100%; min-height: 90px; padding: 9px 11px; border: 1.5px solid #ddd; border-radius: 6px; font-family: inherit; font-size: 13px; resize: vertical; }
.ca-modal textarea:focus { outline: none; border-color: #00B5E2; }
.ca-modal .hint { font-size: 11px; color: #777; margin-top: 6px; }
.ca-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.ca-modal-actions button { padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; border: 0; }
.ca-modal-actions .cancel { background: #f0f1f4; color: #444; }
.ca-modal-actions .save { background: #16a34a; color: #fff; }
.ca-modal-actions button:hover { filter: brightness(1.06); }
`;

  let cssMounted = false;
  function mountCss() {
    if (cssMounted) return;
    const s = document.createElement('style');
    s.setAttribute('data-claude-audit', '1');
    s.textContent = CSS;
    document.head.appendChild(s);
    cssMounted = true;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTs(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }
  function fmtDur(ms) {
    if (ms < 1000) return ms + 'ms';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return m + 'm ' + rs + 's';
    const h = Math.floor(m / 60), rm = m % 60;
    return h + 'h ' + rm + 'm';
  }
  function summarizeInput(e) {
    const i = e.input || {};
    if (i.command) return i.command;
    if (i.file_path) return i.file_path;
    if (i.path) return i.path;
    if (i.url) return i.url;
    if (i.prompt) return i.prompt.length > 120 ? i.prompt.slice(0, 117) + '…' : i.prompt;
    if (Object.keys(i).length === 0) return '';
    return JSON.stringify(i).slice(0, 160);
  }

  /* ── State (per-instance) ────────────────────────────────────────────── */
  function newState() {
    return {
      cfg: null,
      events: [],
      filtered: [],
      sessions: [],
      filters: { days: 7, event: '', severity: '', search: '' },
      page: 0,
      pageSize: 100,
      activePane: 'overview',
      lastLoadedAt: 0,
      autoTimer: null,
      tickerTimer: null,
      paused: false
    };
  }

  const AUTO_REFRESH_MS = 30000;

  /* ── Public init ─────────────────────────────────────────────────────── */
  async function init(cfg) {
    mountCss();
    if (!cfg || !cfg.container) throw new Error('ClaudeAudit.init: container required');
    const state = newState();
    state.cfg = cfg;

    // Auth gate (optional). Accepts either requiredEmail (string) or allowedEmails (array).
    const allowed = []
      .concat(cfg.requiredEmail ? [cfg.requiredEmail] : [])
      .concat(Array.isArray(cfg.allowedEmails) ? cfg.allowedEmails : [])
      .map(e => String(e).toLowerCase())
      .filter(Boolean);
    if (allowed.length) {
      const u = (cfg.getUser && cfg.getUser()) || null;
      const email = (u && u.email ? String(u.email).toLowerCase() : '');
      if (!allowed.includes(email)) {
        const list = allowed.map(escHtml).join(', ');
        cfg.container.innerHTML = `
          <div class="ca-root">
            <div class="ca-restricted">
              <h3>🔒 Restricted</h3>
              <p>Claude Audit is only accessible to ${list}. You are signed in as ${escHtml(email || 'unknown')}.</p>
            </div>
          </div>`;
        return;
      }
    }

    if (!cfg.db) {
      cfg.container.innerHTML = `<div class="ca-root"><div class="ca-empty">Supabase client not provided.</div></div>`;
      return;
    }

    cfg.container.innerHTML = renderSkeleton(state);
    wireSkeleton(state);
    await reload(state);
    startAutoRefresh(state);
  }

  function startAutoRefresh(state) {
    stopAutoRefresh(state);
    state.autoTimer = setInterval(() => {
      if (state.paused) return;
      reload(state);
    }, AUTO_REFRESH_MS);
    state.tickerTimer = setInterval(() => updateLiveIndicator(state), 1000);
    if (typeof document !== 'undefined' && !state._visHandler) {
      state._visHandler = () => {
        const hidden = document.visibilityState === 'hidden';
        state.paused = hidden;
        if (!hidden) reload(state);
        updateLiveIndicator(state);
      };
      document.addEventListener('visibilitychange', state._visHandler);
    }
    updateLiveIndicator(state);
  }

  function stopAutoRefresh(state) {
    if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
    if (state.tickerTimer) { clearInterval(state.tickerTimer); state.tickerTimer = null; }
  }

  function updateLiveIndicator(state) {
    const root = state.cfg && state.cfg.container;
    if (!root) return;
    const pill = root.querySelector('[data-live]');
    const txt = root.querySelector('[data-live-text]');
    if (!pill || !txt) return;
    if (state.paused) {
      pill.classList.add('paused');
      txt.textContent = 'Paused (tab hidden)';
      return;
    }
    pill.classList.remove('paused');
    if (!state.lastLoadedAt) { txt.textContent = 'Live'; return; }
    const ageMs = Date.now() - state.lastLoadedAt;
    const ageSec = Math.floor(ageMs / 1000);
    let when;
    if (ageSec < 5) when = 'just now';
    else if (ageSec < 60) when = ageSec + 's ago';
    else { const m = Math.floor(ageSec / 60); when = m + 'm ago'; }
    txt.textContent = 'Live · updated ' + when;
  }

  function renderSkeleton(state) {
    const cfg = state.cfg;
    return `
<div class="ca-root">
  <div class="ca-banner">
    <span class="icon">🛡</span>
    <div>
      <h3>Claude Audit — ${escHtml(cfg.hubLabel || 'Hub')}</h3>
      <p>Every Claude Code tool call that touched the <strong>${escHtml(cfg.repoLabel || 'repo')}</strong> working directory is logged here, mirrored from <code>~/claude-audit/</code> on Keith's workstation. Use the Download Report button to package a self-contained HTML for IT.</p>
    </div>
  </div>

  <div class="ca-subtabs">
    <button data-pane="overview" class="active">Overview</button>
    <button data-pane="full">Full Log</button>
    <button data-pane="risk">Risk Assessment</button>
    <button data-pane="report">Download Report</button>
  </div>

  <div class="ca-toolbar">
    <label>Window
      <select data-filter="days">
        <option value="1">Last 24h</option>
        <option value="7" selected>Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="0">All time</option>
      </select>
    </label>
    <label>Event
      <select data-filter="event">
        <option value="">All</option>
        <option value="PreToolUse">PreToolUse</option>
        <option value="PostToolUse">PostToolUse</option>
        <option value="PostToolUseFailure">PostToolUseFailure</option>
        <option value="UserPromptSubmit">UserPromptSubmit</option>
        <option value="SessionStart">SessionStart</option>
        <option value="Stop">Stop</option>
        <option value="Notification">Notification</option>
      </select>
    </label>
    <label>Severity
      <select data-filter="severity">
        <option value="">All</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
    </label>
    <input type="search" placeholder="Search command, path, URL…" data-filter="search" />
    <span class="grow"></span>
    <span class="ca-live" data-live title="Auto-refreshes every 30 seconds. Pauses while this tab is hidden."><span class="dot"></span><span data-live-text>Live</span></span>
    <button data-action="refresh">↻ Refresh</button>
    <button data-action="download" class="primary">⬇ Download Report</button>
  </div>

  <div class="ca-pane active" data-pane-body="overview"></div>
  <div class="ca-pane"        data-pane-body="full"></div>
  <div class="ca-pane"        data-pane-body="risk"></div>
  <div class="ca-pane"        data-pane-body="report"></div>
</div>`;
  }

  function wireSkeleton(state) {
    const root = state.cfg.container;
    root.querySelectorAll('.ca-subtabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activePane = btn.dataset.pane;
        root.querySelectorAll('.ca-subtabs button').forEach(b => b.classList.toggle('active', b === btn));
        root.querySelectorAll('.ca-pane').forEach(p => p.classList.toggle('active', p.dataset.paneBody === state.activePane));
        renderActivePane(state);
      });
    });
    root.querySelectorAll('[data-filter]').forEach(el => {
      el.addEventListener('change', () => {
        const k = el.dataset.filter;
        const v = el.value;
        if (k === 'days') { state.filters.days = parseInt(v, 10) || 0; reload(state); return; }
        state.filters[k] = v;
        state.page = 0;
        applyFiltersAndRender(state);
      });
      if (el.tagName === 'INPUT') {
        let t = null;
        el.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => {
            state.filters.search = el.value.toLowerCase().trim();
            state.page = 0;
            applyFiltersAndRender(state);
          }, 220);
        });
      }
    });
    root.querySelector('[data-action="refresh"]').addEventListener('click', () => reload(state));
    root.querySelector('[data-action="download"]').addEventListener('click', () => downloadReport(state));
  }

  async function reload(state) {
    const cfg = state.cfg;
    const root = cfg.container;
    root.querySelectorAll('.ca-pane').forEach(p => p.innerHTML = '<div class="ca-loading">Loading audit events…</div>');

    let q = cfg.db.from('claude_audit_events').select('*')
              .ilike('cwd', cfg.repoFilter)
              .order('ts', { ascending: false })
              .limit(5000);
    if (state.filters.days > 0) {
      const since = new Date(Date.now() - state.filters.days * 86400000).toISOString();
      q = q.gte('ts', since);
    }
    try {
      const { data, error } = await q;
      if (error) throw error;
      state.events = data || [];
      state.lastLoadedAt = Date.now();
    } catch (e) {
      state.events = [];
      root.querySelectorAll('.ca-pane').forEach(p => p.innerHTML = `<div class="ca-empty">Load failed: ${escHtml(e.message || e)}</div>`);
      updateLiveIndicator(state);
      return;
    }
    applyFiltersAndRender(state);
    updateLiveIndicator(state);
  }

  function applyFiltersAndRender(state) {
    const { event, severity, search } = state.filters;
    state.filtered = state.events.filter(e => {
      if (event && e.event !== event) return false;
      if (severity && classify(e).sev !== severity) return false;
      if (search) {
        const hay = (cmd(e) + ' ' + path(e) + ' ' + (e.tool || '') + ' ' + JSON.stringify(e.input || {}) + ' ' + (e.cwd || '')).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    state.sessions = groupSessions(state.events);
    renderActivePane(state);
  }

  function renderActivePane(state) {
    const root = state.cfg.container;
    const pane = root.querySelector(`[data-pane-body="${state.activePane}"]`);
    if (!pane) return;
    if (state.activePane === 'overview') pane.innerHTML = renderOverviewHtml(state);
    if (state.activePane === 'full')     { pane.innerHTML = renderFullHtml(state); wirePagination(state, pane); }
    if (state.activePane === 'risk')     pane.innerHTML = renderRiskHtml(state);
    if (state.activePane === 'report')   pane.innerHTML = renderReportHtml(state);
  }

  /* ── Session grouping (Overview) ─────────────────────────────────────── */

  function groupSessions(events) {
    const byId = new Map();
    for (const e of events) {
      const sid = e.session_id || 'unknown';
      if (!byId.has(sid)) byId.set(sid, []);
      byId.get(sid).push(e);
    }
    const sessions = [];
    for (const [sid, evs] of byId.entries()) {
      const sorted = evs.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
      const first = sorted[0], last = sorted[sorted.length - 1];
      const start = new Date(first.ts), end = new Date(last.ts);
      const tally = { bash: 0, write: 0, edit: 0, read: 0, web: 0, mcp: 0, task: 0, other: 0 };
      const sevTally = { critical: 0, high: 0, medium: 0, low: 0 };
      let prompts = 0;
      const filesTouched = new Set(), urlsTouched = new Set(), bashCmds = [];
      for (const e of sorted) {
        if (e.event === 'UserPromptSubmit') prompts++;
        if (e.event !== 'PreToolUse') continue; // count tool intents once
        const t = e.tool || '';
        if (t === 'Bash') { tally.bash++; const c = cmd(e); if (c) bashCmds.push(c); }
        else if (t === 'Write') { tally.write++; if (path(e)) filesTouched.add(path(e)); }
        else if (t === 'Edit')  { tally.edit++;  if (path(e)) filesTouched.add(path(e)); }
        else if (t === 'Read')  { tally.read++;  if (path(e)) filesTouched.add(path(e)); }
        else if (t === 'WebFetch' || t === 'WebSearch') { tally.web++; if (path(e)) urlsTouched.add(path(e)); }
        else if (isMcp(e)) { tally.mcp++; }
        else if (/^Task/.test(t)) tally.task++;
        else tally.other++;
        sevTally[classify(e).sev]++;
      }
      sessions.push({
        sid, start, end,
        prompts, tally, sevTally,
        files: Array.from(filesTouched).slice(0, 20),
        urls:  Array.from(urlsTouched).slice(0, 20),
        bashSample: bashCmds.slice(0, 6),
        count: sorted.length
      });
    }
    return sessions.sort((a, b) => b.end - a.end);
  }

  function renderOverviewHtml(state) {
    if (!state.events.length) return `<div class="ca-empty">No audit events in this window for this repo.<br><small>Working directory filter: <code>${escHtml(state.cfg.repoFilter)}</code></small></div>`;

    const total = state.events.length;
    const preTool = state.events.filter(e => e.event === 'PreToolUse').length;
    const failures = state.events.filter(e => e.event === 'PostToolUseFailure').length;
    const prompts = state.events.filter(e => e.event === 'UserPromptSubmit').length;
    const sessionCount = state.sessions.length;

    const sevTotals = { critical: 0, high: 0, medium: 0, low: 0 };
    const sevActive = { critical: 0, high: 0 };
    for (const e of state.events.filter(e => e.event === 'PreToolUse')) {
      const sev = classify(e).sev;
      sevTotals[sev]++;
      if ((sev === 'critical' || sev === 'high') && !isResolved(e)) sevActive[sev]++;
    }
    const critResolved = sevTotals.critical - sevActive.critical;
    const highResolved = sevTotals.high - sevActive.high;
    const allClear = sevActive.critical === 0 && sevActive.high === 0 && (sevTotals.critical || sevTotals.high);

    const stats = `
<div class="ca-stats">
  <div class="ca-stat"><div class="num">${total}</div><div class="lbl">Events</div></div>
  <div class="ca-stat"><div class="num">${sessionCount}</div><div class="lbl">Sessions</div></div>
  <div class="ca-stat"><div class="num">${prompts}</div><div class="lbl">User prompts</div></div>
  <div class="ca-stat"><div class="num">${preTool}</div><div class="lbl">Tool calls</div></div>
  <div class="ca-stat"><div class="num">${failures}</div><div class="lbl">Failures</div></div>
  <div class="ca-stat crit ${sevActive.critical > 0 ? 'has-active' : ''} ${allClear && sevTotals.critical ? 'all-clear' : ''}">
    <div class="num">${sevActive.critical}</div>
    <div class="lbl">Active Critical</div>
    ${sevTotals.critical ? `<div class="sub">${critResolved} resolved · ${sevTotals.critical} total</div>` : ''}
  </div>
  <div class="ca-stat high ${sevActive.high > 0 ? 'has-active' : ''} ${allClear && sevTotals.high ? 'all-clear' : ''}">
    <div class="num">${sevActive.high}</div>
    <div class="lbl">Active High</div>
    ${sevTotals.high ? `<div class="sub">${highResolved} resolved · ${sevTotals.high} total</div>` : ''}
  </div>
  <div class="ca-stat med"><div class="num">${sevTotals.medium}</div><div class="lbl">Medium</div></div>
  <div class="ca-stat low"><div class="num">${sevTotals.low}</div><div class="lbl">Low</div></div>
</div>`;

    const sessionCards = state.sessions.slice(0, 30).map(s => {
      const dur = fmtDur(s.end - s.start);
      const parts = [];
      if (s.prompts)     parts.push(`${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`);
      if (s.tally.bash)  parts.push(`${s.tally.bash} bash`);
      if (s.tally.read)  parts.push(`${s.tally.read} read`);
      if (s.tally.edit + s.tally.write) parts.push(`${s.tally.edit + s.tally.write} edit/write`);
      if (s.tally.web)   parts.push(`${s.tally.web} webfetch`);
      if (s.tally.mcp)   parts.push(`${s.tally.mcp} mcp call${s.tally.mcp === 1 ? '' : 's'}`);
      if (s.tally.task)  parts.push(`${s.tally.task} task`);
      const tags = [];
      if (s.sevTally.critical) tags.push(`<span class="ca-pill crit">${s.sevTally.critical} critical</span>`);
      if (s.sevTally.high)     tags.push(`<span class="ca-pill high">${s.sevTally.high} high</span>`);
      if (s.sevTally.medium)   tags.push(`<span class="ca-pill med">${s.sevTally.medium} medium</span>`);
      if (s.sevTally.low)      tags.push(`<span class="ca-pill low">${s.sevTally.low} low</span>`);
      const filesList = s.files.length
        ? `<div style="margin-top:6px;font-size:11px;opacity:0.7"><strong>Files touched:</strong> ${s.files.slice(0,8).map(escHtml).join(', ')}${s.files.length > 8 ? ` +${s.files.length - 8} more` : ''}</div>`
        : '';
      const urlsList = s.urls.length
        ? `<div style="margin-top:4px;font-size:11px;opacity:0.7"><strong>URLs fetched:</strong> ${s.urls.slice(0,6).map(escHtml).join(', ')}${s.urls.length > 6 ? ` +${s.urls.length - 6} more` : ''}</div>`
        : '';
      return `
<div class="ca-session">
  <div class="ca-session-head">
    <span class="when">${escHtml(fmtTs(s.start))}</span>
    <span class="dur">${dur}</span>
    <span class="grow"></span>
    <span class="sid">${escHtml(s.sid.slice(0, 8))}…</span>
  </div>
  <div class="ca-session-summary">${parts.join(' · ') || 'No tool activity'}</div>
  ${filesList}${urlsList}
  <div class="ca-session-tags">${tags.join('')}</div>
</div>`;
    }).join('');

    return stats + `<h4 style="margin:18px 0 10px;font-size:13px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase;opacity:0.65;">Sessions (most recent first)</h4><div class="ca-sessions">` + sessionCards + `</div>` +
      (state.sessions.length > 30 ? `<div style="text-align:center;margin-top:10px;font-size:11px;opacity:0.55;">Showing 30 of ${state.sessions.length} sessions — see Full Log for everything.</div>` : '');
  }

  /* ── Full log (paginated table) ──────────────────────────────────────── */

  function renderFullHtml(state) {
    if (!state.filtered.length) return `<div class="ca-empty">No events match the current filters.</div>`;
    const start = state.page * state.pageSize;
    const slice = state.filtered.slice(start, start + state.pageSize);
    const rows = slice.map(e => {
      const sev = classify(e);
      const sevCls = sev.sev === 'critical' ? 'crit' : sev.sev === 'high' ? 'high' : sev.sev === 'medium' ? 'med' : 'low';
      const sevPill = `<span class="ca-pill ${sevCls}">${sev.sev}</span>`;
      const tool = e.tool ? `<span class="ca-pill tool">${escHtml(e.tool)}</span>` : '';
      const evPill = `<span class="ca-pill event">${escHtml(e.event)}</span>`;
      const preview = escHtml((summarizeInput(e) || '').slice(0, 260));
      const fullJson = JSON.stringify({ event: e.event, tool: e.tool, input: e.input, response: e.response, cwd: e.cwd }, null, 2);
      // Resolve UI for Critical / High alerts on actual tool intents.
      const isAlert = e.event === 'PreToolUse' && (sev.sev === 'critical' || sev.sev === 'high');
      let resolveBlock = '';
      if (isAlert) {
        if (isResolved(e)) {
          resolveBlock = `
            <div class="ca-row-resolve">
              <strong>✓ Resolved</strong>
              <span class="meta">by ${escHtml(e.resolved_by || 'admin')} · ${escHtml(fmtTs(e.resolved_at))}</span>
              <button data-unresolve="${e.id}" title="Mark this alert active again">Reopen</button>
              <div style="margin-top:4px;white-space:pre-wrap">${escHtml(e.resolution_notes || '')}</div>
            </div>`;
        } else {
          resolveBlock = `<button class="ca-resolve-btn ${sevCls}" data-resolve="${e.id}">✓ Mark Resolved</button>`;
        }
      }
      return `
<tr data-event-id="${e.id}">
  <td class="col-ts">${escHtml(fmtTs(e.ts))}</td>
  <td class="col-tool">${evPill} ${tool}</td>
  <td class="col-sev">${sevPill}</td>
  <td class="col-input">
    <details>
      <summary class="preview">${preview || '<em style="opacity:0.5">(no input)</em>'}</summary>
      <pre>${escHtml(fullJson)}</pre>
    </details>
    ${resolveBlock}
  </td>
</tr>`;
    }).join('');

    const total = state.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    return `
<table class="ca-table">
  <thead><tr><th style="width:160px">When (local)</th><th style="width:240px">Event · Tool</th><th style="width:90px">Risk</th><th>Input</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="ca-pagination">
  <button data-page="prev" ${state.page === 0 ? 'disabled' : ''}>← Prev</button>
  <span>Page ${state.page + 1} of ${totalPages} · ${total} events</span>
  <button data-page="next" ${state.page + 1 >= totalPages ? 'disabled' : ''}>Next →</button>
</div>`;
  }

  function wirePagination(state, pane) {
    pane.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.page === 'prev') state.page = Math.max(0, state.page - 1);
      else state.page = state.page + 1;
      renderActivePane(state);
    }));
    pane.querySelectorAll('[data-resolve]').forEach(b => b.addEventListener('click', () => {
      const id = Number(b.dataset.resolve);
      const ev = state.events.find(x => x.id === id);
      if (ev) showResolveModal(state, ev);
    }));
    pane.querySelectorAll('[data-unresolve]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Reopen this alert — clear the resolution so it shows as active again?')) return;
      const id = Number(b.dataset.unresolve);
      await applyResolution(state, id, null, null, null);
    }));
  }

  /* ── Resolve modal + Supabase writes ─────────────────────────────────── */

  function getResolverEmail(state) {
    const u = (state.cfg.getUser && state.cfg.getUser()) || null;
    return (u && u.email) ? String(u.email) : 'admin';
  }

  function showResolveModal(state, event) {
    let overlay = document.getElementById('ca-resolve-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ca-resolve-modal';
      overlay.className = 'ca-modal-overlay';
      document.body.appendChild(overlay);
    }
    const sev = classify(event);
    const sevCls = sev.sev === 'critical' ? 'crit' : 'high';
    const summary = summarizeInput(event) || '(no input)';
    overlay.innerHTML = `
      <div class="ca-modal">
        <h3>Resolve risk alert</h3>
        <div class="sev-line"><span class="sev ${sevCls}">${sev.sev}</span> ${escHtml(sev.label)} · <span style="opacity:0.7">${escHtml(fmtTs(event.ts))}</span></div>
        <div class="cmd-box">${escHtml(summary)}</div>
        <label for="ca-resolve-notes">Steps taken to address</label>
        <textarea id="ca-resolve-notes" placeholder="What did you do, confirm, or determine? e.g., 'Verified Keith intentionally ran brew install poppler to read a PDF. Memory rule added to ask before package installs.'"></textarea>
        <div class="hint">Resolving drops this alert from the Active count on the overview. The note appears in the Full Log and the downloaded IT report. You can reopen it later.</div>
        <div class="ca-modal-actions">
          <button class="cancel" data-close>Cancel</button>
          <button class="save" data-save>✓ Resolve</button>
        </div>
      </div>`;
    overlay.classList.add('open');
    const ta = overlay.querySelector('#ca-resolve-notes');
    setTimeout(() => ta.focus(), 80);
    overlay.querySelector('[data-close]').addEventListener('click', () => overlay.classList.remove('open'));
    overlay.querySelector('[data-save]').addEventListener('click', async () => {
      const notes = ta.value.trim();
      if (!notes) { ta.style.borderColor = '#dc2626'; ta.focus(); return; }
      overlay.querySelector('[data-save]').disabled = true;
      const email = getResolverEmail(state);
      const ok = await applyResolution(state, event.id, notes, new Date().toISOString(), email);
      if (ok) overlay.classList.remove('open');
      else overlay.querySelector('[data-save]').disabled = false;
    });
    overlay.addEventListener('click', ev => { if (ev.target === overlay) overlay.classList.remove('open'); }, { once: true });
  }

  async function applyResolution(state, id, notes, resolvedAt, resolvedBy) {
    if (!state.cfg.db) return false;
    try {
      const { error } = await state.cfg.db.from('claude_audit_events')
        .update({ resolution_notes: notes, resolved_at: resolvedAt, resolved_by: resolvedBy })
        .eq('id', id);
      if (error) throw error;
      // Patch local cache so the UI updates immediately, then re-render.
      const ev = state.events.find(x => x.id === id);
      if (ev) { ev.resolution_notes = notes; ev.resolved_at = resolvedAt; ev.resolved_by = resolvedBy; }
      applyFiltersAndRender(state);
      return true;
    } catch (e) {
      alert('Resolution save failed: ' + (e.message || e) + '\n\nMake sure you have run the claude_audit_resolutions.sql migration in Supabase Studio.');
      return false;
    }
  }

  /* ── Risk assessment ─────────────────────────────────────────────────── */

  function buildRiskBuckets(events) {
    const buckets = {
      critical: { count: 0, active: 0, resolved: 0, labels: new Map(), samples: [] },
      high:     { count: 0, active: 0, resolved: 0, labels: new Map(), samples: [] },
      medium:   { count: 0, active: 0, resolved: 0, labels: new Map(), samples: [] },
      low:      { count: 0, active: 0, resolved: 0, labels: new Map(), samples: [] }
    };
    for (const e of events) {
      if (e.event !== 'PreToolUse') continue;
      const c = classify(e);
      const b = buckets[c.sev];
      b.count++;
      const resolved = isResolved(e);
      if (resolved) b.resolved++; else b.active++;
      b.labels.set(c.label, (b.labels.get(c.label) || 0) + 1);
      if (b.samples.length < 60) b.samples.push({ ts: e.ts, tool: e.tool, label: c.label, summary: summarizeInput(e), resolved });
    }
    return buckets;
  }

  function renderRiskHtml(state) {
    if (!state.events.length) return `<div class="ca-empty">No audit events to classify.</div>`;
    const buckets = buildRiskBuckets(state.events);
    const order = ['critical', 'high', 'medium', 'low'];
    const cls   = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };
    const title = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' };
    return order.map(k => {
      const b = buckets[k];
      const labelsHtml = Array.from(b.labels.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([lbl, n]) => `<div class="row"><span class="lbl">${escHtml(lbl)}</span><span class="num">${n}</span></div>`)
        .join('') || '<div style="opacity:0.55;font-size:11px;">No events in this bucket.</div>';
      const samplesHtml = b.samples.slice(0, 8).map(s =>
        `<div class="sample"><strong>${escHtml(s.label)}</strong> · ${escHtml(s.tool || '')} · <span style="opacity:0.65">${escHtml(fmtTs(s.ts))}</span><br>${escHtml((s.summary || '').slice(0, 240))}</div>`
      ).join('');
      const showResolveSplit = (k === 'critical' || k === 'high') && b.count > 0;
      const countLine = showResolveSplit
        ? `<span class="count">· ${b.active} active · ${b.resolved} resolved · ${b.count} total</span>`
        : `<span class="count">· ${b.count} event${b.count === 1 ? '' : 's'}</span>`;
      return `
<div class="ca-risk-bucket ${cls[k]}">
  <h4>${title[k]} ${countLine}</h4>
  <div class="explainer">${escHtml(RISK_EXPLAINER[k])}${showResolveSplit && b.active === 0 && b.count > 0 ? ' <strong style="color:#15803d">✓ All resolved.</strong>' : ''}</div>
  <div class="labels">${labelsHtml}</div>
  ${b.samples.length ? `<div class="samples"><details><summary>Show ${Math.min(8, b.samples.length)} sample event${b.samples.length === 1 ? '' : 's'}</summary>${samplesHtml}</details></div>` : ''}
</div>`;
    }).join('');
  }

  /* ── Download report ─────────────────────────────────────────────────── */

  function renderReportHtml(state) {
    const w = state.filters.days === 0 ? 'all time' : `the last ${state.filters.days} day${state.filters.days === 1 ? '' : 's'}`;
    return `
<div class="ca-banner">
  <span class="icon">📄</span>
  <div>
    <h3>Comprehensive Audit Report</h3>
    <p>Generates a self-contained HTML file you can email to IT. Includes the Overview, Risk Assessment, and the full event log for <strong>${escHtml(state.cfg.repoLabel || 'this repo')}</strong> over ${w}. No external resources — opens offline.</p>
  </div>
</div>
<div style="display:flex;gap:10px;flex-wrap:wrap;">
  <button class="primary" data-action="download" style="background:#EF4035;color:#fff;border:0;border-radius:8px;padding:10px 22px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;">⬇ Download HTML report</button>
  <button data-action="download-json" style="background:rgba(127,127,127,0.12);color:inherit;border:1px solid rgba(127,127,127,0.3);border-radius:8px;padding:10px 22px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">⬇ Download raw JSONL</button>
</div>
<p style="margin-top:14px;font-size:11.5px;opacity:0.65;line-height:1.55;">
  The HTML report is self-styled and embeds the same risk taxonomy used in this dashboard. The JSONL export gives IT the raw event stream for their own SIEM ingestion if they prefer.
</p>`;
  }

  function downloadReport(state) {
    const html = buildReportHtml(state);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const stamp = new Date().toISOString().slice(0, 10);
    triggerDownload(blob, `claude-audit-${slug(state.cfg.repoLabel || 'repo')}-${stamp}.html`);
  }

  function downloadJsonl(state) {
    const lines = state.events.map(e => JSON.stringify(e)).join('\n');
    const blob = new Blob([lines + '\n'], { type: 'application/x-ndjson' });
    const stamp = new Date().toISOString().slice(0, 10);
    triggerDownload(blob, `claude-audit-${slug(state.cfg.repoLabel || 'repo')}-${stamp}.jsonl`);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  function buildReportHtml(state) {
    const cfg = state.cfg;
    const generated = new Date().toISOString();
    const w = state.filters.days === 0 ? 'All time' : `Last ${state.filters.days} day(s)`;
    const eventsToInclude = state.events; // unfiltered raw events for IT
    const buckets = buildRiskBuckets(eventsToInclude);
    const sessions = groupSessions(eventsToInclude);

    const sevTotals = { critical: 0, high: 0, medium: 0, low: 0 };
    const sevActive = { critical: 0, high: 0 };
    for (const e of eventsToInclude.filter(e => e.event === 'PreToolUse')) {
      const sev = classify(e).sev;
      sevTotals[sev]++;
      if ((sev === 'critical' || sev === 'high') && !isResolved(e)) sevActive[sev]++;
    }

    const eventRows = eventsToInclude.slice(0, 5000).map(e => {
      const sev = e.event === 'PreToolUse' ? classify(e).sev : '';
      const input = escHtml((summarizeInput(e) || '').slice(0, 400));
      const fullInput = escHtml(JSON.stringify(e.input || {}));
      const status = isResolved(e)
        ? `<span style="color:#15803d;font-weight:700">RESOLVED</span> · ${escHtml(e.resolved_by || '')} · ${escHtml(fmtTs(e.resolved_at))}`
        : ((sev === 'critical' || sev === 'high') ? '<span style="color:#b91c1c;font-weight:700">ACTIVE</span>' : '');
      const notes = e.resolution_notes ? escHtml(e.resolution_notes) : '';
      return `<tr><td>${escHtml(fmtTs(e.ts))}</td><td>${escHtml(e.event)}</td><td>${escHtml(e.tool || '')}</td><td>${sev}</td><td>${status}</td><td>${input}</td><td class="full">${fullInput}</td><td class="full">${notes}</td></tr>`;
    }).join('');

    const sessionRows = sessions.map(s => {
      const parts = [];
      if (s.prompts)    parts.push(`${s.prompts} prompts`);
      if (s.tally.bash) parts.push(`${s.tally.bash} bash`);
      if (s.tally.read) parts.push(`${s.tally.read} read`);
      if (s.tally.edit + s.tally.write) parts.push(`${s.tally.edit + s.tally.write} edit/write`);
      if (s.tally.web)  parts.push(`${s.tally.web} webfetch`);
      if (s.tally.mcp)  parts.push(`${s.tally.mcp} mcp`);
      const sev = [];
      if (s.sevTally.critical) sev.push(`${s.sevTally.critical} critical`);
      if (s.sevTally.high)     sev.push(`${s.sevTally.high} high`);
      if (s.sevTally.medium)   sev.push(`${s.sevTally.medium} medium`);
      if (s.sevTally.low)      sev.push(`${s.sevTally.low} low`);
      return `<tr><td>${escHtml(fmtTs(s.start))}</td><td>${fmtDur(s.end - s.start)}</td><td>${escHtml(s.sid)}</td><td>${parts.join(', ')}</td><td>${sev.join(', ')}</td></tr>`;
    }).join('');

    const riskBuckets = ['critical', 'high', 'medium', 'low'].map(k => {
      const b = buckets[k];
      const labels = Array.from(b.labels.entries()).sort((a, b) => b[1] - a[1])
        .map(([lbl, n]) => `<li>${escHtml(lbl)} — <strong>${n}</strong></li>`).join('') || '<li><em>(none)</em></li>';
      const subtitle = (k === 'critical' || k === 'high') && b.count > 0
        ? ` <span style="font-weight:600;font-size:12px;color:#444">· ${b.active} active · ${b.resolved} resolved</span>`
        : '';
      const resolvedSamples = b.samples.filter(s => s.resolved);
      const resolutionNotes = (k === 'critical' || k === 'high') && resolvedSamples.length
        ? `<p style="margin-top:10px;font-size:12px;color:#15803d"><strong>${resolvedSamples.length} resolved</strong> — see Full Event Log for the resolution notes per event.</p>`
        : '';
      return `<section class="risk ${k}">
  <h3>${k.toUpperCase()} (${b.count})${subtitle}</h3>
  <p>${escHtml(RISK_EXPLAINER[k])}</p>
  <ul>${labels}</ul>
  ${resolutionNotes}
</section>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Claude Code Audit · ${escHtml(cfg.repoLabel || 'Repo')} · ${generated.slice(0,10)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; padding: 32px; max-width: 1200px; margin: 0 auto; color: #222; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 30px; padding-bottom: 6px; border-bottom: 2px solid #EF4035; }
  h3 { font-size: 14px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 13px; margin-bottom: 28px; }
  .meta strong { color: #222; }
  .stats { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat { background: #f7f8fa; border: 1px solid #e3e6eb; border-radius: 8px; padding: 10px 16px; min-width: 110px; }
  .stat .n { font-size: 22px; font-weight: 800; }
  .stat .l { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat.crit .n { color: #b91c1c; } .stat.high .n { color: #c2410c; }
  .stat.med .n  { color: #a16207; } .stat.low .n  { color: #4d7c0f; }
  .risk { border-radius: 8px; padding: 14px; margin-bottom: 12px; border: 1px solid #ddd; }
  .risk.critical { background: #fef2f2; border-color: #fecaca; } .risk.critical h3 { color: #b91c1c; }
  .risk.high { background: #fff7ed; border-color: #fed7aa; }     .risk.high h3 { color: #c2410c; }
  .risk.medium { background: #fefce8; border-color: #fde68a; }    .risk.medium h3 { color: #a16207; }
  .risk.low { background: #f7fee7; border-color: #d9f99d; }       .risk.low h3 { color: #4d7c0f; }
  .risk p { margin: 0 0 8px; font-size: 12.5px; color: #555; }
  .risk ul { margin: 0; padding-left: 20px; font-size: 12.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 10px; }
  th { text-align: left; padding: 8px 10px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; background: #f7f8fa; border-bottom: 2px solid #e3e6eb; }
  td { padding: 7px 10px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  td.full { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: #777; word-break: break-all; }
  .footer { color: #888; font-size: 11px; margin-top: 30px; padding-top: 14px; border-top: 1px solid #e3e6eb; line-height: 1.55; }
  code { background: #f0f1f4; padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
</style></head>
<body>
<h1>Claude Code · Audit Report</h1>
<div class="meta">
  Hub: <strong>${escHtml(cfg.hubLabel || '')}</strong> · Repo: <strong>${escHtml(cfg.repoLabel || '')}</strong><br>
  Window: <strong>${escHtml(w)}</strong> · Working-directory filter: <code>${escHtml(cfg.repoFilter)}</code><br>
  Generated: <strong>${escHtml(generated)}</strong> · Events included: <strong>${eventsToInclude.length}</strong>
</div>

<h2>Summary</h2>
<div class="stats">
  <div class="stat"><div class="n">${eventsToInclude.length}</div><div class="l">Events</div></div>
  <div class="stat"><div class="n">${sessions.length}</div><div class="l">Sessions</div></div>
  <div class="stat"><div class="n">${eventsToInclude.filter(e => e.event === 'UserPromptSubmit').length}</div><div class="l">Prompts</div></div>
  <div class="stat"><div class="n">${eventsToInclude.filter(e => e.event === 'PreToolUse').length}</div><div class="l">Tool calls</div></div>
  <div class="stat"><div class="n">${eventsToInclude.filter(e => e.event === 'PostToolUseFailure').length}</div><div class="l">Failures</div></div>
  <div class="stat crit"><div class="n">${sevActive.critical}</div><div class="l">Active Critical</div>${sevTotals.critical ? `<div style="font-size:10px;color:#666;margin-top:3px">${sevTotals.critical - sevActive.critical}/${sevTotals.critical} resolved</div>` : ''}</div>
  <div class="stat high"><div class="n">${sevActive.high}</div><div class="l">Active High</div>${sevTotals.high ? `<div style="font-size:10px;color:#666;margin-top:3px">${sevTotals.high - sevActive.high}/${sevTotals.high} resolved</div>` : ''}</div>
  <div class="stat med"><div class="n">${sevTotals.medium}</div><div class="l">Medium</div></div>
  <div class="stat low"><div class="n">${sevTotals.low}</div><div class="l">Low</div></div>
</div>

<h2>Risk Assessment</h2>
<p style="font-size:12.5px;color:#555;">
  The taxonomy below classifies each tool call by the worst-case impact if Claude were compromised via prompt injection or shadow prompt during this session. Severities are based on what the call <em>could have done</em>, not what it actually did — a <em>curl POST</em> to a known business endpoint is logged the same as one to a hostile endpoint, so review the targets when severities are above Low.
</p>
${riskBuckets}

<h2>Sessions</h2>
<table>
  <thead><tr><th>Start</th><th>Duration</th><th>Session ID</th><th>Activity</th><th>Risk mix</th></tr></thead>
  <tbody>${sessionRows || '<tr><td colspan="5"><em>No sessions.</em></td></tr>'}</tbody>
</table>

<h2>Full Event Log</h2>
<p style="font-size:12.5px;color:#555;">Up to 5,000 most-recent events. Each row's <em>full</em> input JSON is in column 7 so IT can grep for sensitive values without scrolling. The <strong>Status</strong> column shows whether Critical/High alerts have been triaged: <span style="color:#b91c1c;font-weight:700">ACTIVE</span> = pending review, <span style="color:#15803d;font-weight:700">RESOLVED</span> = admin signed off (notes in the last column).</p>
<table>
  <thead><tr><th>When (local)</th><th>Event</th><th>Tool</th><th>Risk</th><th>Status</th><th>Input summary</th><th>Full input JSON</th><th>Resolution notes</th></tr></thead>
  <tbody>${eventRows || '<tr><td colspan="8"><em>No events.</em></td></tr>'}</tbody>
</table>

<div class="footer">
  Source of truth: <code>~/claude-audit/YYYY-MM-DD.log</code> on Keith King's workstation (chain-of-custody copy).<br>
  This HTML is mirrored from the <code>claude_audit_events</code> Supabase table, written via the <code>claude-audit-ingest</code> Netlify function from the Claude Code hook chain in <code>~/.claude/settings.json</code>.<br>
  Contact: kking@conferenceusa.com.
</div>
</body></html>`;
  }

  /* ── Wire download buttons inside report pane (event delegation) ─────── */
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.action === 'download-json') {
      const root = t.closest('.ca-root');
      const state = root && root._caState;
      if (state) downloadJsonl(state);
    }
  });

  // Stash state on the root for the delegated handler.
  const origInit = init;
  global.ClaudeAudit = {
    init: async function (cfg) {
      await origInit(cfg);
      if (cfg && cfg.container) {
        const root = cfg.container.querySelector('.ca-root');
        if (root) root._caState = null; // re-set below via outer scope
      }
    }
  };

  /* ── Active-alert indicator (used by Hub landing pages) ──────────────────
   * Lightweight surface showing "X active critical · Y active high" so the
   * admin sees pending risk alerts without having to open the Audit tab.
   * Hides when there are zero active alerts. */

  async function fetchActiveAlerts(opts) {
    const db = opts && opts.db;
    if (!db) return { critical: 0, high: 0, criticalTotal: 0, highTotal: 0, error: 'no db' };
    const days = (opts && opts.days) || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    try {
      // Pull only PreToolUse events from the window for this repo. We need
      // input/tool to classify (severity isn't stored in the DB) but skip
      // response/cwd/host etc. to keep the payload small.
      const { data, error } = await db.from('claude_audit_events')
        .select('id, event, tool, input, resolved_at, ts')
        .ilike('cwd', opts.repoFilter || '%')
        .eq('event', 'PreToolUse')
        .gte('ts', since)
        .order('ts', { ascending: false })
        .limit(2000);
      if (error) throw error;
      let crit = 0, high = 0, critTotal = 0, highTotal = 0;
      for (const e of (data || [])) {
        const sev = classify(e).sev;
        if (sev === 'critical') { critTotal++; if (!isResolved(e)) crit++; }
        else if (sev === 'high') { highTotal++; if (!isResolved(e)) high++; }
      }
      return { critical: crit, high: high, criticalTotal: critTotal, highTotal: highTotal, fetchedAt: Date.now() };
    } catch (e) {
      return { critical: 0, high: 0, criticalTotal: 0, highTotal: 0, error: e.message || String(e) };
    }
  }

  function _hasAdminSession(sessionKey) {
    if (!sessionKey) return true; // no gate
    try {
      const raw = localStorage.getItem(sessionKey);
      if (!raw) return false;
      try { const parsed = JSON.parse(raw); return !!(parsed && (parsed.email || parsed === true)); }
      catch { return raw === 'true' || raw.length > 0; }
    } catch { return false; }
  }

  function mountIndicator(opts) {
    if (!opts || !opts.container) return () => {};
    const refreshMs = opts.refreshMs || 60000;
    const cont = opts.container;
    cont.innerHTML = ''; // start hidden
    mountIndicatorCss();
    let timer = null, stopped = false;

    async function tick() {
      if (stopped) return;
      if (!_hasAdminSession(opts.sessionKey)) { cont.innerHTML = ''; return; }
      const r = await fetchActiveAlerts(opts);
      if (stopped) return;
      const total = (r.critical || 0) + (r.high || 0);
      if (!total || r.error) { cont.innerHTML = ''; return; }
      const link = opts.linkUrl || 'hub-admin.html';
      const hubLabel = opts.hubLabel || 'Audit';
      const parts = [];
      if (r.critical) parts.push(`<strong>${r.critical}</strong> Critical`);
      if (r.high)     parts.push(`<strong>${r.high}</strong> High`);
      cont.innerHTML = `
        <a class="ca-indicator" href="${link}" title="Open Claude Audit — Full Log to resolve">
          <span class="ca-indicator-icon">⚠</span>
          <span class="ca-indicator-text">
            <span class="ca-indicator-title">Claude Audit · ${parts.join(' · ')} active</span>
            <span class="ca-indicator-sub">${hubLabel} · ${total === 1 ? '1 alert' : total + ' alerts'} need review in the last ${(opts.days || 7)} days</span>
          </span>
          <span class="ca-indicator-cta">Review →</span>
        </a>`;
    }

    tick();
    timer = setInterval(tick, refreshMs);
    // Re-check when the user returns to the tab (so a session that just
    // signed in or out reflects immediately, and counts refresh).
    function onVis() { if (document.visibilityState === 'visible') tick(); }
    document.addEventListener('visibilitychange', onVis);

    return function stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  let _indicatorCssMounted = false;
  function mountIndicatorCss() {
    if (_indicatorCssMounted) return;
    const s = document.createElement('style');
    s.setAttribute('data-claude-audit-indicator', '1');
    s.textContent = `
      .ca-indicator {
        display: flex; align-items: center; gap: 14px;
        padding: 12px 18px;
        background: linear-gradient(90deg, rgba(220,38,38,0.95), rgba(234,88,12,0.95));
        color: #fff !important; text-decoration: none;
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(220,38,38,0.25);
        transition: transform .15s, box-shadow .15s;
        font-family: inherit;
        animation: ca-ind-pulse 2.4s ease-in-out infinite;
      }
      .ca-indicator:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(220,38,38,0.35);
      }
      .ca-indicator-icon { font-size: 22px; line-height: 1; }
      .ca-indicator-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
      .ca-indicator-title { font-size: 13px; font-weight: 800; letter-spacing: 0.3px; }
      .ca-indicator-sub { font-size: 11px; opacity: 0.92; font-weight: 500; }
      .ca-indicator-cta {
        font-size: 11px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase;
        background: rgba(255,255,255,0.18); padding: 6px 12px; border-radius: 4px;
        white-space: nowrap;
      }
      @keyframes ca-ind-pulse {
        0%, 100% { box-shadow: 0 4px 14px rgba(220,38,38,0.25); }
        50%      { box-shadow: 0 4px 14px rgba(220,38,38,0.55); }
      }
    `;
    document.head.appendChild(s);
    _indicatorCssMounted = true;
  }

  global.ClaudeAudit.fetchActiveAlerts = fetchActiveAlerts;
  global.ClaudeAudit.mountIndicator    = mountIndicator;

  // Replace shim with the real binding so download-json works.
  global.ClaudeAudit.init = async function (cfg) {
    mountCss();
    if (!cfg || !cfg.container) throw new Error('ClaudeAudit.init: container required');
    const state = newState();
    state.cfg = cfg;
    if (cfg.requiredEmail) {
      const u = (cfg.getUser && cfg.getUser()) || null;
      const email = (u && u.email ? String(u.email).toLowerCase() : '');
      if (email !== String(cfg.requiredEmail).toLowerCase()) {
        cfg.container.innerHTML = `
          <div class="ca-root">
            <div class="ca-restricted">
              <h3>🔒 Restricted</h3>
              <p>Claude Audit is only accessible to ${escHtml(cfg.requiredEmail)}. You are signed in as ${escHtml(email || 'unknown')}.</p>
            </div>
          </div>`;
        return;
      }
    }
    if (!cfg.db) {
      cfg.container.innerHTML = `<div class="ca-root"><div class="ca-empty">Supabase client not provided.</div></div>`;
      return;
    }
    cfg.container.innerHTML = renderSkeleton(state);
    const rootEl = cfg.container.querySelector('.ca-root');
    if (rootEl) rootEl._caState = state;
    wireSkeleton(state);
    await reload(state);
  };

})(window);
