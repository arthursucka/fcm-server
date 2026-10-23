'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, spDateTime } = require('./helpers');

let t;
before(async () => {
  t = await startTestApp({
    CHURRASCO_LEGACY_ONBOARDING_ENABLED: '1',
    CHURRASCO_LEGACY_MIGRATION_WINDOW: '1',
    CHURRASCO_MIGRATION_REVIEWER_UID: 'revisor',
  });
}, { timeout: 120_000 });
after(async () => { await t?.stop(); });

test('aprovar conta antiga liga os eventos v2 ao UID e libera o chat', async () => {
  await t.models.User.create({ username: 'Tio Zé', displayName: 'Tio Zé' });
  await t.user('revisor', 'Revisor');
  await t.user('amigo', 'Amigo');
  // Eventos migrados guardam o nome antigo até o vínculo.
  const organized = await t.models.Churrasco.create({ ...spDateTime(600), local: 'Casa', organizerLegacyUsername: 'Tio Zé', participants: [{ uid: 'amigo', status: 'confirmed' }], contributions: [{ id: 'c-legacy-0001', legacyUsername: 'Tio Zé', category: 'Carvão' }] });
  const guest = await t.models.Churrasco.create({ ...spDateTime(600), local: 'Sítio', organizerUid: 'amigo', participants: [{ legacyUsername: 'Tio Zé', status: 'confirmed' }] });

  await t.user('ze', 'Zé', { register: false });
  const requested = await t.request('POST', '/legacy-link/request', { as: 'ze', body: { username: 'Tio Zé' } });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  const review = (await t.request('GET', '/legacy-link/review', { as: 'revisor' })).body.payload;
  assert.equal(review.length, 1);
  const approved = await t.request('POST', `/legacy-link/${review[0].id}/approve`, {
    as: 'revisor', body: { confirmedOwner: true, evidenceReference: 'Conferido pessoalmente', expectedUsername: 'Tio Zé', expectedEmail: 'ze@teste.local' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const a = await t.models.Churrasco.findById(organized._id).lean();
  assert.equal(a.organizerUid, 'ze');
  assert.equal(a.organizerLegacyUsername, null);
  assert.equal(a.contributions[0].uid, 'ze');
  const b = await t.models.Churrasco.findById(guest._id).lean();
  assert.equal(b.participants[0].uid, 'ze');
  assert.equal(t.database.read(`eventAccess/${organized._id}/ze`), true);
  assert.equal(t.database.read(`eventAccess/${guest._id}/ze`), true);

  const login = await t.request('POST', '/users/login', { as: 'ze', body: {} });
  assert.equal(login.status, 200);
  assert.equal(login.body.payload.displayName, 'Tio Zé');
});
