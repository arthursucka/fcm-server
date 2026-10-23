'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, spDateTime } = require('./helpers');

let t;
before(async () => { t = await startTestApp({ CHURRASCO_ADMIN_UIDS: 'admin', CHURRASCO_MIGRATION_REVIEWER_UID: 'admin' }); }, { timeout: 120_000 });
after(async () => { await t?.stop(); });

async function newEvent(owner, extra = {}) {
  const r = await t.request('POST', '/churrascos', { as: owner, body: { ...spDateTime(60 * 24), local: 'Casa', address: 'Rua A, 1', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
const get = async (id, as) => (await t.request('GET', `/churrascos/${id}`, { as })).body.churrasco;

test('versão antiga do app recebe 426 com instrução para atualizar', async () => {
  const noHeader = await t.request('GET', '/churrascos', { version: null });
  assert.equal(noHeader.status, 426);
  assert.match(noHeader.body.message, /Atualize o app/);
  assert.equal((await t.request('GET', '/churrascos', { version: 20 })).status, 426);
  assert.equal((await t.request('GET', '/health', { version: null })).status, 200);
});

test('cadastro exige e-mail confirmado e usa o UID como chave', async () => {
  await t.user('naoconfirmado', 'X', { verified: false, register: false });
  const r = await t.request('POST', '/users/register', { as: 'naoconfirmado', body: { displayName: 'X' } });
  assert.equal(r.status, 403);
  await t.user('ana', 'Ana');
  const login = await t.request('POST', '/users/login', { as: 'ana', body: { fcmToken: 'tok-ana' } });
  assert.equal(login.body.payload.uid, 'ana');
  assert.equal(login.body.payload.email, 'ana@teste.local');
  // Dois amigos podem ter o mesmo nome de exibição.
  await t.user('ana2', 'Ana');
});

test('nome de conta antiga não vinculada oferece recuperação', async () => {
  await t.models.User.create({ username: 'Vovô', displayName: 'Vovô' });
  await t.user('neto', 'Neto', { register: false });
  const r = await t.request('POST', '/users/register', { as: 'neto', body: { displayName: 'Vovô' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LEGACY_NAME');
});

test('amizade por e-mail: pedido, aceitar de volta e remover', async () => {
  await t.user('bia', 'Bia'); await t.user('caio', 'Caio');
  assert.equal((await t.request('POST', '/friends', { as: 'bia', body: { email: 'ninguem@teste.local' } })).status, 404);
  assert.equal((await t.request('POST', '/friends', { as: 'bia', body: { email: 'bia@teste.local' } })).status, 400);
  assert.equal((await t.request('POST', '/friends', { as: 'bia', body: { email: 'CAIO@teste.local' } })).body.payload.status, 'pending');
  const caio = (await t.request('GET', '/friends', { as: 'caio' })).body.payload;
  assert.equal(caio.incoming.length, 1);
  assert.equal(caio.incoming[0].displayName, 'Bia');
  assert.equal((await t.request('POST', `/friends/${caio.incoming[0].id}/accept`, { as: 'caio' })).status, 200);
  assert.deepEqual((await t.request('GET', '/friends', { as: 'bia' })).body.payload.friends.map((f) => f.uid), ['caio']);
  // Pedido cruzado vira amizade direto.
  await t.user('davi', 'Davi');
  await t.request('POST', '/friends', { as: 'davi', body: { email: 'bia@teste.local' } });
  assert.equal((await t.request('POST', '/friends', { as: 'bia', body: { email: 'davi@teste.local' } })).body.payload.status, 'accepted');
  const id = (await t.request('GET', '/friends', { as: 'bia' })).body.payload.friends.find((f) => f.uid === 'davi').id;
  await t.request('DELETE', `/friends/${id}`, { as: 'davi' });
  assert.equal((await t.request('GET', '/friends', { as: 'bia' })).body.payload.friends.length, 1);
});

test('só amigos podem ser convidados direto; admin pode convidar qualquer um', async () => {
  await t.user('eva', 'Eva'); await t.user('fred', 'Fred'); await t.user('admin', 'Admin');
  const r = await t.request('POST', '/churrascos', { as: 'eva', body: { ...spDateTime(600), local: 'X', invitedUids: ['fred'] } });
  assert.equal(r.status, 403);
  await t.befriend('eva', 'fred');
  await newEvent('eva', { invitedUids: ['fred'] });
  assert.equal((await t.request('POST', '/churrascos', { as: 'admin', body: { ...spDateTime(600), local: 'X', invitedUids: ['eva'] } })).status, 201);
});

test('várias pessoas levam a mesma categoria, com detalhes e "Outro"', async () => {
  await t.user('org1', 'Organizador'); await t.user('g1', 'Gui'); await t.user('g2', 'Gabi');
  await t.befriend('org1', 'g1'); await t.befriend('org1', 'g2');
  const id = await newEvent('org1', { invitedUids: ['g1', 'g2'], contributions: [{ category: 'Carvão', details: { quantidade: '5 kg' } }] });
  const picanha = { category: 'Carne bovina', details: { corte: 'Picanha', quantidade: '1,5 kg', tempero: 'Sem tempero' } };
  assert.equal((await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'g1', body: { status: 'confirmed', contributions: [picanha] } })).status, 200);
  const both = await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'g2', body: { status: 'confirmed', contributions: [{ ...picanha, details: { corte: 'Fraldinha', quantidade: '2 kg' } }, { category: 'outro', note: 'Farofa da vó' }] } });
  assert.equal(both.status, 200);
  const e = await get(id, 'org1');
  assert.equal(e.contributions.filter((c) => c.category === 'Carne bovina').length, 2);
  assert.deepEqual(e.contributions.find((c) => c.uid === 'g1').details, picanha.details);
  assert.equal(e.contributions.find((c) => c.category === 'outro').note, 'Farofa da vó');
  assert.equal(e.contributions.find((c) => c.category === 'Carvão').displayName, 'Organizador');
  // "Outro" vazio é recusado.
  assert.equal((await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'g1', body: { status: 'confirmed', contributions: [{ category: 'outro' }] } })).status, 400);
  // Recusar tira os itens e o acesso ao chat.
  assert.equal(t.database.read(`eventAccess/${id}/g1`), true);
  await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'g1', body: { status: 'declined' } });
  const after = await get(id, 'g1');
  assert.equal(after.contributions.some((c) => c.uid === 'g1'), false);
  assert.equal(after.myStatus, 'declined');
  assert.equal(t.database.read(`eventAccess/${id}/g1`), undefined);
});

test('quem não participa não lê nem escreve no evento', async () => {
  await t.user('dono', 'Dono'); await t.user('estranho', 'Estranho');
  const id = await newEvent('dono');
  assert.equal((await t.request('GET', `/churrascos/${id}`, { as: 'estranho' })).status, 403);
  assert.equal((await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'estranho', body: { status: 'confirmed' } })).status, 403);
  assert.equal((await t.request('POST', `/churrascos/${id}/messages`, { as: 'estranho', body: { text: 'oi' } })).status, 403);
  assert.equal((await t.request('POST', `/churrascos/${id}/expenses`, { as: 'estranho', body: { amountCents: 100, description: 'x' } })).status, 403);
  assert.equal((await t.request('GET', `/churrascos/${id}/balance`, { as: 'estranho' })).status, 403);
});

test('edição só pelo organizador ou admin, e avisa os participantes', async () => {
  await t.user('org2', 'Org'); await t.user('conv2', 'Conv');
  await t.befriend('org2', 'conv2');
  const id = await newEvent('org2', { invitedUids: ['conv2'] });
  assert.equal((await get(id, 'conv2')).canEdit, false);
  assert.equal((await t.request('PATCH', `/churrascos/${id}`, { as: 'conv2', body: { local: 'Outro lugar' } })).status, 403);
  const tomorrow = spDateTime(60 * 30);
  await t.request('POST', '/users/login', { as: 'conv2', body: { fcmToken: 'tok-conv2' } });
  const r = await t.request('PATCH', `/churrascos/${id}`, { as: 'org2', body: { ...tomorrow, local: 'Sítio', address: 'Estrada 2' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.churrasco.local, 'Sítio');
  assert.equal(r.body.churrasco.address, 'Estrada 2');
  assert.ok(t.sent.some((m) => m.token === 'tok-conv2' && m.data.type === 'event_updated'));
  assert.equal((await t.request('PATCH', `/churrascos/${id}`, { as: 'admin', body: { local: 'Pelo admin' } })).status, 200);
  assert.equal((await t.request('PATCH', `/churrascos/${id}`, { as: 'org2', body: { hora: '99:99' } })).status, 400);
});

test('lista separa ativos e passados pelo horário de São Paulo', async () => {
  await t.user('tz', 'Tz');
  const soon = await newEvent('tz', spDateTime(30));
  const past = await newEvent('tz', spDateTime(-30));
  const active = (await t.request('GET', '/churrascos?status=active', { as: 'tz' })).body.churrascos.map((e) => e.id);
  const history = (await t.request('GET', '/churrascos?status=past', { as: 'tz' })).body.churrascos.map((e) => e.id);
  assert.ok(active.includes(soon) && !active.includes(past));
  assert.ok(history.includes(past) && !history.includes(soon));
});

test('link de convite: página pública, App Link e aceite por quem não era amigo', async () => {
  await t.user('org3', 'Marina Silva'); await t.user('novo', 'Novo');
  const id = await newEvent('org3');
  const link = (await t.request('POST', `/churrascos/${id}/invite-link`, { as: 'org3' })).body.payload;
  assert.match(link.url, /^https:\/\/churrasco\.test\/convite\/[A-Za-z0-9_-]{16,}$/);
  const page = await t.request('GET', `/convite/${link.token}`, { version: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /Churrasco de Marina/);
  assert.doesNotMatch(page.text, /Rua A/); // a página pública não mostra o endereço
  const assetlinks = await t.request('GET', '/.well-known/assetlinks.json', { version: null });
  assert.equal(assetlinks.body[0].target.package_name, 'com.longynus.churrasco');
  const accepted = await t.request('POST', `/invites/${link.token}/accept`, { as: 'novo' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.churrasco.myStatus, 'invited');
  assert.ok((await t.request('GET', '/invites/pending', { as: 'novo' })).body.invites.some((e) => e.id === id));
  // Trocar o link invalida o antigo.
  await t.request('POST', `/churrascos/${id}/invite-link`, { as: 'org3', body: { rotate: true } });
  await t.user('tarde', 'Tarde');
  assert.equal((await t.request('POST', `/invites/${link.token}/accept`, { as: 'tarde' })).status, 404);
});

test('despesas e divisão: transferências mínimas com a chave Pix de quem recebe', async () => {
  await t.user('p1', 'Paulo'); await t.user('p2', 'Pri'); await t.user('p3', 'Pedro');
  await t.befriend('p1', 'p2'); await t.befriend('p1', 'p3');
  await t.request('PATCH', '/users/me', { as: 'p1', body: { pixKey: 'paulo@pix.com' } });
  const id = await newEvent('p1', { invitedUids: ['p2', 'p3'] });
  await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'p2', body: { status: 'confirmed' } });
  await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'p3', body: { status: 'confirmed' } });
  await t.request('POST', `/churrascos/${id}/expenses`, { as: 'p1', body: { amountCents: 30000, description: 'Carnes' } });
  await t.request('POST', `/churrascos/${id}/expenses`, { as: 'p2', body: { amountCents: 6001, description: 'Gelo e carvão' } });
  const b = (await t.request('GET', `/churrascos/${id}/balance`, { as: 'p3' })).body.payload;
  assert.equal(b.totalCents, 36001);
  assert.equal(b.transfers.reduce((s, x) => s + x.amountCents, 0), 30000 - 12001 + 0); // tudo vai para quem pagou a mais
  assert.ok(b.transfers.every((x) => x.to.uid === 'p1' && x.to.pixKey === 'paulo@pix.com'));
  assert.equal(b.balances.reduce((s, x) => s + x.netCents, 0), 0);
  assert.equal((await t.request('POST', `/churrascos/${id}/expenses`, { as: 'p2', body: { amountCents: -5, description: 'x' } })).status, 400);
  const expenseId = (await get(id, 'p1')).expenses.find((x) => x.uid === 'p2').id;
  assert.equal((await t.request('DELETE', `/churrascos/${id}/expenses/${expenseId}`, { as: 'p3' })).status, 403);
  assert.equal((await t.request('DELETE', `/churrascos/${id}/expenses/${expenseId}`, { as: 'p1' })).status, 200);
});

test('chat grava UID de quem mandou; mapa só abre perto da hora', async () => {
  await t.user('m1', 'Mário'); await t.user('m2', 'Mel');
  await t.befriend('m1', 'm2');
  const id = await newEvent('m1', { ...spDateTime(30), invitedUids: ['m2'] });
  assert.equal((await t.request('POST', `/churrascos/${id}/messages`, { as: 'm2', body: { text: 'oi' } })).status, 403);
  await t.request('POST', `/churrascos/${id}/rsvp`, { as: 'm2', body: { status: 'confirmed' } });
  assert.equal((await t.request('POST', `/churrascos/${id}/messages`, { as: 'm2', body: { text: 'Levo gelo' } })).status, 200);
  const messages = Object.values(t.database.read(`churrascos/${id}/messages`));
  assert.deepEqual(messages.map((m) => [m.senderUid, m.sender, m.text]), [['m2', 'Mel', 'Levo gelo']]);
  const session = (await t.request('POST', `/churrascos/${id}/location-session`, { as: 'm2' })).body;
  assert.ok(session.sessionId);
  const sent = await t.request('POST', `/churrascos/${id}/location`, { as: 'm2', body: { latitude: -23.5, longitude: -46.6, sessionId: session.sessionId } });
  assert.equal(sent.status, 200);
  assert.equal(t.database.read(`churrascos/${id}/locations/m2`).displayName, 'Mel');
  const later = await newEvent('m1', spDateTime(60 * 5));
  assert.equal((await t.request('POST', `/churrascos/${later}/location-session`, { as: 'm1' })).status, 403);
});

test('cancelar: só organizador/admin, e tira o acesso do Firebase', async () => {
  await t.user('c1', 'C1'); await t.user('c2', 'C2');
  await t.befriend('c1', 'c2');
  const id = await newEvent('c1', { invitedUids: ['c2'] });
  assert.equal((await t.request('DELETE', `/churrascos/${id}`, { as: 'c2' })).status, 403);
  assert.equal(t.database.read(`eventAccess/${id}/c1`), true);
  assert.equal((await t.request('DELETE', `/churrascos/${id}`, { as: 'c1' })).status, 200);
  assert.equal(t.database.read(`eventAccess/${id}`), undefined);
  assert.equal((await t.request('GET', `/churrascos/${id}`, { as: 'c1' })).status, 404);
});
