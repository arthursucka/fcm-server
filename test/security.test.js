const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture({ firebaseAvailable = true, failRevoke = false } = {}) {
  const routes = [], writes = [], tokenChecks = [];
  const profiles = [
    { username: 'owner', displayName: 'Owner', firebaseUid: 'uid-owner', fcmTokens: ['device-owner'] },
    { username: 'guest', displayName: 'Guest', firebaseUid: 'uid-guest', fcmTokens: [] },
    { username: 'outsider', displayName: 'Outsider', firebaseUid: 'uid-outsider', fcmTokens: [] },
    { username: 'legacy', displayName: 'Legacy', fcmTokens: [] },
  ];
  let event = { _id: '507f1f77bcf86cd799439011', createdBy: 'owner', invitedUsers: ['guest'], guestsConfirmed: [], guestsDeclined: [], fornecidos: [], organizerItems: [], __v: 0, churrascoDate: '20/12/2026', hora: '12:00', local: 'Fixture' };
  event.save = async () => {}; event.lean = async () => event;
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => matches(row, q));
    let field = key === 'guestsConfirmed.name' ? (row.guestsConfirmed || []).map(g => g.name) : row[key];
    if (value && typeof value === 'object' && '$ne' in value) return field !== value.$ne;
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(field);
    return Array.isArray(field) ? field.includes(value) : field === value;
  });
  const query = rows => ({ select() { return this; }, sort() { return this; }, lean: async () => rows });
  const User = {
    init: async () => {},
    findOne: async q => profiles.find(p => matches(p, q)),
    find: (q = {}) => query(profiles.filter(p => matches(p, q))),
    create: async row => { const p = { ...row, fcmTokens: [] }; profiles.push(p); return p; },
    updateMany: async (q, update) => profiles.filter(p => matches(p, q)).forEach(p => { p.fcmTokens = p.fcmTokens.filter(t => t !== update.$pull.fcmTokens); }),
    updateOne: async (q, update) => {
      const p = profiles.find(p => matches(p, q));
      if (update.$pull) p.fcmTokens = p.fcmTokens.filter(t => t !== update.$pull.fcmTokens);
      if (update.$addToSet && !p.fcmTokens.includes(update.$addToSet.fcmTokens)) p.fcmTokens.push(update.$addToSet.fcmTokens);
    },
  };
  const Churrasco = {
    findById: () => event,
    findOneAndUpdate: async (filter,update) => {
      if(!event||!Object.entries(filter).every(([k,v])=>v && typeof v==='object' && '$exists' in v ? (event[k]!==undefined)===v.$exists : JSON.stringify(event[k])===JSON.stringify(v)))return null;
      Object.assign(event,update.$set);event.__v=(event.__v||0)+update.$inc.__v;return event;
    },
    find: (q = {}) => query(event && matches(event, q) ? [event] : []),
    findByIdAndDelete: async () => { event = null; },
    create: async row => { event = { ...event, ...row }; return event; },
  };
  const app = { listen: () => {} };
  for (const method of ['use', 'get', 'post', 'delete']) app[method] = (route, ...handlers) => routes.push({ method, route, handlers });
  const express = () => app; express.json = () => () => {};
  const mongoose = { Schema: function () {}, model: name => name === 'User' ? User : name === 'LegacyLinkRequest' ? {init:async()=>{},findOne:async()=>null} : Churrasco, connect: async () => {}, connection: { readyState: 1 }, isValidObjectId: id => /^[a-f0-9]{24}$/.test(id) };
  const admin = {
    credential: { cert: () => ({}) }, initializeApp: () => {},
    auth: () => ({ getUser:async uid=>({uid,email:'fixture@example.test',emailVerified:true,disabled:false}),verifyIdToken: async (token, revoked) => {
      tokenChecks.push({ token, revoked });
      if (!token.startsWith('valid:')) throw Error('Invalid fixture token');
      return { uid: token.slice(6) };
    } }),
    database: () => ({ ref: key => ({
      set: async value => writes.push({ op: 'set', key, value }),
      remove: async () => { if (failRevoke) throw Error('Fixture outage'); writes.push({ op: 'remove', key }); },
      push: async value => writes.push({ op: 'push', key, value }),
    }) }),
    messaging: () => ({ send: async () => {} }),
  };
  const sandbox = vm.createContext({
    require: name => {
      if (name === 'dotenv') return { config: () => {} };
      if (name === 'express') return express;
      if (name === 'mongoose') return mongoose;
      if (name === 'cors') return () => () => {};
      if (name === './firebase-services') return admin;
      if (name === './item-reservations') return require('../item-reservations');
      if (name === './legacy-onboarding') return require('../legacy-onboarding');
      if (name === 'fs') return { existsSync: () => false, readFileSync: () => { throw Error('Credentials forbidden'); } };
      throw Error('Unexpected require: ' + name);
    },
    process: { env: { MONGO_URI: 'mongodb://fixture.invalid/test', ...(firebaseAvailable ? { SERVICE_ACCOUNT_KEY: '{}' } : {}) }, exit: () => { throw Error('Unexpected exit'); } },
    Buffer, console: { log: () => {}, error: () => {}, warn: () => {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), sandbox);
  async function request(method, route, { uid = 'uid-owner', authorization, body = {}, params = {}, headers = {} } = {}) {
    const req = { body, params: { id: '507f1f77bcf86cd799439011', ...params }, query: {}, header: key => key === 'Authorization' ? (authorization === undefined ? `Bearer valid:${uid}` : authorization) : headers[key] };
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
    const selected = routes.find(r => r.method === method && r.route === route);
    assert(selected, route);
    const prefix = route.startsWith('/churrascos') ? routes.find(r => r.method === 'use' && r.route === '/churrascos').handlers : [];
    for (const handler of [...prefix, ...selected.handlers]) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next) break;
    }
    return res;
  }
  return { request, profiles, writes, tokenChecks, get event() { return event; } };
}

test('legacy X-User does not authenticate; invalid tokens are rejected', async () => {
  const f = fixture();
  assert.equal((await f.request('get', '/churrascos', { authorization: '', headers: { 'X-User': 'owner' } })).statusCode, 401);
  assert.equal((await f.request('get', '/churrascos', { authorization: 'Bearer forged' })).statusCode, 401);
});
test('unavailable verifier fails closed', async () => {
  const f = fixture({ firebaseAvailable: false });
  assert.equal((await f.request('get', '/churrascos')).statusCode, 503);
});
test('verified UID determines profile; body and X-User cannot impersonate owner', async () => {
  const f = fixture();
  assert.equal((await f.request('delete', '/churrascos/:id', { uid: 'uid-outsider', headers: { 'X-User': 'owner' } })).statusCode, 403);
  assert(f.event);
  assert(f.tokenChecks.every(c => c.revoked === true));
});
test('unknown UID cannot use a legacy name to log in or register', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/users/login', { uid: 'new-uid', body: { username: 'legacy' } })).statusCode, 403);
  assert.equal((await f.request('post', '/users/register', { uid: 'new-uid', body: { username: 'legacy', displayName: 'Legacy' } })).statusCode, 409);
  assert.equal(f.profiles.find(p => p.username === 'legacy').firebaseUid, undefined);
});
test('registration binds a new name to verified UID and is idempotent for that UID', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/users/register', { uid: 'new-uid', body: { username: 'new', displayName: 'New' } })).statusCode, 201);
  const repeated = await f.request('post', '/users/register', { uid: 'new-uid', body: { username: 'owner', displayName: 'Owner' } });
  assert.equal(repeated.body.payload.username, 'new');
});
test('private list/detail deny outsider and allow invited user', async () => {
  const f = fixture();
  assert.equal((await f.request('get', '/churrascos', { uid: 'uid-outsider' })).body.churrascos.length, 0);
  assert.equal((await f.request('get', '/churrascos/:id', { uid: 'uid-outsider' })).statusCode, 403);
  assert.equal((await f.request('get', '/churrascos/:id', { uid: 'uid-guest' })).statusCode, 200);
  assert(!f.writes.some(w => w.key.endsWith('uid-guest') && w.value === true));
});
test('responses cannot designate another person or join an uninvited event', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/churrascos/:id/confirm-presenca', { uid: 'uid-guest', body: { name: 'owner', selectedItems: [] } })).statusCode, 403);
  assert.equal((await f.request('post', '/churrascos/:id/decline-presenca', { uid: 'uid-guest', body: { name: 'owner' } })).statusCode, 403);
  assert.equal((await f.request('post', '/churrascos/:id/confirm-presenca', { uid: 'uid-outsider', body: { name: 'outsider', selectedItems: [] } })).statusCode, 403);
});
test('confirmation grants access by UID; decline revokes before removing membership', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/churrascos/:id/confirm-presenca', { uid: 'uid-guest', body: { name: 'guest', selectedItems: [] } })).statusCode, 200);
  assert(f.writes.some(w => w.key === `eventAccess/${f.event._id}/uid-guest` && w.value === true));
  assert.equal((await f.request('post', '/churrascos/:id/decline-presenca', { uid: 'uid-guest', body: { name: 'guest' } })).statusCode, 200);
  assert(f.writes.some(w => w.op === 'remove' && w.key.endsWith('/uid-guest')));
  assert.equal(f.event.guestsConfirmed.length, 0);
});
test('revocation failure does not report a successful decline', async () => {
  const f = fixture({ failRevoke: true }); f.event.guestsConfirmed = [{ name: 'guest', items: [] }];
  assert.equal((await f.request('post', '/churrascos/:id/decline-presenca', { uid: 'uid-guest', body: { name: 'guest' } })).statusCode, 500);
  assert.equal(f.event.guestsConfirmed.length, 1);
});
test('cancel removes Firebase access/data and Mongo event; outsider cannot cancel', async () => {
  const f = fixture();
  assert.equal((await f.request('delete', '/churrascos/:id')).statusCode, 200);
  assert.equal(f.event, null);
  assert(f.writes.some(w => w.key.startsWith('eventAccess/') && w.op === 'remove'));
  assert(f.writes.some(w => w.key.startsWith('churrascos/') && w.op === 'remove'));
});
test('login uses verified profile and moves notification token; logout detaches it', async () => {
  const f = fixture();
  const res = await f.request('post', '/users/login', { uid: 'uid-guest', body: { username: 'owner', fcmToken: 'device-owner' } });
  assert.equal(res.body.payload.username, 'guest');
  assert.deepEqual(f.profiles.find(p => p.username === 'owner').fcmTokens, []);
  assert.deepEqual(f.profiles.find(p => p.username === 'guest').fcmTokens, ['device-owner']);
  await f.request('post', '/users/logout', { uid: 'uid-guest', body: { fcmToken: 'device-owner' } });
  assert.deepEqual(f.profiles.find(p => p.username === 'guest').fcmTokens, []);
});
test('login works without FCM and message length is enforced in Admin write path', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/users/login', { body: {} })).statusCode, 200);
  assert.equal((await f.request('post', '/churrascos/:id/messages', { body: { text: 'a'.repeat(501) } })).statusCode, 400);
  assert.equal(f.writes.length, 0);
});

test('reading event details never restores revoked Firebase access', async () => {
  const f = fixture();
  f.event.guestsConfirmed = [{ name: 'guest', items: [] }];
  assert.equal((await f.request('get', '/churrascos/:id', { uid: 'uid-guest' })).statusCode, 200);
  assert.equal(f.writes.length, 0);
});

test('creation records the verified owner and grants only their UID', async () => {
  const f = fixture();
  const response = await f.request('post', '/churrascos', {
    body: { churrascoDate: '20/12/2026', hora: '12:00', local: 'Fixture', fornecidos: [], invitedUsers: ['guest'], createdBy: 'outsider' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(f.event.createdBy, 'owner');
  assert(f.writes.some(w => w.key === `eventAccess/${f.event._id}/uid-owner` && w.value === true));
  assert(!f.writes.some(w => w.key.endsWith('/uid-guest')));
});

test('messages require confirmed membership and derive sender from authentication', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/churrascos/:id/messages', { uid: 'uid-guest', body: { text: 'Hello' } })).statusCode, 403);
  f.event.guestsConfirmed = [{ name: 'guest', items: [] }];
  const response = await f.request('post', '/churrascos/:id/messages', { uid: 'uid-guest', body: { text: 'Hello', sender: 'owner' } });
  assert.equal(response.statusCode, 200);
  assert.equal(f.writes.find(w => w.op === 'push').value.sender, 'guest');
});
