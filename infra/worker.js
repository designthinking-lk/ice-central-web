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

export default {
  async fetch(request) {
    const url = new URL(request.url);
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
