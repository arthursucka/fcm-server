'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convertEvent } = require('../scripts/migrate-v2');

const uids = new Map([['Arthur', 'uid-arthur'], ['Cassi', 'uid-cassi']]);

test('migração v1 → v2 preserva papéis, itens e quem ainda não vinculou', () => {
  const v1 = {
    createdBy: 'Arthur', invitedUsers: ['Cassi', 'Gabriel', 'Lia'],
    guestsConfirmed: [{ name: 'Cassi', items: ['Gelo'] }, { name: 'Gabriel', items: ['Carvão'] }],
    guestsDeclined: ['Lia'], fornecidos: ['Sal', 'Gelo', 'Carvão'], organizerItems: ['Sal'],
  };
  const v2 = convertEvent(v1, uids);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.organizerUid, 'uid-arthur');
  assert.deepEqual(v2.participants, [
    { uid: 'uid-cassi', legacyUsername: null, status: 'confirmed' },
    { uid: null, legacyUsername: 'Gabriel', status: 'confirmed' },
    { uid: null, legacyUsername: 'Lia', status: 'declined' },
  ]);
  assert.deepEqual(v2.contributions.map((c) => [c.uid || c.legacyUsername, c.category]), [
    ['uid-arthur', 'Sal'], ['uid-cassi', 'Gelo'], ['Gabriel', 'Carvão'],
  ]);
});

test('evento antigo sem organizerItems: o que não é de convidado fica com o organizador', () => {
  const v2 = convertEvent({ createdBy: 'Arthur', invitedUsers: ['Cassi'], guestsConfirmed: [{ name: 'Cassi', items: ['Gelo'] }], fornecidos: ['Gelo', 'Pão'] }, uids);
  assert.deepEqual(v2.contributions.map((c) => [c.uid, c.category]), [['uid-arthur', 'Pão'], ['uid-cassi', 'Gelo']]);
});

test('organizador sem UID fica como nome antigo, e o organizador não vira participante', () => {
  const v2 = convertEvent({ createdBy: 'Vovô', invitedUsers: ['Vovô', 'Arthur'], guestsConfirmed: [], guestsDeclined: [] }, uids);
  assert.equal(v2.organizerUid, null);
  assert.equal(v2.organizerLegacyUsername, 'Vovô');
  assert.deepEqual(v2.participants, [{ uid: 'uid-arthur', legacyUsername: null, status: 'invited' }]);
});
