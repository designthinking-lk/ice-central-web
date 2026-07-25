/* ICE API client — talks to the Apps Script backend.
 * POST with Content-Type text/plain = CORS "simple request", no preflight.
 *
 * Multi-project: the signed-in identity (token) is GLOBAL — one sign-in works
 * across every project. Everything project-scoped (bootstrap cache, and in
 * app.js the register draft and chat state) is keyed per project slug so
 * switching projects can never leak one project's data into another. */
(function () {
  'use strict';

  var C = window.ICE_CONFIG;
  var TOKEN_KEY = 'ice.token';
  var PROJECT_KEY = 'ice.project';
  var ROUTE_KEY = 'ice.postLoginRoute';

  // One-time migration of pre-multi-project localStorage keys, so nobody has
  // to sign in again (or lose a register draft) when this frontend ships.
  (function migrateLegacyKeys() {
    var moves = {
      'ice2026.token': TOKEN_KEY,
      'ice2026.bootstrap': 'ice.bootstrap.ice2026',
      'ice2026.regdraft': 'ice.regdraft.ice2026',
      'ice2026.chat': 'ice.chat.ice2026',
      'ice2026.sidebar': 'ice.sidebar',
    };
    try {
      Object.keys(moves).forEach(function (oldKey) {
        var v = localStorage.getItem(oldKey);
        if (v !== null) {
          if (localStorage.getItem(moves[oldKey]) === null) localStorage.setItem(moves[oldKey], v);
          localStorage.removeItem(oldKey);
        }
      });
    } catch (e) { /* private mode */ }
  })();

  function getToken() { return localStorage.getItem(TOKEN_KEY) || null; }
  function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

  // Each project lives on its own subdomain ({slug}.designthinking.lk), so on
  // production the HOSTNAME is the single source of truth for the active project
  // — one subdomain can only ever act as one project, which is what hard-isolates
  // every cache/session bucket per origin. Returns null off-production (localhost,
  // github.io, apex, www) where the localStorage/?project switcher still applies.
  function projectFromHost() {
    var m = /^([a-z0-9-]+)\.designthinking\.lk$/i.exec(location.hostname);
    if (m && m[1].toLowerCase() !== 'www') return m[1].toLowerCase();
    return null;
  }

  function getProject() {
    return projectFromHost() || localStorage.getItem(PROJECT_KEY) || C.DEFAULT_PROJECT;
  }
  function setProject(id) {
    id ? localStorage.setItem(PROJECT_KEY, id) : localStorage.removeItem(PROJECT_KEY);
  }

  function cacheKey() { return 'ice.bootstrap.' + getProject(); }

  /** Core call. Returns parsed JSON; throws Error with .code on failure.
   * Apps Script's edge occasionally serves a one-off error page without CORS
   * headers (surfaces as TypeError "Failed to fetch") — identical requests
   * succeed moments later, so network-level failures get retried. Server-side
   * guards make the write actions safe to repeat (register → 'exists', etc.). */
  async function api(action, params) {
    var body = Object.assign({ action: action }, params || {});
    if (!body.project) body.project = getProject();
    var token = getToken();
    if (token && !body.token) body.token = token;
    var payload = JSON.stringify(body);
    var res = null;
    for (var attempt = 0; ; attempt++) {
      try {
        res = await fetch(C.API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: payload,
          redirect: 'follow',
        });
        break;
      } catch (netErr) {
        if (attempt >= 2) {
          var e = new Error('Could not reach the server — check your connection and try again.');
          e.code = 'network';
          throw e;
        }
        await new Promise(function (r) { setTimeout(r, 600 * (attempt + 1)); });
      }
    }
    var data = await res.json();
    if (data && data.ok === false) {
      if (data.error === 'auth') setToken(null); // expired/invalid token
      var err = new Error(data.message || data.error || 'Request failed');
      err.code = data.error;
      throw err;
    }
    return data;
  }

  /** Capture #icetoken=... handed back by the auth broker. */
  function absorbLoginToken() {
    var h = location.hash || '';
    var m = h.match(/[#&]icetoken=([^&]+)/);
    if (!m) return false;
    setToken(decodeURIComponent(m[1]));
    var back = sessionStorage.getItem(ROUTE_KEY) || '#/';
    sessionStorage.removeItem(ROUTE_KEY);
    history.replaceState(null, '', location.pathname + location.search + back);
    return true;
  }

  function signIn() {
    sessionStorage.setItem(ROUTE_KEY, location.hash || '#/');
    var redirect = location.origin + location.pathname;
    location.href = C.AUTH_URL + '?redirect=' + encodeURIComponent(redirect);
  }

  function signOut() {
    setToken(null);
    // Signing out is global (one identity) — drop every project's cached
    // bootstrap so no member state survives the reload.
    try {
      Object.keys(localStorage)
        .filter(function (k) { return k.indexOf('ice.bootstrap.') === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* private mode */ }
    sessionStorage.removeItem(ROUTE_KEY);
    // Hard reset to the public home so no member state can survive the reload.
    location.replace(location.pathname + location.search + '#/');
    location.reload();
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch (e) { return null; }
  }
  function writeCache(data) {
    try { localStorage.setItem(cacheKey(), JSON.stringify(data)); } catch (e) { /* quota */ }
  }

  window.IceApi = {
    api: api,
    getToken: getToken,
    setToken: setToken,
    getProject: getProject,
    setProject: setProject,
    projectFromHost: projectFromHost,
    signIn: signIn,
    signOut: signOut,
    absorbLoginToken: absorbLoginToken,
    readCache: readCache,
    writeCache: writeCache,
  };
})();
