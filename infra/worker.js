/* ICE central-web subdomain proxy.
 *
 * WHY THIS EXISTS: every ICE project runs on its own subdomain
 * ({slug}.designthinking.lk), but the SPA is a single GitHub Pages build and
 * GitHub Pages binds only ONE custom domain per repo (ice2026.designthinking.lk).
 * So a freshly-created project subdomain, CNAME'd to github.io, would 404. This
 * Worker reverse-proxies EVERY request on a project subdomain to the canonical
 * GitHub Pages build, so the same SPA is served under any hostname. The app then
 * reads its project slug from location.hostname (see js/api.js projectFromHost).
 *
 * ROUTING: Cloudflare Worker routes run ONLY for proxied (orange-cloud) DNS
 * records. Existing subdomains (ice2026, ice2025, ice, www) are DNS-only (gray)
 * and keep hitting GitHub Pages directly — this Worker never runs for them.
 * Only new project subdomains, created proxied by admin_create_project, use it.
 *
 * When the ice.designthinking.lk cutover happens, update CANONICAL_ORIGIN. */

const CANONICAL_ORIGIN = 'https://ice2026.designthinking.lk';
const API_URL = 'https://script.google.com/macros/s/AKfycbz0THh0OrmG8umv5ZomVvv1kQu7Ogs1jYp2tKqJFOe6gAMWGnL5Y5_Ww5hZOFVeNSA/exec';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // --- Drive video proxy: /vid/<fileId> ---------------------------------
    // Google Drive refuses to serve a video to a browser <video> element
    // (works server-side only). This Worker fetches the file server-side — where
    // Drive DOES serve it — and relays the bytes to the browser with byte-range
    // support + permissive CORS, so uploaded intro/pitch clips actually play.
    const vm = url.pathname.match(/^\/vid\/([A-Za-z0-9_-]+)$/);
    if (vm) return proxyDriveVideo(vm[1], request);

    // --- Social share cards: card.designthinking.lk/u|p/<id> --------------
    // Hash-routed SPA + static host = no per-page OG. This edge route fetches
    // the public card fields and returns a page with dynamic OG tags for social
    // crawlers; real browsers are bounced into the app.
    if (url.hostname.startsWith('card.')) {
      const cm = url.pathname.match(/^\/(u|p)\/([\w-]+)\/?$/);
      if (cm) return renderShareCard(cm[1], cm[2], url);
      return Response.redirect(CANONICAL_ORIGIN + '/', 302);
    }

    const subdomain = extractSubdomain(url.hostname);

    // Preserve the full path AND query string — the SPA cache-busts assets with
    // ?v=… and deep-links with ?project=…, so dropping the query breaks it.
    const upstream = CANONICAL_ORIGIN + url.pathname + url.search;

    // Code files must never be cached at the edge (the app bumps ?v= per deploy
    // but users on a proxied subdomain must always get the newest shell).
    const ext = (url.pathname.split('.').pop() || '').toLowerCase();
    const isCodeFile = ['html', 'js', 'css'].includes(ext) || url.pathname === '/' || !url.pathname.includes('.');

    try {
      let res = await fetch(upstream, {
        method: request.method,
        headers: { 'Accept': request.headers.get('Accept') || '*/*' },
        redirect: 'follow',
        cf: { cacheTtl: isCodeFile ? 0 : 3600, cacheEverything: !isCodeFile },
      });

      // SPA safety net: an unknown path falls back to the app shell.
      if (res.status === 404) {
        res = await fetch(CANONICAL_ORIGIN + '/index.html', {
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        return buildResponse(res, subdomain, true);
      }

      return buildResponse(res, subdomain, isCodeFile);
    } catch (err) {
      return new Response('Proxy error: ' + err.message, { status: 502 });
    }
  },
};

// Render an OG-tagged share page for a member (u) or project (p). Fetches the
// public card fields from the API; on any failure falls back to the generic
// site card so the link never breaks.
async function renderShareCard(kind, id, url) {
  const project = url.searchParams.get('project') || 'ice2026';
  let card = null;
  try {
    // Apps Script /exec answers a POST with a 302 to a googleusercontent URL that
    // serves the JSON — but that second hop must be a GET (auto-follow keeps POST
    // and errors), so follow the redirect manually.
    let r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'og_card', kind, id, project }),
      redirect: 'manual',
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (loc) r = await fetch(loc); // GET the content response
    }
    const data = await r.json();
    card = data && data.card;
  } catch (e) { /* generic fallback below */ }

  const appUrl = (card && card.appUrl) || (CANONICAL_ORIGIN + '/');
  const title  = (card && card.title) || 'ICE — Design Thinking Workshops';
  const desc   = (card && card.description) || 'Meet the mentors and participants, form teams, and build together.';
  const image  = (card && card.image) || (CANONICAL_ORIGIN + '/assets/og-image-v3.jpg');
  const twCard = (card && card.square) ? 'summary' : 'summary_large_image';
  const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html =
`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="ICE — Design Thinking Workshops">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:image" content="${e(image)}">
<meta property="og:url" content="${e(appUrl)}">
<meta name="twitter:card" content="${e(twCard)}">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(desc)}">
<meta name="twitter:image" content="${e(image)}">
<link rel="canonical" href="${e(appUrl)}">
<meta http-equiv="refresh" content="0; url=${e(appUrl)}">
<style>body{font:15px/1.5 system-ui,sans-serif;margin:40px;color:#222}</style>
</head><body>
<p>Opening <a href="${e(appUrl)}">${e(title)}</a>…</p>
<script>location.replace(${JSON.stringify(appUrl)})</script>
</body></html>`;
  return new Response(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'X-Ice-Card': kind + ':' + id,
  } });
}

// Stream a public Drive file through the Worker. `confirm=t` skips the
// large-file scan interstitial; Range is forwarded so <video> can seek/loop.
async function proxyDriveVideo(id, request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    }});
  }
  const driveUrl = 'https://drive.usercontent.google.com/download?id=' + id + '&export=download&confirm=t';
  // Always send a Range (default the whole file) — a plain no-range fetch to the
  // Drive endpoint intermittently trips a Worker subrequest error, whereas the
  // range path is reliable, and <video> always range-requests anyway.
  const range = request.headers.get('Range') || 'bytes=0-';
  const upstream = await fetch(driveUrl, {
    method: 'GET',
    headers: { 'Range': range },
    redirect: 'follow',
  });
  const ct = upstream.headers.get('Content-Type') || '';
  // A non-video content type means Drive returned an interstitial/HTML — surface
  // it as an error rather than feeding garbage to the <video>.
  const okType = /^(video\/|application\/octet-stream|application\/binary)/i.test(ct);
  const headers = new Headers({
    'Content-Type': okType ? (ct || 'video/mp4') : 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400',
    'X-Ice-Media': 'drive-proxy',
  });
  ['Content-Length', 'Content-Range'].forEach(function (k) {
    var v = upstream.headers.get(k); if (v) headers.set(k, v);
  });
  return new Response(upstream.body, { status: upstream.status, headers: headers });
}

// Any {sub}.designthinking.lk except www.
function extractSubdomain(hostname) {
  const m = /^([a-z0-9-]+)\.designthinking\.lk$/i.exec(hostname);
  if (m && m[1].toLowerCase() !== 'www') return m[1].toLowerCase();
  return null;
}

function buildResponse(res, subdomain, noCache) {
  const headers = new Headers({
    'Content-Type': res.headers.get('Content-Type') || 'text/html; charset=utf-8',
    'X-Ice-Project': subdomain || 'none',
  });
  if (noCache) {
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    headers.set('CDN-Cache-Control', 'no-store');
    headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  } else {
    headers.set('Cache-Control', 'public, max-age=3600');
  }
  return new Response(res.body, { status: res.status, headers: headers });
}
