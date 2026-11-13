'use strict';
/*
 * Mesa Viva - servidor
 * Sem dependências: só usa módulos que já vêm no Node (http, fs, crypto).
 * Guarda as salas na memória, grava um backup em arquivo e avisa todos os
 * navegadores conectados (via Server-Sent Events) assim que algo muda.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Os arquivos do site podem estar na pasta "public" ou soltos ao lado do server.js.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;

const MAX_BODY = 200 * 1024;
const MAX_DOC = 64 * 1024;
const MAX_ROOMS = 500;
const MAX_CHARS = 120;
const MAX_PLAYERS = 40;
const ROOM_TTL_MS = 30 * 24 * 3600 * 1000;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const CODE = /^[A-Z]{4}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ---------- armazenamento ---------- */
const store = new Map(); // caminho -> { d: dados, t: ultima atividade }

function loadDb() {
  try {
    const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j)) if (parse(k) && v && v.d) store.set(k, v);
    console.log('Banco carregado:', store.size, 'documentos');
  } catch (e) { /* primeira execução */ }
}
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('Falha ao gravar backup:', e.message); }
  }, 1000);
}
function purgeOld() {
  const limit = Date.now() - ROOM_TTL_MS;
  for (const [k, v] of store) {
    const p = parse(k);
    if (p && p.kind === 'room' && v.t < limit) removeRoom(p.code);
  }
}

/* ---------- caminhos ---------- */
function parse(p) {
  if (typeof p !== 'string' || p.length > 400) return null;
  const s = p.split('/');
  if (!s.every((x) => SEG.test(x)) || s[0] !== 'rooms') return null;
  if (s.length === 1) return { kind: 'rooms' };
  if (!CODE.test(s[1])) return null;
  if (s.length === 2) return { kind: 'room', code: s[1] };
  if (s[2] !== 'chars' && s[2] !== 'players') return null;
  if (s.length === 3) return { kind: 'col', code: s[1], sub: s[2] };
  if (s.length === 4) return { kind: 'item', code: s[1], sub: s[2], id: s[3] };
  return null;
}
function children(prefix, filters) {
  const depth = prefix.split('/').length + 1;
  const docs = [];
  for (const [k, v] of store) {
    if (!k.startsWith(prefix + '/') || k.split('/').length !== depth) continue;
    if (filters && !filters.every((f) => f[1] === '==' && v.d[f[0]] === f[2])) continue;
    docs.push({ id: k.split('/').pop(), data: v.d });
  }
  docs.sort((a, b) => (a.id < b.id ? -1 : 1));
  return docs;
}
const roomOf = (code) => { const e = store.get('rooms/' + code); return e ? e.d : null; };

/* ---------- validação dos dados ---------- */
function clean(v, depth) {
  if (depth > 8) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 4000;
  if (Array.isArray(v)) return v.length <= 200 && v.every((x) => clean(x, depth + 1));
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length <= 100 && keys.every((k) => !FORBIDDEN_KEYS.has(k) && k.length <= 200 && clean(v[k], depth + 1));
  }
  return false;
}
function merge(a, b) {
  const o = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) o[k] = merge(o[k], v);
    else o[k] = v;
  }
  return o;
}

/* ---------- regras: quem pode o quê ---------- */
function canRead(pp, filters, pid) {
  if (pp.kind === 'rooms') return filters.length === 1 && filters[0][0] === 'hostId' && filters[0][1] === '==' && filters[0][2] === pid;
  return true;
}
// devolve null se pode, ou o código do erro
function checkWrite(op, pp, data, pid) {
  const bad = 'invalid_argument';
  if (pp.kind === 'room') {
    const room = roomOf(pp.code);
    if (op === 'set') {
      if (room || !data || data.hostId !== pid) return bad;
      let n = 0; for (const k of store.keys()) if (k.split('/').length === 2) n++;
      return n >= MAX_ROOMS ? 'quota_exceeded' : null;
    }
    if (op === 'delete') return !room || room.hostId === pid ? null : bad;
    return bad;
  }
  if (pp.kind !== 'item') return bad;
  const room = roomOf(pp.code);
  if (!room) return bad;
  const isHost = room.hostId === pid;
  const key = 'rooms/' + pp.code + '/' + pp.sub + '/' + pp.id;
  const cur = store.get(key) && store.get(key).d;
  if (op === 'update' && !cur) return bad;
  const count = () => children('rooms/' + pp.code + '/' + pp.sub).length;
  if (pp.sub === 'players') {
    if (!isHost && pp.id !== pid) return bad;
    if (!cur && count() >= MAX_PLAYERS) return 'quota_exceeded';
    return null;
  }
  // fichas
  if (isHost) return !cur && op !== 'delete' && count() >= MAX_CHARS ? 'quota_exceeded' : null;
  if (op !== 'update') return bad;
  const keys = Object.keys(data || {});
  if (!keys.length || !keys.every((k) => k === 'ownerId' || k === 'bars')) return bad;
  if ('ownerId' in data) {
    const n = data.ownerId;
    if (n === pid) { if (cur.ownerId && cur.ownerId !== pid) return bad; }
    else if (n === '') { if (cur.ownerId !== pid) return bad; }
    else return bad;
  }
  if ('bars' in data) {
    if (cur.ownerId !== pid || !data.bars || typeof data.bars !== 'object') return bad;
    for (const [bid, patch] of Object.entries(data.bars)) {
      const b = cur.bars && cur.bars[bid];
      if (!b || !patch || typeof patch !== 'object') return bad;
      const pk = Object.keys(patch);
      if (pk.length !== 1 || pk[0] !== 'cur') return bad;
      if (!Number.isInteger(patch.cur) || patch.cur < 0 || patch.cur > Math.max(b.max || 0, b.cur || 0)) return bad;
    }
  }
  return null;
}

function removeRoom(code) {
  const prefix = 'rooms/' + code;
  for (const k of [...store.keys()]) if (k === prefix || k.startsWith(prefix + '/')) store.delete(k);
}
function applyWrite(op, p, pp, data) {
  const now = Date.now();
  if (pp.kind === 'room' && op === 'delete') removeRoom(pp.code);
  else if (op === 'set') store.set(p, { d: data, t: now });
  else if (op === 'update') store.set(p, { d: merge(store.get(p).d, data), t: now });
  else if (op === 'delete') store.delete(p);
  const room = store.get('rooms/' + pp.code);
  if (room) room.t = now;
  persist();
}

/* ---------- assinaturas ao vivo (SSE) ---------- */
const clients = new Map(); // sid -> { res, subs: Map(subId -> {path, pp, filters, last}), seen, hb }

function snapshotOf(sub) {
  if (sub.pp.kind === 'room' || sub.pp.kind === 'item') {
    const e = store.get(sub.path);
    return { exists: !!e, data: e ? e.d : null };
  }
  return { docs: children(sub.path, sub.filters) };
}
function push(c, subId, sub, force) {
  const snap = snapshotOf(sub);
  const json = JSON.stringify(snap);
  if (!force && json === sub.last) return;
  sub.last = json;
  if (c.res) c.res.write('event: snap\ndata: ' + JSON.stringify({ subId, snap }) + '\n\n');
}
function notify(code) {
  for (const c of clients.values()) {
    for (const [subId, sub] of c.subs) {
      if (sub.pp.kind === 'rooms' || sub.pp.code === code) push(c, subId, sub, false);
    }
  }
}
function clientFor(sid) {
  let c = clients.get(sid);
  if (!c) { c = { res: null, subs: new Map(), seen: Date.now(), hb: null }; clients.set(sid, c); }
  return c;
}
setInterval(() => {
  const limit = Date.now() - 120000;
  for (const [sid, c] of clients) if (!c.res && c.seen < limit) clients.delete(sid);
}, 30000).unref();

/* ---------- identidade e limite de uso ---------- */
const pidOf = (secret) => 'u_' + crypto.createHash('sha256').update(secret).digest('hex').slice(0, 22);
const buckets = new Map();
function limited(pid) {
  const now = Date.now();
  let b = buckets.get(pid);
  if (!b || b.reset < now) { b = { n: 0, reset: now + 10000 }; buckets.set(pid, b); }
  return ++b.n > 150;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();
const leases = new Map();

/* ---------- http ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
const fail = (res, code, status) => send(res, status || 400, { code });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (ch) => { size += ch.length; if (size > MAX_BODY) { reject(new Error('big')); req.destroy(); } else parts.push(ch); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const filtersOk = (f) => Array.isArray(f) && f.length <= 3 && f.every((x) => Array.isArray(x) && x.length === 3 && typeof x[0] === 'string' && x[1] === '==' && typeof x[2] === 'string');

async function handleApi(req, res, url) {
  if (url.pathname === '/api/events' && req.method === 'GET') {
    const sid = url.searchParams.get('sid') || '';
    if (!/^[a-z0-9]{8,64}$/.test(sid)) return fail(res, 'invalid_argument');
    const c = clientFor(sid);
    if (c.res) { try { c.res.end(); } catch (e) { /* já fechada */ } }
    c.res = res; c.seen = Date.now();
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    for (const [subId, sub] of c.subs) push(c, subId, sub, true);
    clearInterval(c.hb);
    c.hb = setInterval(() => { if (c.res) c.res.write('event: ping\ndata: 1\n\n'); }, 15000);
    req.on('close', () => { if (c.res === res) { c.res = null; clearInterval(c.hb); c.seen = Date.now(); } });
    return;
  }
  if (req.method !== 'POST') return fail(res, 'invalid_argument', 405);
  const secret = String(req.headers['x-secret'] || '');
  if (secret.length < 16 || secret.length > 128) return fail(res, 'invalid_argument');
  const pid = pidOf(secret);
  if (limited(pid)) return fail(res, 'resource_exhausted', 429);
  let b;
  try { b = await readBody(req); } catch (e) { return fail(res, 'invalid_argument'); }
  if (!b || typeof b !== 'object') return fail(res, 'invalid_argument');

  if (url.pathname === '/api/whoami') return send(res, 200, { id: pid });
  if (url.pathname === '/api/ping') return send(res, 200, { ok: true });

  if (url.pathname === '/api/sub') {
    const pp = parse(b.path); const filters = b.filters || [];
    if (!pp || (pp.kind !== 'room' && pp.kind !== 'rooms' && pp.kind !== 'col' && pp.kind !== 'item') || !filtersOk(filters)) return fail(res, 'invalid_argument');
    if (!/^[A-Za-z0-9]{1,32}$/.test(String(b.sid)) || !/^[0-9]{1,9}$/.test(String(b.subId))) return fail(res, 'invalid_argument');
    if (!canRead(pp, filters, pid)) return fail(res, 'invalid_argument');
    const c = clientFor(String(b.sid));
    if (c.subs.size >= 64) return fail(res, 'resource_exhausted', 429);
    const sub = { path: b.path, pp, filters, last: '' };
    c.subs.set(String(b.subId), sub);
    const snap = snapshotOf(sub); sub.last = JSON.stringify(snap);
    return send(res, 200, { snap });
  }
  if (url.pathname === '/api/unsub') {
    const c = clients.get(String(b.sid));
    if (c) c.subs.delete(String(b.subId));
    return send(res, 200, { ok: true });
  }
  if (url.pathname !== '/api/op') return fail(res, 'invalid_argument', 404);

  const pp = parse(b.path);
  if (!pp) return fail(res, 'invalid_argument');
  const op = b.op;
  if (op === 'get') {
    if (pp.kind !== 'room' && pp.kind !== 'item') return fail(res, 'invalid_argument');
    const e = store.get(b.path);
    return send(res, 200, { exists: !!e, data: e ? e.d : null });
  }
  if (op === 'query') {
    const filters = b.filters || [];
    if (!(pp.kind === 'rooms' || pp.kind === 'col') || !filtersOk(filters) || !canRead(pp, filters, pid)) return fail(res, 'invalid_argument');
    return send(res, 200, { docs: children(b.path, filters) });
  }
  if (op === 'acquire') {
    if (pp.kind !== 'item') return fail(res, 'invalid_argument');
    const now = Date.now(); const l = leases.get(b.path);
    const ttl = Math.min(Math.max(Number(b.ttlMs) || 30000, 1000), 600000);
    if (!l || l.exp < now || l.holder === pid) { leases.set(b.path, { holder: pid, exp: now + ttl }); return send(res, 200, { acquired: true }); }
    return send(res, 200, { acquired: false });
  }
  if (op === 'set' || op === 'update' || op === 'delete') {
    if (pp.kind !== 'room' && pp.kind !== 'item') return fail(res, 'invalid_argument');
    let data = b.data;
    if (op !== 'delete') {
      if (!data || typeof data !== 'object' || Array.isArray(data) || !clean(data, 0) || JSON.stringify(data).length > MAX_DOC) return fail(res, 'invalid_argument');
    }
    const err = checkWrite(op, pp, data, pid);
    if (err) return fail(res, err);
    if (op === 'set' && pp.kind === 'room') data = { code: pp.code, hostId: pid, createdAt: Number(data.createdAt) || Date.now() };
    applyWrite(op, b.path, pp, data);
    notify(pp.code);
    return send(res, 200, { ok: true });
  }
  return fail(res, 'invalid_argument');
}

/* ---------- arquivos do site ---------- */
const FILES = {};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
for (const f of ['index.html', 'shim.js', 'favicon.svg']) FILES['/' + f] = { buf: fs.readFileSync(path.join(PUBLIC_DIR, f)), type: TYPES[path.extname(f)] || 'application/octet-stream' };
if (!FILES['/index.html'].buf.length) throw new Error('index.html vazio');
FILES['/'] = FILES['/index.html'];
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => { console.error(e); if (!res.headersSent) fail(res, 'unavailable', 500); });
    return;
  }
  const f = FILES[url.pathname];
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
  res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
  res.end(req.method === 'HEAD' ? undefined : f.buf);
});
server.requestTimeout = 0; // conexões SSE ficam abertas

loadDb(); purgeOld();
setInterval(purgeOld, 6 * 3600 * 1000).unref();
process.on('uncaughtException', (e) => console.error('Erro:', e));
server.listen(PORT, '0.0.0.0', () => console.log('Mesa Viva rodando na porta ' + PORT));
