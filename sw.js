/* e-Outsourcing: simpan berkas aplikasi di perangkat. Buka berikutnya langsung tampil dari cache;
 * versi terbaru diambil di latar belakang dan dipakai pada pembukaan berikutnya. Panggilan API (host lain) tidak disentuh.
 * Naikkan angka V setiap index.html / berkas di bawah diganti. */
var V = 'eo-shell-21';
var CORE = ['./', 'index.html', 'config.js', 'supa.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
self.addEventListener('install', function (e) {
  // pra-simpan berkas inti; kegagalan satu berkas tidak membatalkan pemasangan
  e.waitUntil(caches.open(V).then(function (c) {
    return Promise.all(CORE.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== V; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin !== location.origin) return;
  e.respondWith(caches.open(V).then(function (c) {
    return c.match(r, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(r).then(function (res) { if (res && res.ok) c.put(r, res.clone()); return res; }).catch(function () { return hit || (r.mode === 'navigate' ? c.match('index.html') : undefined); });
      return hit || net;
    });
  }));
});
