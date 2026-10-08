// Offline planning only: no Mongo, Firebase, credentials or data mutation.
'use strict';
const fs = require('node:fs');

function planIdentityMigration(input) {
  const errors = [];
  const error = (code, reference) => errors.push({code, reference});
  if (!input || !['accounts', 'identities', 'bindings', 'events'].every(k => Array.isArray(input[k]))) {
    return {status: 'blocked', errors: [{code: 'INVALID_INPUT', reference: 'Expected accounts, identities, bindings and events arrays'}], uidBindings: [], eventAccess: {}};
  }
  const nonempty = s => typeof s === 'string' && s.trim().length > 0;
  const validUid = s => nonempty(s) && s.length <= 128 && !/[.#$\[\]/\u0000-\u001f\u007f]/.test(s);
  const accounts = new Map(), identities = new Set(), assigned = new Map(), resolved = new Map(), bindings = new Set();
  for (const i of input.identities) {
    if (!i || !validUid(i.uid)) { error('INVALID_IDENTITY', 'identities'); continue; }
    if (identities.has(i.uid)) error('DUPLICATE_IDENTITY', i.uid);
    identities.add(i.uid);
  }
  for (const a of input.accounts) {
    if (!a || !nonempty(a.username) || a.username !== a.username.trim()) { error('INVALID_ACCOUNT', 'accounts'); continue; }
    if (Object.keys(a).some(k => !['username', 'firebaseUid'].includes(k))) error('UNSANITIZED_ACCOUNT', a.username);
    if (accounts.has(a.username)) error('DUPLICATE_USERNAME', a.username);
    accounts.set(a.username, a);
    if (a.firebaseUid !== undefined) {
      if (!validUid(a.firebaseUid) || !identities.has(a.firebaseUid)) error('INVALID_EXISTING_UID', a.username);
      else {
        if (assigned.has(a.firebaseUid)) error('UID_ASSIGNED_TWICE', a.username);
        assigned.set(a.firebaseUid, a.username); resolved.set(a.username, a.firebaseUid);
      }
    }
  }
  const uidBindings = [];
  for (const b of input.bindings) {
    if (!b || !nonempty(b.username)) { error('INVALID_BINDING', 'bindings'); continue; }
    if (bindings.has(b.username)) error('DUPLICATE_BINDING', b.username);
    bindings.add(b.username);
    const account = accounts.get(b.username);
    if (!account) { error('UNKNOWN_ACCOUNT', b.username); continue; }
    if (b.approved !== true || !nonempty(b.evidenceReference) || !nonempty(b.reviewer)) { error('UNREVIEWED_BINDING', b.username); continue; }
    if (!validUid(b.firebaseUid) || !identities.has(b.firebaseUid)) { error('UNKNOWN_TARGET_UID', b.username); continue; }
    if (account.firebaseUid !== undefined && account.firebaseUid !== b.firebaseUid) { error('REBIND_FORBIDDEN', b.username); continue; }
    if (assigned.has(b.firebaseUid) && assigned.get(b.firebaseUid) !== b.username) { error('UID_ASSIGNED_TWICE', b.username); continue; }
    assigned.set(b.firebaseUid, b.username); resolved.set(b.username, b.firebaseUid);
    if (account.firebaseUid === undefined) uidBindings.push({username: b.username, firebaseUid: b.firebaseUid,
      expectedPreviousUid: 'absent', evidenceReference: b.evidenceReference, reviewer: b.reviewer});
  }
  const eventAccess = {};
  for (const name of accounts.keys()) {
    if (!resolved.has(name)) error('UNMAPPED_ACCOUNT', name);
  }
  for (const e of input.events) {
    if (!e || typeof e.id !== 'string' || !/^[a-f0-9]{24}$/i.test(e.id) || !nonempty(e.createdBy) || !Array.isArray(e.guestsConfirmed)) {
      error('INVALID_EVENT', 'events'); continue;
    }
    if (Object.hasOwn(eventAccess, e.id)) error('DUPLICATE_EVENT', e.id);
    const participants = [e.createdBy, ...e.guestsConfirmed.map(g => g && g.name)];
    const acl = {};
    for (const name of participants) {
      if (!accounts.has(name)) { error('UNKNOWN_PARTICIPANT', e.id); continue; }
      const uid = resolved.get(name);
      if (!uid) { error('UNMAPPED_PARTICIPANT', e.id); continue; }
      Object.defineProperty(acl, uid, {value: true, enumerable: true, configurable: true});
    }
    eventAccess[e.id] = acl;
  }
  if (errors.length) return {status: 'blocked', errors, uidBindings: [], eventAccess: {}};
  return {status: 'prepared_only', errors: [], uidBindings, eventAccess,
    unmappedAccounts: [...accounts.keys()].filter(name => !resolved.has(name)),
    warning: 'Input approval is asserted by the reviewer, not proven by this tool. No database modified. Never merge this ACL plan blindly with stale permissions.'};
}

module.exports = {planIdentityMigration};
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/plan-identity-migration.js sanitized-input.json');
    const plan = planIdentityMigration(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    if (plan.status === 'blocked') process.exitCode = 2;
  } catch (_) {
    process.stderr.write('Unable to read valid migration input. No data changed.\n');
    process.exitCode = 2;
  }
}
