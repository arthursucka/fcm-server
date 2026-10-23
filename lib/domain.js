'use strict';
// Regras puras do evento (sem Mongo nem Firebase), testadas isoladamente.
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const LIMITS = { contributions: 30, category: 60, detailKeys: 8, detailKey: 40, detailValue: 80, note: 200 };

/** Valida e normaliza as contribuições de UMA pessoa. Várias pessoas podem levar a mesma categoria. */
function normalizeContributions(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > LIMITS.contributions) {
    throw new HttpError(400, `Informe até ${LIMITS.contributions} itens`);
  }
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Item inválido');
    const category = typeof raw.category === 'string' ? raw.category.trim() : '';
    if (!category || category.length > LIMITS.category) throw new HttpError(400, 'Escolha a categoria do item');

    const details = {};
    const entries = Object.entries(raw.details && typeof raw.details === 'object' ? raw.details : {});
    if (entries.length > LIMITS.detailKeys) throw new HttpError(400, 'Detalhes demais em um item');
    for (const [key, value] of entries) {
      const k = String(key).trim();
      const v = value == null ? '' : String(value).trim();
      if (!k || k.length > LIMITS.detailKey || /[.$]/.test(k) || v.length > LIMITS.detailValue) {
        throw new HttpError(400, 'Detalhe do item inválido');
      }
      if (v) details[k] = v;
    }

    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    if (note.length > LIMITS.note) throw new HttpError(400, 'Observação longa demais');
    if (category === 'outro' && !note) throw new HttpError(400, 'Descreva o que você vai levar em "Outro"');

    const id = typeof raw.id === 'string' && /^[a-zA-Z0-9-]{8,40}$/.test(raw.id) ? raw.id : crypto.randomUUID();
    return { id, category, details, note };
  });
}

function sameUid(a, b) { return !!a && a === b; }

function participantOf(event, uid) {
  return (event.participants || []).find((p) => sameUid(p.uid, uid)) || null;
}

function isOrganizer(event, uid) { return sameUid(event.organizerUid, uid); }

/** Organizador e confirmados: leem chat e mapa, lançam despesas, entram na divisão. */
function isActiveMember(event, uid) {
  return isOrganizer(event, uid) || participantOf(event, uid)?.status === 'confirmed';
}

function canRead(event, uid, isAdmin = false) {
  return isAdmin || isOrganizer(event, uid) || !!participantOf(event, uid);
}

function canEdit(event, uid, isAdmin = false) { return isAdmin || isOrganizer(event, uid); }

function memberUids(event) {
  const set = new Set();
  if (event.organizerUid) set.add(event.organizerUid);
  for (const p of event.participants || []) if (p.uid && p.status === 'confirmed') set.add(p.uid);
  return [...set];
}

function parseAmountCents(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 10_000_000) throw new HttpError(400, 'Informe um valor entre R$ 0,01 e R$ 100.000,00');
  return n;
}

/**
 * Divide as despesas igualmente entre os membros e calcula o menor número de Pix
 * para quitar tudo. Centavos que sobram da divisão ficam com os primeiros membros
 * (ordem estável), então a soma fecha exatamente.
 */
function settle(expenses, members) {
  const uids = [...members];
  const paid = new Map(uids.map((u) => [u, 0]));
  for (const e of expenses || []) {
    if (!paid.has(e.uid)) { paid.set(e.uid, 0); uids.push(e.uid); }
    paid.set(e.uid, paid.get(e.uid) + e.amountCents);
  }
  const total = [...paid.values()].reduce((a, b) => a + b, 0);
  const sharers = uids.filter((u) => members.includes(u));
  if (!sharers.length || !total) {
    return { totalCents: total, shareCents: 0, balances: uids.map((uid) => ({ uid, paidCents: paid.get(uid), netCents: 0 })), transfers: [] };
  }
  const base = Math.floor(total / sharers.length);
  let rest = total - base * sharers.length;
  const owed = new Map(uids.map((u) => [u, 0]));
  for (const u of sharers) { owed.set(u, base + (rest > 0 ? 1 : 0)); if (rest > 0) rest -= 1; }

  const balances = uids.map((uid) => ({ uid, paidCents: paid.get(uid), netCents: paid.get(uid) - owed.get(uid) }));
  const debtors = balances.filter((b) => b.netCents < 0).map((b) => ({ uid: b.uid, left: -b.netCents })).sort((a, b) => b.left - a.left);
  const creditors = balances.filter((b) => b.netCents > 0).map((b) => ({ uid: b.uid, left: b.netCents })).sort((a, b) => b.left - a.left);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    transfers.push({ fromUid: debtors[i].uid, toUid: creditors[j].uid, amountCents: amount });
    debtors[i].left -= amount; creditors[j].left -= amount;
    if (!debtors[i].left) i += 1;
    if (!creditors[j].left) j += 1;
  }
  return { totalCents: total, shareCents: base, balances, transfers };
}

function validPixKey(value) {
  if (value == null || value === '') return null;
  const key = String(value).trim();
  if (key.length > 77) throw new HttpError(400, 'Chave Pix longa demais');
  return key;
}

module.exports = {
  HttpError, LIMITS, normalizeContributions, participantOf, isOrganizer, isActiveMember,
  canRead, canEdit, memberUids, parseAmountCents, settle, validPixKey,
};
