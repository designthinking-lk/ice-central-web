/* ICE service worker — makes the site installable and gives a basic offline shell.
 * Strategy: network-first for every same-origin GET (never stale while online),
 * cache fallback when offline. Bump VERSION together with the ?v= asset bumps
 * in index.html so old caches are dropped on deploy. */
var VERSION = 'v112';
var CACHE = 'ice-' + VERSION;

var SHELL = [
  './',
  'index.html',
  'css/theme.css?v=51',
  'css/app.css?v=110',
  'assets/favicon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      });
    })
  );
});
