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
    var data = null;
    for (var attempt = 0; ; attempt++) {
      try {
        var res = await fetch(C.API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: payload,
          redirect: 'follow',
        });
        // Apps Script's 302 -> googleusercontent echo intermittently 404s (and
        // returns HTML, not JSON). Treat a non-OK status or an unparseable body
        // as transient and retry, rather than surfacing a hard failure.
        if (!res.ok) throw new Error('http_' + res.status);
        data = JSON.parse(await res.text());
        break;
      } catch (netErr) {
        if (attempt >= 3) {
          var e = new Error('Could not reach the server — check your connection and try again.');
          e.code = 'network';
          throw e;
        }
        await new Promise(function (r) { setTimeout(r, 500 * (attempt + 1)); });
      }
    }
    if (data && data.ok === false) {
      if (data.error === 'auth') setToken(null); // expired/invalid token
      var err = new Error(data.message || data.error || 'Request failed');
      err.code = data.error;
      throw err;
    }
    return data;
  }

  /** Like api(), but over XMLHttpRequest so uploads report byte progress.
   * onProgress(loaded, total, sent) — `sent` is true once the whole body has
   * left the browser (the server is now processing). Same text/plain simple
   * request; XHR follows the Apps Script 302 to the content response. */
  function apiUpload(action, params, onProgress) {
    return new Promise(function (resolve, reject) {
      var body = Object.assign({ action: action }, params || {});
      if (!body.project) body.project = getProject();
      var token = getToken();
      if (token && !body.token) body.token = token;
      var xhr = new XMLHttpRequest();
      xhr.open('POST', C.API_URL, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
      xhr.timeout = 180000;
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded, e.total, false); };
        xhr.upload.onload = function () { onProgress(1, 1, true); }; // body sent → server processing
      }
      xhr.onload = function () {
        var data;
        try { data = JSON.parse(xhr.responseText); }
        catch (e) { reject(new Error('The server sent an unexpected response.')); return; }
        if (data && data.ok === false) {
          if (data.error === 'auth') setToken(null);
          var err = new Error(data.message || data.error || 'Request failed');
          err.code = data.error; reject(err); return;
        }
        resolve(data);
      };
      xhr.onerror = function () { reject(new Error('Could not reach the server — check your connection and try again.')); };
      xhr.ontimeout = function () { reject(new Error('Upload timed out — try a shorter or smaller clip.')); };
      xhr.send(JSON.stringify(body));
    });
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
    // The auth broker exec URL carries no /u/N/ account index. On a browser
    // signed into several Google accounts, hitting it directly lets Google PIN
    // whichever account sits in slot /u/2/ etc. — and if that guessed slot is
    // stale or lacks access, the visitor dead-ends on Google's "unable to open
    // the file" page before our doGet ever runs. Route through AccountChooser
    // so the user consciously PICKS the account (Google then resolves the right
    // slot). continue= must stay on a Google-owned host — script.google.com is.
    var exec = C.AUTH_URL + '?redirect=' + encodeURIComponent(redirect);
    location.href = 'https://accounts.google.com/AccountChooser?continue=' +
      encodeURIComponent(exec);
  }

  function signOut() {
    setToken(null);
    // Signing out is global (one identity) — drop every project's cached
    // bootstrap, half-filled registration draft, and chat state so NO member
    // state survives the reload (otherwise the next account signed in on this
    // browser would inherit the previous person's card / draft).
    try {
      Object.keys(localStorage)
        .filter(function (k) {
          return k.indexOf('ice.bootstrap.') === 0 ||
                 k.indexOf('ice.regdraft.') === 0 ||
                 k.indexOf('ice.editdraft.') === 0 ||
                 k.indexOf('ice.chat.') === 0;
        })
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
    apiUpload: apiUpload,
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
