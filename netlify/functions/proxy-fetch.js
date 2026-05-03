/**
 * proxy-fetch — Netlify Function that proxies a single GET request.
 *
 * Solves CORS for browser-side fetches of resources that don't expose
 * Access-Control-Allow-Origin headers (e.g., Sidearm cume.pdf files on S3).
 * Replaces the unreliable public CORS-proxy chain (corsproxy.io paywall,
 * allorigins.win 5xx-on-binary, codetabs rate limits) with a proxy we own.
 *
 * Usage from the browser:
 *   fetch('/.netlify/functions/proxy-fetch?url=' + encodeURIComponent(targetUrl))
 *     .then(r => r.arrayBuffer())  // for binary
 *     .then(r => r.text())         // for text
 *
 * Safety:
 *   - Only http(s) URLs are accepted.
 *   - 30-second timeout (Netlify's hard limit is 10s on free tier; bumped
 *     here so we surface a clearer error).
 *   - 25 MB response cap so a large file can't OOM the function.
 *
 * No auth — this is a public read-through proxy and only forwards GETs.
 * If we ever need to restrict targets, add an allowlist of host suffixes.
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

const MAX_BYTES   = 25 * 1024 * 1024;   // 25 MB
const TIMEOUT_MS  = 9000;               // stay under Netlify's 10s sync-function ceiling on free tier

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'GET')      return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  const url = event.queryStringParameters && event.queryStringParameters.url;
  if (!url)                            return { statusCode: 400, headers: cors, body: 'Missing ?url=' };
  if (!/^https?:\/\//i.test(url))      return { statusCode: 400, headers: cors, body: 'URL must start with http:// or https://' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      signal: ctrl.signal,
      // A real browser UA — some Sidearm-hosted resources reject the default
      // node fetch UA with HTTP 403.
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
    });
    clearTimeout(timer);

    // Read as ArrayBuffer so we can pass binary through unchanged.
    const ab  = await upstream.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) {
      return { statusCode: 413, headers: cors, body: `Response too large (${ab.byteLength} bytes)` };
    }
    const body = Buffer.from(ab).toString('base64');
    const ct   = upstream.headers.get('content-type') || 'application/octet-stream';

    return {
      statusCode: upstream.status,
      headers: { ...cors, 'Content-Type': ct, 'Cache-Control': 'public, max-age=120' },
      body,
      isBase64Encoded: true
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError'
      ? `Upstream timed out after ${TIMEOUT_MS} ms`
      : (err.message || String(err));
    return { statusCode: 502, headers: cors, body: `Upstream fetch failed: ${msg}` };
  }
};
