#!/usr/bin/env node
// Migra o banco do modelo v1 (pessoas pelo nome) para o v2 (pessoas pelo UID do Firebase).
//
//   node scripts/migrate-v2.js --dry-run     só mostra o que mudaria
//   node scripts/migrate-v2.js               faz backup em backups/<data>/ e migra
//
// Usa MONGO_URI do ambiente (.env). Pode rodar de novo: eventos já em v2 são ignorados.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const V1_FIELDS = ['createdBy', 'invitedUsers', 'guestsConfirmed', 'guestsDeclined', 'fornecidos', 'organizerItems'];

/** Converte um evento v1 em campos v2. Pura: não acessa banco. */
function convertEvent(event, uidByUsername) {
  const who = (name) => {
    const uid = uidByUsername.get(name) || null;
    return uid ? { uid, legacyUsername: null } : { uid: null, legacyUsername: name };
  };
  const organizer = event.createdBy;
  const confirmed = (event.guestsConfirmed || []).filter((g) => g && g.name);
  const declined = new Set(event.guestsDeclined || []);
  const names = [...new Set([...(event.invitedUsers || []), ...confirmed.map((g) => g.name), ...declined])]
    .filter((n) => n && n !== organizer);

  const participants = names.map((name) => ({
    ...who(name),
    status: confirmed.some((g) => g.name === name) ? 'confirmed' : declined.has(name) ? 'declined' : 'invited',
  }));

  const guestItems = new Set(confirmed.flatMap((g) => g.items || []));
  // Eventos muito antigos não têm organizerItems: o que não é de nenhum convidado era do organizador.
  const organizerItems = Array.isArray(event.organizerItems)
    ? event.organizerItems
    : (event.fornecidos || []).filter((i) => !guestItems.has(i));
  const contribution = (owner, category) => ({ id: crypto.randomUUID(), ...who(owner), category, details: {}, note: '' });
  const contributions = [
    ...organizerItems.map((item) => contribution(organizer, item)),
    ...confirmed.filter((g) => g.name !== organizer).flatMap((g) => (g.items || []).map((item) => contribution(g.name, item))),
  ];

  const org = who(organizer);
  return {
    schemaVersion: 2,
    organizerUid: org.uid,
    organizerLegacyUsername: org.legacyUsername,
    participants,
    contributions,
    expenses: event.expenses || [],
    address: event.address || '',
  };
}

async function main() {
  require('dotenv').config();
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('Defina MONGO_URI');
  const { MongoClient, BSON } = require('mongodb');
  const client = await MongoClient.connect(uri);
  const db = client.db();
  try {
    const users = await db.collection('users').find().toArray();
    const events = await db.collection('churrascos').find().toArray();

    if (!dryRun) {
      const dir = path.join(__dirname, '..', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      for (const name of (await db.listCollections().toArray()).map((c) => c.name)) {
        const rows = await db.collection(name).find().toArray();
        fs.writeFileSync(path.join(dir, `${name}.json`), BSON.EJSON.stringify(rows, null, 2, { relaxed: false }));
      }
      console.log(`Backup completo em ${dir}`);
    }

    const uidByUsername = new Map(users.filter((u) => u.firebaseUid).map((u) => [u.username, u.firebaseUid]));
    const report = { events: events.length, alreadyV2: 0, migrated: 0, participants: 0, contributions: 0, unlinkedNames: new Set() };
    for (const event of events) {
      if (event.schemaVersion === 2) { report.alreadyV2 += 1; continue; }
      const next = convertEvent(event, uidByUsername);
      report.migrated += 1;
      report.participants += next.participants.length;
      report.contributions += next.contributions.length;
      if (next.organizerLegacyUsername) report.unlinkedNames.add(next.organizerLegacyUsername);
      for (const p of [...next.participants, ...next.contributions]) if (p.legacyUsername) report.unlinkedNames.add(p.legacyUsername);
      if (!dryRun) {
        const unset = Object.fromEntries(V1_FIELDS.map((f) => [f, '']));
        const result = await db.collection('churrascos').updateOne(
          { _id: event._id, schemaVersion: { $ne: 2 } },
          { $set: next, $unset: unset }
        );
        if (result.modifiedCount !== 1) throw new Error(`Evento ${event._id} mudou durante a migração; rode de novo`);
      }
    }

    // Contas antigas vinculadas ficam com o mesmo username; só garantem e-mail via Firebase quando possível.
    report.usersWithoutEmail = users.filter((u) => u.firebaseUid && !u.email).length;
    console.log(JSON.stringify({ ...report, unlinkedNames: [...report.unlinkedNames].sort(), dryRun }, null, 2));
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { convertEvent };
