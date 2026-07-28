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

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { INTER_BOLD_B64 } from './font-inter-bold.js';

const CANONICAL_ORIGIN = 'https://ice2026.designthinking.lk';
const API_URL = 'https://script.google.com/macros/s/AKfycbz0THh0OrmG8umv5ZomVvv1kQu7Ogs1jYp2tKqJFOe6gAMWGnL5Y5_Ww5hZOFVeNSA/exec';

// resvg wasm is initialised once per isolate; the bold font is decoded once.
let _resvgReady = null;
function ensureResvg() { if (!_resvgReady) _resvgReady = initWasm(resvgWasm); return _resvgReady; }
let _font = null;
function fontBytes() {
  if (!_font) { const b = atob(INTER_BOLD_B64); _font = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) _font[i] = b.charCodeAt(i); }
  return _font;
}

// pc-1..6 gradient stops (mirror the app's project card palette); default = brand.
const PC_GRADIENTS = {
  'pc-1': ['#00D7EE', '#6100FF'], 'pc-2': ['#00C9A7', '#005F73'], 'pc-3': ['#FF9966', '#FF3D77'],
  'pc-4': ['#4E65FF', '#1B2A78'], 'pc-5': ['#F953C6', '#B91D73'], 'pc-6': ['#232A34', '#0F766E'],
};
const xml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

// Fetch the member photo and inline it as a data URI so resvg can draw it.
async function photoDataUri(urlOrId) {
  try {
    let src = urlOrId;
    const m = String(src).match(/\/d\/([^/?]+)/);
    if (m) src = 'https://lh3.googleusercontent.com/d/' + m[1]; // lh3 serves the JPEG
    const r = await fetch(src, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return 'data:' + ct + ';base64,' + btoa(bin);
  } catch (e) { return ''; }
}

function projectCardSvg(c) {
  const g = PC_GRADIENTS[c.color] || ['#00D7EE', '#6100FF'];
  const title = clip(c.name || 'Project', 30);
  const tSize = title.length <= 13 ? 92 : title.length <= 20 ? 74 : 58;
  const desc = clip(c.subtitle || '', 64);
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${g[0]}"/><stop offset="1" stop-color="${g[1]}"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<circle cx="1120" cy="70" r="220" fill="rgba(255,255,255,0.08)"/>
<text x="80" y="140" font-family="Inter" font-weight="700" font-size="26" letter-spacing="4" fill="rgba(255,255,255,0.85)">${xml((c.event || 'ICE') + ' · PROJECT')}</text>
<text x="80" y="330" font-family="Inter" font-weight="700" font-size="${tSize}" fill="#ffffff">${xml(title)}</text>
${desc ? `<text x="80" y="410" font-family="Inter" font-weight="700" font-size="31" fill="rgba(255,255,255,0.92)">${xml(desc)}</text>` : ''}
<text x="80" y="562" font-family="Inter" font-weight="700" font-size="24" letter-spacing="1" fill="rgba(255,255,255,0.72)">DT@SL · designthinking.lk</text>
</svg>`;
}

function memberCardSvg(c, photo) {
  const name = clip(c.name || 'Member', 24);
  const nSize = name.length <= 13 ? 76 : name.length <= 19 ? 60 : 48;
  const sub = clip(c.subtitle || '', 34);
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00D7EE"/><stop offset="1" stop-color="#6100FF"/></linearGradient>
<clipPath id="pc"><circle cx="290" cy="315" r="196"/></clipPath></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<rect width="1200" height="630" fill="rgba(10,8,24,0.28)"/>
${photo ? `<image href="${photo}" x="94" y="119" width="392" height="392" preserveAspectRatio="xMidYMid slice" clip-path="url(#pc)"/>` : `<circle cx="290" cy="315" r="196" fill="rgba(255,255,255,0.14)"/>`}
<circle cx="290" cy="315" r="196" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="5"/>
<text x="558" y="216" font-family="Inter" font-weight="700" font-size="24" letter-spacing="4" fill="rgba(255,255,255,0.85)">${xml(c.event || 'ICE')}</text>
<text x="558" y="312" font-family="Inter" font-weight="700" font-size="${nSize}" fill="#ffffff">${xml(name)}</text>
${sub ? `<text x="558" y="374" font-family="Inter" font-weight="700" font-size="28" fill="rgba(255,255,255,0.9)">${xml(sub)}</text>` : ''}
<text x="558" y="540" font-family="Inter" font-weight="700" font-size="24" letter-spacing="1" fill="rgba(255,255,255,0.72)">DT@SL · designthinking.lk</text>
</svg>`;
}

async function renderCardImage(kind, id, url) {
  const project = url.searchParams.get('project') || 'ice2026';
  let card = null;
  try {
    let r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'og_card', kind, id, project }), redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (loc) r = await fetch(loc); }
    const d = await r.json(); card = d && d.card;
  } catch (e) { /* fall through */ }
  if (!card) return new Response('not found', { status: 404 });

  let svg;
  if (kind === 'p') svg = projectCardSvg(card);
  else svg = memberCardSvg(card, card.photo ? await photoDataUri(card.photo) : '');

  await ensureResvg();
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: { fontBuffers: [fontBytes()], defaultFontFamily: 'Inter', loadSystemFonts: false },
  }).render().asPng();
  return new Response(png, { status: 200, headers: {
    'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600', 'X-Ice-Card-Img': kind + ':' + id,
  } });
}

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
      const im = url.pathname.match(/^\/img\/(u|p)\/([\w-]+)\/?$/);
      if (im) return renderCardImage(im[1], im[2], url);       // generated OG PNG
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
  // Prefer the generated branded card image on our own domain; the API's plain
  // image (photo/default) is only a fallback if we couldn't resolve the card.
  const image  = card ? (url.origin + '/img/' + kind + '/' + id + '?project=' + encodeURIComponent(project))
                      : (CANONICAL_ORIGIN + '/assets/og-image-v3.jpg');
  const twCard = 'summary_large_image';
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
