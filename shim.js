/*
 * Camada de conexão: entrega para a interface o mesmo "banco de dados ao vivo"
 * que existia dentro do Claude, mas falando com o servidor da Mesa Viva.
 * Identidade: cada navegador cria uma chave secreta aleatória e guarda nele.
 * O servidor só enxerga um identificador derivado dela. Sem login.
 */
(function () {
  'use strict';
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } }
  };
  function rand(bytes) {
    var a = new Uint8Array(bytes); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  var secret = LS.get('mv.secret');
  if (!secret || secret.length < 16) { secret = rand(24); LS.set('mv.secret', secret); }
  var sid = rand(12);

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-secret': secret }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw { code: j.code || 'unavailable', message: '' };
          return j;
        });
      }, function () { throw { code: 'unavailable', message: 'sem rede' }; });
  }

  var pidPromise = null;
  function whoami() {
    if (!pidPromise) pidPromise = post('/api/whoami').then(function (j) { return j.id; }).catch(function () { pidPromise = null; return null; });
    return pidPromise;
  }

  /* ----- reserva local da sala do mestre (o servidor gratuito esquece tudo ao dormir) ----- */
  var mem = {};
  function cacheKey(code) { return 'mv.cache.' + code; }
  function track(path, snap, pid) {
    var m = /^rooms\/([A-Z]{4})(\/chars)?$/.exec(path);
    if (!m || !pid) return;
    var code = m[1]; var c = mem[code] = mem[code] || {};
    if (!m[2] && snap.exists) c.room = snap.data;
    if (m[2] && snap.docs) { c.chars = {}; snap.docs.forEach(function (d) { c.chars[d.id] = d.data; }); }
    if (c.room && c.chars && c.room.hostId === pid) LS.set(cacheKey(code), JSON.stringify({ room: c.room, chars: c.chars }));
  }
  function readCache(code) { try { return JSON.parse(LS.get(cacheKey(code)) || 'null'); } catch (e) { return null; } }
  function cachedRoomCodes(pid) {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('mv.cache.') === 0) { var c = readCache(k.slice(9)); if (c && c.room && c.room.hostId === pid) out.push(k.slice(9)); }
      }
    } catch (e) { /* sem armazenamento */ }
    return out;
  }
  function restore(code, pid) {
    var c = readCache(code);
    if (!c || !c.room || c.room.hostId !== pid) return Promise.resolve(false);
    var chain = post('/api/op', { op: 'set', path: 'rooms/' + code, data: { code: code, hostId: pid, createdAt: c.room.createdAt || Date.now() } });
    Object.keys(c.chars || {}).forEach(function (id) {
      chain = chain.then(function () { return post('/api/op', { op: 'set', path: 'rooms/' + code + '/chars/' + id, data: c.chars[id] }); });
    });
    return chain.then(function () { return true; }, function () { return false; });
  }

  /* ----- assinaturas ao vivo ----- */
  var subs = {}; var nextSub = 1;
  var es = null; var lastEvent = Date.now();
  function snapDoc(id, snap) {
    return { id: id, exists: !!snap.exists, data: function () { return snap.exists ? snap.data : undefined; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function snapQuery(snap) {
    var docs = snap.docs.map(function (d) { return snapDoc(d.id, { exists: true, data: d.data }); });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: function () { return []; } };
  }
  function deliver(s, snap) {
    var json = JSON.stringify(snap);
    if (json === s.last) return;
    s.last = json;
    whoami().then(function (pid) { track(s.path, snap, pid); });
    try { s.next(s.isDoc ? snapDoc(s.path.split('/').pop(), snap) : snapQuery(snap)); } catch (e) { setTimeout(function () { throw e; }, 0); }
  }
  function connect() {
    if (es) { try { es.close(); } catch (e) { /* já fechado */ } }
    lastEvent = Date.now();
    es = new EventSource('/api/events?sid=' + sid);
    es.addEventListener('ping', function () { lastEvent = Date.now(); });
    es.addEventListener('snap', function (ev) {
      lastEvent = Date.now();
      var m = JSON.parse(ev.data); var s = subs[m.subId];
      if (s) deliver(s, m.snap);
    });
  }
  setInterval(function () { if (es && Date.now() - lastEvent > 45000) connect(); }, 10000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && es && Date.now() - lastEvent > 20000) connect(); });
  // mantém o servidor gratuito acordado enquanto alguém está com a página aberta
  setInterval(function () { if (!document.hidden) post('/api/ping').catch(function () { /* tenta de novo depois */ }); }, 4 * 60 * 1000);

  function subscribe(path, filters, isDoc, next, error) {
    if (!es) connect();
    var id = String(nextSub++);
    var s = subs[id] = { path: path, isDoc: isDoc, next: next, last: '', alive: true };
    post('/api/sub', { sid: sid, subId: id, path: path, filters: filters }).then(function (r) { if (s.alive) deliver(s, r.snap); },
      function (e) { if (s.alive && error) error(e); });
    return function () { s.alive = false; delete subs[id]; post('/api/unsub', { sid: sid, subId: id }).catch(function () { /* ignora */ }); };
  }

  /* ----- interface de banco ----- */
  function docRef(path) {
    var ref = {
      id: path.split('/').pop(), path: path,
      get: function () {
        return post('/api/op', { op: 'get', path: path }).then(function (j) {
          var m = /^rooms\/([A-Z]{4})$/.exec(path);
          if (j.exists || !m) return snapDoc(ref.id, j);
          return whoami().then(function (pid) { return restore(m[1], pid); }).then(function (ok) {
            return ok ? post('/api/op', { op: 'get', path: path }).then(function (k) { return snapDoc(ref.id, k); }) : snapDoc(ref.id, j);
          });
        });
      },
      set: function (data) { return post('/api/op', { op: 'set', path: path, data: data }).then(function () {}); },
      update: function (data) { return post('/api/op', { op: 'update', path: path, data: data }).then(function () {}); },
      delete: function () {
        var m = /^rooms\/([A-Z]{4})$/.exec(path);
        return post('/api/op', { op: 'delete', path: path }).then(function () { if (m) { LS.del(cacheKey(m[1])); delete mem[m[1]]; } });
      },
      acquire: function (o) { return post('/api/op', { op: 'acquire', path: path, ttlMs: o && o.ttlMs }); },
      onSnapshot: function (next, error) { return subscribe(path, [], true, next, error); },
      collection: function (p) { return colRef(path + '/' + p); }
    };
    return ref;
  }
  function query(path, filters) {
    return {
      where: function (f, op, v) { return query(path, filters.concat([[f, op, v]])); },
      orderBy: function () { return this; }, limit: function () { return this; },
      get: function () {
        return post('/api/op', { op: 'query', path: path, filters: filters }).then(function (j) {
          if (path !== 'rooms') return snapQuery(j);
          return whoami().then(function (pid) {
            var have = {}; j.docs.forEach(function (d) { have[d.id] = true; });
            cachedRoomCodes(pid).forEach(function (code) { if (!have[code]) j.docs.push({ id: code, data: readCache(code).room }); });
            return snapQuery(j);
          });
        });
      },
      onSnapshot: function (next, error) { return subscribe(path, filters, false, next, error); }
    };
  }
  function colRef(path) {
    var q = query(path, []);
    q.path = path;
    q.doc = function (id) { return docRef(path + '/' + (id || ('a' + rand(6)))); };
    q.add = function (data) { var r = q.doc(); return r.set(data).then(function () { return r; }); };
    return q;
  }
  var db = { doc: docRef, collection: colRef };
  var user = {
    id: function () { return whoami(); },
    can: function () { return Promise.resolve(true); },
    isOwner: function () { return Promise.resolve(false); },
    canEdit: function () { return Promise.resolve(false); },
    me: function () { return whoami().then(function (id) { return { id: id, name: '', isOwner: false, canEdit: false }; }); }
  };
  window.claude = { use: function (name) { return Promise.resolve(name === 'db' ? db : name === 'user' ? user : null); } };
})();
