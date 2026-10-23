'use strict';
// Sobe a API v2 contra um MongoDB real em memória e um Firebase falso, sem rede.
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const defineModels = require('../lib/models');
const createApp = require('../lib/app');

function fakeDatabase() {
  const root = {};
  const parts = (path) => path.split('/').filter(Boolean);
  const read = (path) => parts(path).reduce((node, key) => (node == null ? undefined : node[key]), root);
  const write = (path, value) => {
    const keys = parts(path);
    let node = root;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = JSON.parse(JSON.stringify(value));
  };
  let pushId = 0;
  const ref = (path) => ({
    async set(value) { write(path, value); },
    async remove() { write(path, null); },
    async push(value) { const key = `m${String(++pushId).padStart(6, '0')}`; write(`${path}/${key}`, value); return ref(`${path}/${key}`); },
    async get() { return { val: () => read(path) ?? null }; },
    async once() { return { val: () => read(path) ?? null }; },
    on() {}, off() {},
    async transaction(update) {
      const next = update(read(path) ?? null);
      if (next === undefined) return { committed: false, snapshot: { val: () => read(path) ?? null } };
      write(path, next);
      return { committed: true, snapshot: { val: () => read(path) ?? null } };
    },
  });
  return { ref, read };
}

async function startTestApp(env = {}) {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const connection = await mongoose.createConnection(replSet.getUri('churrasco_test')).asPromise();
  const models = defineModels(connection);
  await Promise.all(Object.values(models).map((m) => m.init()));

  const identities = new Map();
  const sent = [];
  const database = fakeDatabase();
  const admin = {
    auth: () => ({
      verifyIdToken: async (token) => { if (!identities.has(token)) throw new Error('bad token'); return { uid: token }; },
      getUser: async (uid) => { const i = identities.get(uid); if (!i) throw new Error('no user'); return { uid, ...i }; },
    }),
    database: () => ({ ref: database.ref }),
    messaging: () => ({ send: async (message) => { sent.push(message); return 'ok'; } }),
  };
  // `connection` tem a mesma API de `mongoose` usada pela app (isValidObjectId, readyState, startSession).
  const mongooseLike = Object.assign(Object.create(connection), {
    isValidObjectId: mongoose.isValidObjectId,
    connection,
    Schema: mongoose.Schema,
    model: (...args) => connection.model(...args),
    models: connection.models,
    startSession: (...args) => connection.startSession(...args),
  });
  const app = createApp({ mongoose: mongooseLike, models, admin, env: { MIN_APP_VERSION: '21', ...env }, firebaseEnabled: true, localTest: false, publicBaseUrl: 'https://churrasco.test' });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { as, body, version = 21, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(version != null ? { 'X-App-Version': String(version) } : {}),
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* HTML */ }
    return { status: res.status, body: json, text };
  }

  /** Cria identidade Firebase (e-mail confirmado) e perfil no Churrasco. */
  async function user(uid, displayName = uid, { email = `${uid}@teste.local`, verified = true, register = true } = {}) {
    identities.set(uid, { email, emailVerified: verified });
    if (register) {
      const r = await request('POST', '/users/register', { as: uid, body: { displayName } });
      if (r.status !== 201) throw new Error(`register ${uid}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return uid;
  }

  async function befriend(a, b) {
    const other = identities.get(b).email;
    await request('POST', '/friends', { as: a, body: { email: other } });
    await request('POST', '/friends', { as: b, body: { email: identities.get(a).email } });
  }

  async function stop() {
    await new Promise((r) => server.close(r));
    await connection.close();
    await replSet.stop();
  }

  return { request, user, befriend, models, database, sent, identities, stop };
}

/** dd/MM/aaaa e HH:mm em São Paulo para daqui a `minutes` minutos. */
function spDateTime(minutes) {
  const sp = new Date(Date.now() + minutes * 60_000 - 3 * 3_600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    churrascoDate: `${pad(sp.getUTCDate())}/${pad(sp.getUTCMonth() + 1)}/${sp.getUTCFullYear()}`,
    hora: `${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}`,
  };
}

module.exports = { startTestApp, spDateTime };
