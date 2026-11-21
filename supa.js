/* e-Outsourcing: penghubung ke Supabase (tanpa pustaka tambahan).
 * Menggantikan call() lama (Apps Script) dengan antarmuka yang sama: call(fn, ...args) -> Promise(data)
 * Galat: Error dengan .code ('AUTH','MUSTCHANGE','FORBIDDEN','USER') atau .net=true bila koneksi gagal. */
(function () {
  var C = window.EO_CONFIG, KEY = 'eo2_sess';
  var base = C.SUPABASE_URL.replace(/\/+$/, '');
  var sess = null, refreshing = null;

  // sesi disimpan di localStorage agar tetap login setelah aplikasi/tab ditutup; hilang hanya saat Keluar atau sesi dicabut server
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function load() { if (sess) return sess; sess = read(); return sess; }
  function save(s) { sess = s; try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch (e) { /* abaikan */ } }
  // sinkron antar-tab: bila tab lain memperbarui/menghapus sesi, ikuti
  window.addEventListener('storage', function (e) { if (e.key === KEY) sess = read(); });
  function mkErr(msg, code, net) { var e = new Error(msg); if (code) e.code = code; if (net) e.net = true; return e; }
  function hdr(tok, extra) { var h = { apikey: C.SUPABASE_ANON_KEY }; if (tok) h.Authorization = 'Bearer ' + tok; for (var k in extra) h[k] = extra[k]; return h; }

  function fx(url, opt) {
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var tm = setTimeout(function () { if (ctl) ctl.abort(); }, 60000);
    opt.signal = ctl ? ctl.signal : undefined;
    return fetch(url, opt).then(function (r) { clearTimeout(tm); return r; }, function () { clearTimeout(tm); throw mkErr('Koneksi ke server gagal.', '', true); });
  }

  function setSession(j) {
    save({ access_token: j.access_token, refresh_token: j.refresh_token, exp: Math.floor(Date.now() / 1000) + (j.expires_in || 3600) });
  }
  function refresh() {
    if (refreshing) return refreshing;
    var s = load();
    if (!s || !s.refresh_token) return Promise.reject(mkErr('Sesi berakhir. Silakan login kembali.', 'AUTH'));
    var latest = read();
    if (latest && latest.exp - 60 > Date.now() / 1000) { sess = latest; return Promise.resolve(sess); } // tab lain sudah memperbarui
    if (latest) { sess = latest; s = latest; }
    refreshing = fx(base + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: hdr(null, { 'Content-Type': 'application/json' }), body: JSON.stringify({ refresh_token: s.refresh_token })
    }).then(function (r) {
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        var again = read();
        if (again && again.refresh_token !== s.refresh_token) { sess = again; return again; } // tab lain berhasil memutar token lebih dulu
        save(null); throw mkErr('Sesi berakhir. Silakan login kembali.', 'AUTH');
      }
      if (!r.ok) throw mkErr('Koneksi ke server gagal.', '', true);
      return r.json().then(function (j) { setSession(j); return sess; });
    }).then(function (v) { refreshing = null; return v; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  function token() {
    var s = load();
    if (!s) return Promise.reject(mkErr('Sesi berakhir. Silakan login kembali.', 'AUTH'));
    if (s.exp - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    return refresh().then(function (v) { return v.access_token; });
  }
  // permintaan berotorisasi; bila token ditolak (401) segarkan sekali lalu ulangi
  function authed(url, mk) {
    return token().then(function (t) {
      return fx(url, mk(t)).then(function (r) {
        if (r.status !== 401) return r;
        return refresh().then(function (v) { return fx(url, mk(v.access_token)); });
      });
    });
  }

  function rpc(fn, args) {
    return authed(base + '/rest/v1/rpc/api', function (t) {
      return { method: 'POST', headers: hdr(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ fn: fn, args: args }) };
    }).then(function (r) {
      if (r.status === 401) throw mkErr('Sesi berakhir. Silakan login kembali.', 'AUTH');
      if (r.status === 429) throw mkErr('Server sedang sibuk. Coba lagi beberapa saat.', '', true);
      if (r.status >= 500) throw mkErr('Server sedang bermasalah. Coba lagi.', '', true);
      return r.json().then(function (j) {
        if (j && j.ok) return j.data;
        throw mkErr((j && (j.error || j.message)) || 'Terjadi kesalahan.', j && j.code);
      });
    });
  }

  /* ---------- foto ---------- */
  function uid() { var s = load(); try { return JSON.parse(atob(s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch (e) { return ''; } }
  function dataToBlob(d) {
    var m = /^data:([^;]+);base64,(.*)$/.exec(d); if (!m) throw mkErr('Format foto tidak valid.', 'USER');
    var bin = atob(m[2]), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m[1] });
  }
  function upload(dataUrl) {
    return token().then(function () {
      var d = new Date(), ym = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2);
      var name = uid() + '/' + ym + '/' + Date.now().toString(36) + Math.random().toString(36).substr(2, 8) + '.jpg';
      var blob = dataToBlob(dataUrl);
      return authed(base + '/storage/v1/object/' + C.BUCKET + '/' + name, function (t) {
        return { method: 'POST', headers: hdr(t, { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }), body: blob };
      }).then(function (r) {
        if (r.status === 401 || r.status === 403) throw mkErr('Sesi berakhir. Silakan login kembali.', 'AUTH');
        if (r.status === 429 || r.status >= 500) throw mkErr('Server sedang sibuk. Coba lagi.', '', true);
        if (!r.ok) throw mkErr('Unggah foto gagal.', '', true);
        return name;
      });
    });
  }
  function fotoSrc(id) {
    id = String(id || '');
    if (id.indexOf('/') < 0) return Promise.resolve('https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w800'); // foto lama (Google Drive)
    return authed(base + '/storage/v1/object/' + C.BUCKET + '/' + id.split('/').map(encodeURIComponent).join('/'), function (t) {
      return { method: 'GET', headers: hdr(t) };
    }).then(function (r) {
      if (!r.ok) throw mkErr('Foto tidak ditemukan.', 'USER');
      return r.blob();
    }).then(function (b) {
      return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.readAsDataURL(b); });
    });
  }
  function isData(s) { return typeof s === 'string' && s.indexOf('data:image') === 0; }
  // ganti foto base64 di payload (foto / fotos) dengan jalur Storage sebelum dikirim
  function prepPayload(p) {
    if (!p || typeof p !== 'object') return Promise.resolve(p);
    var q = {}; for (var k in p) q[k] = p[k];
    var jobs = [];
    if (isData(q.foto)) jobs.push(upload(q.foto).then(function (n) { q.foto = n; }));
    if (Array.isArray(q.fotos)) {
      q.fotos = q.fotos.slice();
      q.fotos.forEach(function (f, i) { if (isData(f)) jobs.push(upload(f).then(function (n) { q.fotos[i] = n; })); });
    }
    return Promise.all(jobs).then(function () { return q; });
  }

  /* ---------- login / logout ---------- */
  function login(role, id, pw) {
    id = String(id || '').trim(); pw = String(pw || '');
    if (role !== 'admin' && !/^\d{16}$/.test(id)) return Promise.reject(mkErr('NIK harus 16 digit angka.', 'USER'));
    if (!id || !pw) return Promise.reject(mkErr('Lengkapi data login.', 'USER'));
    var email = (role === 'admin' ? id.toLowerCase().replace(/[^a-z0-9._-]/g, '') + '@a.' : id + '@t.') + C.EMAIL_DOMAIN;
    return fx(base + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: hdr(null, { 'Content-Type': 'application/json' }), body: JSON.stringify({ email: email, password: pw })
    }).then(function (r) {
      if (r.status === 429) throw mkErr('Terlalu banyak percobaan login. Tunggu beberapa menit lalu coba lagi.', 'USER');
      if (r.status >= 500) throw mkErr('Server sedang bermasalah. Coba lagi.', '', true);
      if (!r.ok) throw mkErr(role === 'admin' ? 'Username atau password salah.' : 'NIK atau PIN salah.', 'USER');
      return r.json();
    }).then(function (j) {
      setSession(j);
      return rpc('apiBootstrap', []).then(function (boot) {
        if (role === 'admin' && boot.role !== 'admin' || role !== 'admin' && boot.role !== 'tenaga') { save(null); throw mkErr('Akun tidak sesuai dengan jenis login.', 'USER'); }
        return { token: 'sb', boot: boot };
      }, function (e) { save(null); throw e; });
    });
  }
  function logout() {
    var s = load(); save(null);
    if (s && s.access_token) fx(base + '/auth/v1/logout?scope=local', { method: 'POST', headers: hdr(s.access_token) }).catch(function () {});
    return Promise.resolve(true);
  }

  // pembuatan/ubah akun login lewat Edge Function (kunci service_role hanya ada di server)
  function akun(fn, args) {
    return authed(base + '/functions/v1/akun', function (t) {
      return { method: 'POST', headers: hdr(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ fn: fn, args: args }) };
    }).then(function (r) {
      if (r.status === 429 || r.status >= 500 && r.status !== 546) throw mkErr('Server sedang sibuk. Coba lagi.', '', true);
      return r.json().then(function (j) {
        if (j && j.ok) return j.data;
        throw mkErr((j && (j.error || j.message)) || 'Terjadi kesalahan.', j && j.code);
      }, function () { throw mkErr('Layanan akun belum terpasang (Edge Function "akun").', 'USER'); });
    });
  }

  /* ---------- antarmuka lama ---------- */
  window.call = function (fn) {
    var a = Array.prototype.slice.call(arguments, 1);
    if (fn === 'apiLogin') return login(a[0], a[1], a[2]);
    if (fn === 'apiLogout') return logout();
    var args = a.slice(1);                       // buang argumen pertama (token lama)
    if (fn === 'apiFoto') return fotoSrc(args[0]);
    if (fn === 'apiTenagaSimpan' || fn === 'apiTenagaResetPin' || fn === 'apiTenagaHapus' || fn === 'apiAdminSimpan') return akun(fn, args);
    if (fn === 'apiPresensi' || fn === 'apiLaporanSimpan') {
      return prepPayload(args[0]).then(function (p) { return rpc(fn, [p]); });
    }
    return rpc(fn, args);
  };
  window.EO_HAS_SESSION = function () { return !!load(); };
})();
