'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../lib/domain');

test('contribuições: normaliza, limita detalhes e exige texto em "Outro"', () => {
  const [c] = d.normalizeContributions([{ category: ' Carne bovina ', details: { corte: ' Picanha ', vazio: ' ' }, note: ' ok ' }]);
  assert.equal(c.category, 'Carne bovina');
  assert.deepEqual(c.details, { corte: 'Picanha' });
  assert.equal(c.note, 'ok');
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.throws(() => d.normalizeContributions([{ category: 'outro' }]), /Outro/);
  assert.throws(() => d.normalizeContributions([{ category: '' }]), /categoria/);
  assert.throws(() => d.normalizeContributions([{ category: 'x', details: { 'a.b': '1' } }]), /Detalhe/);
  assert.throws(() => d.normalizeContributions(Array(31).fill({ category: 'x' })), /até 30/);
  assert.deepEqual(d.normalizeContributions(null), []);
  // Mantém o id enviado pelo app para que editar não duplique o item.
  assert.equal(d.normalizeContributions([{ id: 'abcdef12-3456', category: 'Gelo' }])[0].id, 'abcdef12-3456');
});

test('divisão: soma fecha no centavo e gera o mínimo de transferências', () => {
  const r = d.settle([{ uid: 'a', amountCents: 100 }], ['a', 'b', 'c']);
  assert.equal(r.totalCents, 100);
  assert.equal(r.balances.reduce((s, b) => s + b.netCents, 0), 0);
  assert.deepEqual(r.transfers.map((t) => [t.fromUid, t.toUid]).sort(), [['b', 'a'], ['c', 'a']]);
  assert.equal(r.transfers.reduce((s, t) => s + t.amountCents, 0), 66);

  const even = d.settle([{ uid: 'a', amountCents: 300 }, { uid: 'b', amountCents: 300 }], ['a', 'b']);
  assert.deepEqual(even.transfers, []);

  const empty = d.settle([], ['a', 'b']);
  assert.equal(empty.totalCents, 0);
  assert.deepEqual(empty.transfers, []);
});

test('papéis: organizador e confirmados são membros; convidados só leem', () => {
  const e = { organizerUid: 'o', participants: [{ uid: 'c', status: 'confirmed' }, { uid: 'i', status: 'invited' }, { uid: 'x', status: 'declined' }] };
  assert.deepEqual(d.memberUids(e).sort(), ['c', 'o']);
  assert.equal(d.isActiveMember(e, 'i'), false);
  assert.equal(d.canRead(e, 'i'), true);
  assert.equal(d.canRead(e, 'z'), false);
  assert.equal(d.canRead(e, 'z', true), true);
  assert.equal(d.canEdit(e, 'c'), false);
  assert.equal(d.canEdit(e, 'o'), true);
  assert.equal(d.canEdit(e, 'c', true), true);
  assert.equal(d.isOrganizer({ organizerUid: null }, null), false);
});

test('valor das despesas e chave Pix são validados', () => {
  assert.equal(d.parseAmountCents(1999), 1999);
  for (const bad of [0, -1, 1.5, '10,00', 10_000_001]) assert.throws(() => d.parseAmountCents(bad));
  assert.equal(d.validPixKey(''), null);
  assert.equal(d.validPixKey(' a@b.com '), 'a@b.com');
  assert.throws(() => d.validPixKey('x'.repeat(78)));
});
