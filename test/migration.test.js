const {test} = require('node:test');
const assert = require('node:assert/strict');
const {planIdentityMigration} = require('../scripts/plan-identity-migration');
const eventId = '507f1f77bcf86cd799439011';
function fixture() { return {
  accounts: [{username: 'owner'}, {username: 'guest'}, {username: 'invited'}],
  identities: [{uid: 'owner-uid'}, {uid: 'guest-uid'}, {uid: 'invited-uid'}],
  bindings: ['owner','guest','invited'].map(username => ({username, firebaseUid: `${username}-uid`, approved: true, evidenceReference: 'SIMULATED REVIEW ONLY', reviewer: 'Fixture'})),
  events: [{id: eventId, createdBy: 'owner', guestsConfirmed: [{name: 'guest'}], invitedUsers: ['invited']}]
}; }
test('offline plan preserves input and grants owner/confirmed only', () => {
  const input=fixture(), before=JSON.stringify(input), p=planIdentityMigration(input);
  assert.equal(p.status,'prepared_only'); assert.equal(JSON.stringify(input),before);
  assert.deepEqual(p.eventAccess[eventId], {'owner-uid': true, 'guest-uid': true});
  assert.equal(p.uidBindings.length,3);
});
for (const [label,change,code] of [
  ['missing review', i=>i.bindings[0].approved=false, 'UNREVIEWED_BINDING'],
  ['missing evidence', i=>i.bindings[0].evidenceReference='', 'UNREVIEWED_BINDING'],
  ['unknown UID', i=>i.bindings[0].firebaseUid='missing', 'UNKNOWN_TARGET_UID'],
  ['duplicate name', i=>i.accounts.push({...i.accounts[0]}), 'DUPLICATE_USERNAME'],
  ['UID assigned twice', i=>i.bindings[1].firebaseUid='owner-uid', 'UID_ASSIGNED_TWICE'],
  ['rebind existing UID', i=>i.accounts[0].firebaseUid='guest-uid', 'REBIND_FORBIDDEN'],
  ['missing confirmed binding', i=>i.bindings=i.bindings.filter(b=>b.username!=='guest'), 'UNMAPPED_PARTICIPANT'],
  ['missing dormant account binding', i=>i.bindings=i.bindings.filter(b=>b.username!=='invited'), 'UNMAPPED_ACCOUNT'],
  ['sensitive snapshot', i=>i.accounts[0].fcmTokens=['fictional-token'], 'UNSANITIZED_ACCOUNT'],
  ['null UID', i=>i.accounts[0].firebaseUid=null, 'INVALID_EXISTING_UID'],
  ['unknown participant', i=>i.events[0].guestsConfirmed.push({name:'unknown'}), 'UNKNOWN_PARTICIPANT'],
]) {
  test(`unsafe migration blocked: ${label}`, () => {
    const input=fixture(); change(input); const p=planIdentityMigration(input);
    assert.equal(p.status,'blocked'); assert(p.errors.some(e=>e.code===code));
    assert.deepEqual(p.uidBindings,[]); assert.deepEqual(p.eventAccess,{});
  });
}
