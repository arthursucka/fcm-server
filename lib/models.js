'use strict';
// Modelo v2: pessoas são identificadas pelo UID do Firebase. `legacyUsername`
// só existe para quem ainda não vinculou a conta antiga (antes do login por e-mail).

const { Schema } = require('mongoose');

// `db` pode ser o mongoose global (produção) ou uma conexão isolada (testes).
module.exports = function defineModels(db) {
  const userSchema = new Schema({
    // Na v1 era o nome digitado e servia de chave. Contas novas recebem o próprio UID aqui.
    username: { type: String, unique: true, required: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    fcmTokens: { type: [String], default: [] },
    firebaseUid: { type: String, unique: true, sparse: true },
    pixKey: { type: String, trim: true, default: null },
    legacyLinkStatus: { type: String, enum: ['pending_access', 'ready'] },
  });
  userSchema.index({ email: 1 }, { sparse: true });

  const participantSchema = new Schema({
    uid: { type: String, default: null },
    legacyUsername: { type: String, default: null },
    status: { type: String, enum: ['invited', 'confirmed', 'declined'], required: true },
  }, { _id: false });

  const contributionSchema = new Schema({
    id: { type: String, required: true },
    uid: { type: String, default: null },
    legacyUsername: { type: String, default: null },
    category: { type: String, required: true },
    details: { type: Map, of: String, default: {} },
    note: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  }, { _id: false });

  const expenseSchema = new Schema({
    id: { type: String, required: true },
    uid: { type: String, required: true },
    amountCents: { type: Number, required: true },
    description: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  }, { _id: false });

  const churrascoSchema = new Schema({
    schemaVersion: { type: Number, default: 2 },
    churrascoDate: { type: String, required: true },
    hora: { type: String, required: true },
    local: { type: String, required: true },
    address: { type: String, default: '' },
    organizerUid: { type: String, default: null },
    organizerLegacyUsername: { type: String, default: null },
    participants: { type: [participantSchema], default: [] },
    contributions: { type: [contributionSchema], default: [] },
    expenses: { type: [expenseSchema], default: [] },
    inviteToken: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  });
  churrascoSchema.index({ organizerUid: 1 });
  churrascoSchema.index({ 'participants.uid': 1 });
  churrascoSchema.index({ inviteToken: 1 }, { sparse: true });

  const friendshipSchema = new Schema({
    requesterUid: { type: String, required: true },
    addresseeUid: { type: String, required: true },
    status: { type: String, enum: ['pending', 'accepted'], required: true },
    createdAt: { type: Date, default: Date.now },
  });
  friendshipSchema.index({ requesterUid: 1, addresseeUid: 1 }, { unique: true });
  friendshipSchema.index({ addresseeUid: 1 });

  return {
    User: db.models.User || db.model('User', userSchema),
    Churrasco: db.models.Churrasco || db.model('Churrasco', churrascoSchema),
    Friendship: db.models.Friendship || db.model('Friendship', friendshipSchema),
  };
};
