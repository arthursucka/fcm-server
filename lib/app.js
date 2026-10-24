'use strict';
// API v2 do Manda Churras. Montada como fábrica para que os testes injetem Mongo e um
// Firebase falso; server.js só inicializa as dependências reais e chama listen().
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const locationPolicy = require('../location-policy');
const locationTransaction = require('../location-session-store');
const d = require('./domain');

const { HttpError } = d;

module.exports = function createApp({ mongoose, models, admin, env = process.env, firebaseEnabled = true, localTest = false, publicBaseUrl }) {
  const { User, Churrasco, Friendship } = models;
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  const baseUrl = (publicBaseUrl || env.PUBLIC_BASE_URL || 'https://fcm-server-oe8u.onrender.com').replace(/\/$/, '');
  const minAppVersion = Number(env.MIN_APP_VERSION || 21);
  const adminUids = new Set(
    [...String(env.CHURRASCO_ADMIN_UIDS || '').split(','), env.CHURRASCO_MIGRATION_REVIEWER_UID]
      .map((s) => (s || '').trim()).filter(Boolean)
  );
  const isAdmin = (uid) => adminUids.has(uid);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // --- Rotas públicas ------------------------------------------------------

  app.get('/', (req, res) => res.json({ success: true, message: 'Backend do Manda Churras online' }));
  app.get('/health', (req, res) => res.json({
    success: true,
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    firebase: firebaseEnabled ? 'enabled' : 'disabled',
    minAppVersion,
  }));

  // App Links: o Android só abre /convite/... direto no app se este arquivo listar a assinatura dele.
  app.get('/.well-known/assetlinks.json', (req, res) => {
    const fingerprints = String(env.ANDROID_CERT_SHA256 ||
      'A3:62:C5:85:CB:60:F3:A2:85:BC:DB:6C:A3:99:EB:6C:BA:82:FD:81:BE:13:A3:AD:CE:3D:0E:FE:8D:4A:CC:D1')
      .split(',').map((s) => s.trim()).filter(Boolean);
    res.json([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.longynus.churrasco', sha256_cert_fingerprints: fingerprints },
    }]);
  });

  // Página que o link de convite abre quando o app não está instalado (ou no navegador).
  app.get('/convite/:token', wrap(async (req, res) => {
    const event = validToken(req.params.token) ? await Churrasco.findOne({ inviteToken: req.params.token }).lean() : null;
    const organizer = event?.organizerUid ? await User.findOne({ firebaseUid: event.organizerUid }).lean() : null;
    const title = event ? `Churrasco de ${escapeHtml(firstName(organizer?.displayName) || 'um amigo')}` : 'Convite não encontrado';
    const subtitle = event ? `${escapeHtml(event.churrascoDate)} às ${escapeHtml(event.hora)}` : 'Esse link expirou ou foi trocado pelo organizador.';
    const appLink = `intent://${new URL(baseUrl).host}/convite/${encodeURIComponent(req.params.token)}#Intent;scheme=https;package=com.longynus.churrasco;end`;
    res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(invitePage({ title, subtitle, appLink, found: !!event }));
  }));

  // --- Autenticação e versão do app -----------------------------------------

  // A v1.19 não manda versão: recebe uma mensagem que ela já mostra nos diálogos.
  function requireAppVersion(req, res, next) {
    const version = Number(req.header('X-App-Version'));
    if (!Number.isFinite(version) || version < minAppVersion) {
      return res.status(426).json({ success: false, message: 'Atualize o Manda Churras para continuar. Baixe a versão nova em github.com/arthursucka/Churrasco/releases' });
    }
    return next();
  }

  async function authenticateFirebase(req, res, next) {
    const match = /^Bearer ([^\s]+)$/i.exec(req.header('Authorization') || '');
    if (!match) return res.status(401).json({ success: false, message: 'Entre na sua conta para continuar' });
    if (!firebaseEnabled) return res.status(503).json({ success: false, message: 'Autenticação indisponível' });
    try {
      const token = await admin.auth().verifyIdToken(match[1], true);
      if (typeof token.uid !== 'string' || !token.uid || token.uid.length > 128 || /[.#$\[\]/\u0000-\u001f\u007f]/.test(token.uid)) throw new Error('Invalid UID');
      req.authUid = token.uid;
    } catch (_) {
      return res.status(401).json({ success: false, message: 'Sessão inválida ou expirada' });
    }
    return next();
  }

  async function authMiddleware(req, res, next) {
    return authenticateFirebase(req, res, async () => {
      try {
        const user = await User.findOne({ firebaseUid: req.authUid });
        if (!user) return res.status(403).json({ success: false, code: 'NO_PROFILE', message: 'Complete seu cadastro ou solicite a migração da conta antiga' });
        if (user.legacyLinkStatus === 'pending_access') return res.status(403).json({ success: false, code: 'LINK_PENDING', message: 'Sua vinculação está sendo concluída. Aguarde e consulte a solicitação.' });
        req.profile = user;
        req.isAdmin = isAdmin(req.authUid);
        return next();
      } catch (_) {
        return res.status(503).json({ success: false, message: 'Não foi possível validar seu cadastro' });
      }
    });
  }

  async function verifiedIdentity(uid) {
    const identity = await admin.auth().getUser(uid);
    if (!identity.emailVerified || !identity.email || identity.disabled) {
      throw new HttpError(403, 'Confirme seu e-mail antes de continuar', 'EMAIL_NOT_VERIFIED');
    }
    return identity;
  }

  app.use(['/users', '/friends', '/churrascos', '/invites', '/legacy-link'], requireAppVersion);

  // --- Firebase: acesso ao chat/mapa e notificações ---------------------------

  async function syncReadAccess(event) {
    const id = String(event._id);
    const members = new Set(d.memberUids(event));
    for (const p of event.participants || []) {
      if (!p.uid) continue;
      const ref = admin.database().ref(`eventAccess/${id}/${p.uid}`);
      if (members.has(p.uid)) await ref.set(true);
      else { await ref.remove(); await admin.database().ref(`churrascos/${id}/locations/${p.uid}`).remove(); }
    }
    if (event.organizerUid) await admin.database().ref(`eventAccess/${id}/${event.organizerUid}`).set(true);
  }

  async function notify(uids, data) {
    if (localTest || !firebaseEnabled) return;
    const targets = [...new Set(uids.filter(Boolean))];
    if (!targets.length) return;
    const users = await User.find({ firebaseUid: { $in: targets } }).lean();
    const tokens = [...new Set(users.flatMap((u) => u.fcmTokens || []))];
    const results = await Promise.allSettled(tokens.map((token) =>
      admin.messaging().send({ token, data, android: { priority: 'high' } })));
    const dead = tokens.filter((_, i) => {
      const r = results[i];
      const code = r.status === 'rejected' ? (r.reason?.errorInfo?.code || r.reason?.code) : null;
      return ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'].includes(code);
    });
    if (dead.length) await User.updateMany({ fcmTokens: { $in: dead } }, { $pull: { fcmTokens: { $in: dead } } });
  }
  const notifyLater = (uids, data) => notify(uids, data).catch((e) => console.error('Falha ao notificar', e?.message));

  // --- Apresentação ----------------------------------------------------------

  async function profilesFor(events) {
    const uids = new Set();
    for (const e of events) {
      if (e.organizerUid) uids.add(e.organizerUid);
      for (const p of e.participants || []) if (p.uid) uids.add(p.uid);
      for (const c of e.contributions || []) if (c.uid) uids.add(c.uid);
      for (const x of e.expenses || []) if (x.uid) uids.add(x.uid);
    }
    const users = uids.size ? await User.find({ firebaseUid: { $in: [...uids] } }).lean() : [];
    return new Map(users.map((u) => [u.firebaseUid, u]));
  }

  function person(profiles, uid, legacyUsername) {
    const u = uid ? profiles.get(uid) : null;
    return { uid: uid || null, displayName: u?.displayName || legacyUsername || 'Convidado' };
  }

  function presentEvent(event, viewerUid, profiles, viewerIsAdmin) {
    const plainDetails = (c) => (c.details instanceof Map ? Object.fromEntries(c.details) : (c.details || {}));
    const mine = d.participantOf(event, viewerUid);
    return {
      id: String(event._id),
      churrascoDate: event.churrascoDate,
      hora: event.hora,
      local: event.local,
      address: event.address || '',
      timeZone: locationPolicy.ZONE,
      eventStartsAt: locationPolicy.parseEventDateTime(event.churrascoDate, event.hora)?.getTime() || null,
      organizer: person(profiles, event.organizerUid, event.organizerLegacyUsername),
      participants: (event.participants || []).map((p) => ({ ...person(profiles, p.uid, p.legacyUsername), status: p.status })),
      contributions: (event.contributions || []).map((c) => ({
        id: c.id, ...person(profiles, c.uid, c.legacyUsername), category: c.category, details: plainDetails(c), note: c.note || '',
      })),
      expenses: (event.expenses || []).map((x) => ({ id: x.id, ...person(profiles, x.uid), amountCents: x.amountCents, description: x.description })),
      myStatus: d.isOrganizer(event, viewerUid) ? 'organizer' : (mine?.status || null),
      canEdit: d.canEdit(event, viewerUid, viewerIsAdmin),
    };
  }

  async function presentOne(event, req) {
    return presentEvent(event, req.authUid, await profilesFor([event]), req.isAdmin);
  }

  // --- Usuários ---------------------------------------------------------------

  function publicProfile(user) {
    return { uid: user.firebaseUid, username: user.username, displayName: user.displayName, email: user.email || null, pixKey: user.pixKey || null };
  }

  function readDisplayName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) throw new HttpError(400, 'Informe um nome de até 60 caracteres');
    return value.trim();
  }

  const legacyOnboarding = require('../legacy-onboarding')({ app, mongoose, User, Churrasco, admin, authenticateFirebase, env, syncReadAccess });

  app.post('/users/register', authenticateFirebase, wrap(async (req, res) => {
    await legacyOnboarding.ready();
    const identity = await verifiedIdentity(req.authUid);
    const displayName = readDisplayName(req.body.displayName ?? req.body.username);
    const current = await User.findOne({ firebaseUid: req.authUid });
    if (current) return res.json({ success: true, payload: publicProfile(current) });
    if (await legacyOnboarding.hasActiveRequest(req.authUid)) throw new HttpError(409, 'Você já pediu a recuperação de uma conta antiga. Aguarde a revisão antes de criar outro perfil');
    // Nome de conta antiga ainda não vinculada: oferece a recuperação em vez de criar um perfil com o mesmo nome.
    if (await User.findOne({ username: displayName, firebaseUid: { $exists: false } })) {
      throw new HttpError(409, 'Esse nome é de uma conta antiga. Se for sua, peça a recuperação; se não, escolha outro nome.', 'LEGACY_NAME');
    }
    try {
      const user = await User.create({ username: req.authUid, displayName, email: identity.email.toLowerCase(), firebaseUid: req.authUid });
      return res.status(201).json({ success: true, payload: publicProfile(user) });
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'Cadastro já existente; entre novamente');
      throw error;
    }
  }));

  app.post('/users/login', authMiddleware, wrap(async (req, res) => {
    const { fcmToken } = req.body;
    if (fcmToken != null && (typeof fcmToken !== 'string' || !fcmToken.trim() || fcmToken.length > 4096)) {
      throw new HttpError(400, 'Token de notificação inválido');
    }
    const update = { $set: {} };
    // Mantém o e-mail do perfil igual ao do Firebase (necessário para a busca de amigos).
    const identity = await admin.auth().getUser(req.authUid).catch(() => null);
    if (identity?.email && identity.email.toLowerCase() !== req.profile.email) update.$set.email = identity.email.toLowerCase();
    if (fcmToken) {
      // Um aparelho que troca de conta não pode continuar recebendo notificações da anterior.
      await User.updateMany({ firebaseUid: { $ne: req.authUid }, fcmTokens: fcmToken }, { $pull: { fcmTokens: fcmToken } });
      update.$addToSet = { fcmTokens: fcmToken };
    }
    const user = await User.findOneAndUpdate({ firebaseUid: req.authUid }, update, { new: true });
    return res.json({ success: true, payload: publicProfile(user) });
  }));

  app.post('/users/logout', authMiddleware, wrap(async (req, res) => {
    const { fcmToken } = req.body;
    if (typeof fcmToken === 'string' && fcmToken.length <= 4096) await User.updateOne({ firebaseUid: req.authUid }, { $pull: { fcmTokens: fcmToken } });
    return res.json({ success: true });
  }));

  app.patch('/users/me', authMiddleware, wrap(async (req, res) => {
    const $set = {};
    if ('displayName' in req.body) $set.displayName = readDisplayName(req.body.displayName);
    if ('pixKey' in req.body) $set.pixKey = d.validPixKey(req.body.pixKey);
    const user = await User.findOneAndUpdate({ firebaseUid: req.authUid }, { $set }, { new: true });
    return res.json({ success: true, payload: publicProfile(user) });
  }));

  // --- Amigos -----------------------------------------------------------------

  async function friendUids(uid) {
    const rows = await Friendship.find({ status: 'accepted', $or: [{ requesterUid: uid }, { addresseeUid: uid }] }).lean();
    return new Set(rows.map((r) => (r.requesterUid === uid ? r.addresseeUid : r.requesterUid)));
  }

  app.get('/friends', authMiddleware, wrap(async (req, res) => {
    const uid = req.authUid;
    const rows = await Friendship.find({ $or: [{ requesterUid: uid }, { addresseeUid: uid }] }).sort({ createdAt: -1 }).lean();
    const others = rows.map((r) => (r.requesterUid === uid ? r.addresseeUid : r.requesterUid));
    const users = new Map((await User.find({ firebaseUid: { $in: others } }).lean()).map((u) => [u.firebaseUid, u]));
    const view = (r) => {
      const other = users.get(r.requesterUid === uid ? r.addresseeUid : r.requesterUid);
      return { id: String(r._id), uid: other?.firebaseUid || null, displayName: other?.displayName || 'Conta removida', email: other?.email || null };
    };
    return res.json({
      success: true,
      payload: {
        friends: rows.filter((r) => r.status === 'accepted').map(view).sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR')),
        incoming: rows.filter((r) => r.status === 'pending' && r.addresseeUid === uid).map(view),
        outgoing: rows.filter((r) => r.status === 'pending' && r.requesterUid === uid).map(view),
      },
    });
  }));

  app.post('/friends', authMiddleware, wrap(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Digite um e-mail válido');
    const other = await User.findOne({ email });
    if (!other || !other.firebaseUid) throw new HttpError(404, 'Ninguém com esse e-mail usa o Manda Churras ainda. Mande o link de convite para a pessoa.');
    if (other.firebaseUid === req.authUid) throw new HttpError(400, 'Esse é o seu próprio e-mail');
    const reverse = await Friendship.findOne({ requesterUid: other.firebaseUid, addresseeUid: req.authUid });
    if (reverse) {
      // A outra pessoa já tinha pedido: adicionar de volta aceita direto.
      if (reverse.status === 'pending') { reverse.status = 'accepted'; await reverse.save(); }
      return res.json({ success: true, payload: { status: 'accepted' } });
    }
    const existing = await Friendship.findOne({ requesterUid: req.authUid, addresseeUid: other.firebaseUid });
    if (existing) return res.json({ success: true, payload: { status: existing.status } });
    await Friendship.create({ requesterUid: req.authUid, addresseeUid: other.firebaseUid, status: 'pending' });
    notifyLater([other.firebaseUid], { type: 'friend_request', title: 'Pedido de amizade', body: `${req.profile.displayName} quer te adicionar no Manda Churras` });
    return res.status(201).json({ success: true, payload: { status: 'pending' } });
  }));

  app.post('/friends/:id/accept', authMiddleware, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, 'Pedido inválido');
    const row = await Friendship.findOneAndUpdate({ _id: req.params.id, addresseeUid: req.authUid, status: 'pending' }, { $set: { status: 'accepted' } }, { new: true });
    if (!row) throw new HttpError(404, 'Pedido não encontrado');
    return res.json({ success: true });
  }));

  app.delete('/friends/:id', authMiddleware, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, 'Pedido inválido');
    await Friendship.deleteOne({ _id: req.params.id, $or: [{ requesterUid: req.authUid }, { addresseeUid: req.authUid }] });
    return res.json({ success: true });
  }));

  // --- Churrascos ---------------------------------------------------------------

  app.use('/churrascos', authMiddleware, (req, res, next) => {
    if (env.CHURRASCO_LEGACY_MIGRATION_WINDOW === '1' && req.method !== 'GET') {
      return res.status(503).json({ success: false, message: 'Estamos recuperando as contas antigas. Alterações em churrascos ficam pausadas durante esta etapa.' });
    }
    return next();
  });

  function readSchedule(body, current = {}) {
    const churrascoDate = body.churrascoDate ?? current.churrascoDate;
    const hora = body.hora ?? current.hora;
    if (!locationPolicy.parseEventDateTime(churrascoDate, hora)) throw new HttpError(400, 'Informe data e hora válidas (dd/MM/aaaa e HH:mm), no horário de São Paulo');
    const local = typeof (body.local ?? current.local) === 'string' ? (body.local ?? current.local).trim() : '';
    if (!local || local.length > 120) throw new HttpError(400, 'Informe o local (até 120 caracteres)');
    const address = typeof (body.address ?? current.address ?? '') === 'string' ? String(body.address ?? current.address ?? '').trim() : '';
    if (address.length > 200) throw new HttpError(400, 'Endereço longo demais');
    return { churrascoDate, hora, local, address };
  }

  async function invitableUids(req, uids) {
    if (uids == null) return [];
    if (!Array.isArray(uids) || uids.length > 100 || uids.some((u) => typeof u !== 'string')) throw new HttpError(400, 'Lista de convidados inválida');
    const friends = await friendUids(req.authUid);
    const unique = [...new Set(uids)].filter((u) => u !== req.authUid);
    // Admin pode convidar qualquer cadastrado; os demais, só amigos.
    if (!req.isAdmin && unique.some((u) => !friends.has(u))) throw new HttpError(403, 'Você só pode convidar pessoas da sua lista de amigos');
    const existing = await User.find({ firebaseUid: { $in: unique } }).lean();
    if (existing.length !== unique.length) throw new HttpError(400, 'Algum convidado não tem cadastro');
    return unique;
  }

  async function loadEvent(id) {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'ID inválido');
    const event = await Churrasco.findById(id);
    if (!event) throw new HttpError(404, 'Churrasco não encontrado');
    return event;
  }

  async function loadReadable(req) {
    const event = await loadEvent(req.params.id);
    if (!d.canRead(event, req.authUid, req.isAdmin)) throw new HttpError(403, 'Você não participa deste churrasco');
    return event;
  }

  /** Grava com controle de versão: se outra pessoa mudou o evento no meio, tenta de novo. */
  async function mutate(id, change) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const event = await loadEvent(id);
      const version = event.__v;
      const result = await change(event);
      const saved = await Churrasco.findOneAndUpdate(
        { _id: event._id, __v: version },
        { $set: event.toObject({ depopulate: true, versionKey: false }), $inc: { __v: 1 } },
        { new: true }
      );
      if (saved) return { event: saved, result };
    }
    throw new HttpError(409, 'O churrasco mudou enquanto você respondia. Atualize e tente de novo.');
  }

  app.post('/churrascos', wrap(async (req, res) => {
    const schedule = readSchedule(req.body);
    const invited = await invitableUids(req, req.body.invitedUids);
    const contributions = d.normalizeContributions(req.body.contributions).map((c) => ({ ...c, uid: req.authUid }));
    const event = await Churrasco.create({
      ...schedule,
      organizerUid: req.authUid,
      participants: invited.map((uid) => ({ uid, status: 'invited' })),
      contributions,
    });
    await syncReadAccess(event);
    notifyLater(invited, { type: 'invite', churrascoId: String(event._id), title: 'Você foi convidado para um churrasco!', body: `${schedule.churrascoDate} às ${schedule.hora} em ${schedule.local}` });
    return res.status(201).json({ success: true, id: String(event._id) });
  }));

  app.get('/churrascos', wrap(async (req, res) => {
    const status = req.query.status;
    const now = Date.now();
    const uid = req.authUid;
    const events = (await Churrasco.find({ $or: [{ organizerUid: uid }, { participants: { $elemMatch: { uid, status: { $ne: 'declined' } } } }] }).lean())
      .filter((e) => (status === 'active' || status === 'past' ? locationPolicy.eventStatus(e, now) === status : true))
      .sort((a, b) => (locationPolicy.parseEventDateTime(a.churrascoDate, a.hora) - locationPolicy.parseEventDateTime(b.churrascoDate, b.hora)) * (status === 'past' ? -1 : 1));
    const profiles = await profilesFor(events);
    return res.json({ success: true, churrascos: events.map((e) => presentEvent(e, uid, profiles, req.isAdmin)) });
  }));

  app.get('/churrascos/:id', wrap(async (req, res) => {
    const event = await loadReadable(req);
    return res.json({ success: true, churrasco: await presentOne(event, req) });
  }));

  app.patch('/churrascos/:id', wrap(async (req, res) => {
    let before;
    const { event } = await mutate(req.params.id, async (e) => {
      if (!d.canEdit(e, req.authUid, req.isAdmin)) throw new HttpError(403, 'Só o organizador ou um administrador pode editar');
      before = readSchedule({}, e);
      Object.assign(e, readSchedule(req.body, e));
      if (req.body.invitedUids != null) {
        const extra = await invitableUids(req, req.body.invitedUids);
        for (const uid of extra) if (!d.participantOf(e, uid) && uid !== e.organizerUid) e.participants.push({ uid, status: 'invited' });
      }
    });
    const after = readSchedule({}, event);
    const changed = ['churrascoDate', 'hora', 'local', 'address'].some((k) => before[k] !== after[k]);
    if (changed) {
      const targets = [event.organizerUid, ...event.participants.filter((p) => p.status !== 'declined').map((p) => p.uid)].filter((u) => u !== req.authUid);
      notifyLater(targets, { type: 'event_updated', churrascoId: String(event._id), title: 'O churrasco mudou', body: `Agora: ${after.churrascoDate} às ${after.hora} em ${after.local}` });
    }
    const invitedNow = event.participants.filter((p) => p.status === 'invited').map((p) => p.uid);
    notifyLater((req.body.invitedUids || []).filter((u) => invitedNow.includes(u)), { type: 'invite', churrascoId: String(event._id), title: 'Você foi convidado para um churrasco!', body: `${after.churrascoDate} às ${after.hora} em ${after.local}` });
    return res.json({ success: true, churrasco: await presentOne(event, req) });
  }));

  app.delete('/churrascos/:id', wrap(async (req, res) => {
    const event = await loadEvent(req.params.id);
    if (!d.canEdit(event, req.authUid, req.isAdmin)) throw new HttpError(403, 'Só o organizador ou um administrador pode cancelar');
    // Tira o acesso ao chat/mapa antes de apagar o evento.
    await admin.database().ref(`eventAccess/${req.params.id}`).remove();
    await admin.database().ref(`churrascos/${req.params.id}`).remove();
    await Churrasco.deleteOne({ _id: event._id });
    const targets = event.participants.filter((p) => p.status !== 'declined').map((p) => p.uid).filter((u) => u && u !== req.authUid);
    notifyLater(targets, { type: 'event_cancelled', churrascoId: req.params.id, title: 'Churrasco cancelado', body: `${event.churrascoDate} em ${event.local} não vai mais acontecer` });
    return res.json({ success: true, message: 'Churrasco cancelado' });
  }));

  // Confirmar/recusar e, junto, dizer o que vai levar (substitui as contribuições da pessoa).
  app.post('/churrascos/:id/rsvp', wrap(async (req, res) => {
    const status = req.body.status;
    if (!['confirmed', 'declined'].includes(status)) throw new HttpError(400, 'Resposta inválida');
    const contributions = status === 'confirmed' ? d.normalizeContributions(req.body.contributions) : [];
    const { event } = await mutate(req.params.id, async (e) => {
      const organizer = d.isOrganizer(e, req.authUid);
      const me = d.participantOf(e, req.authUid);
      if (!organizer && !me) throw new HttpError(403, 'Você não foi convidado para este churrasco');
      if (organizer && status === 'declined') throw new HttpError(400, 'O organizador não pode recusar; cancele o churrasco se for o caso');
      if (me) me.status = status;
      e.contributions = [
        ...e.contributions.filter((c) => c.uid !== req.authUid),
        ...contributions.map((c) => ({ ...c, uid: req.authUid })),
      ];
      if (status === 'declined') e.expenses = e.expenses.filter((x) => x.uid !== req.authUid);
    });
    await syncReadAccess(event);
    return res.json({ success: true, message: status === 'confirmed' ? 'Presença confirmada' : 'Presença recusada', churrasco: await presentOne(event, req) });
  }));

  // --- Convite por link ---------------------------------------------------------

  function validToken(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token); }

  app.post('/churrascos/:id/invite-link', wrap(async (req, res) => {
    const rotate = req.body?.rotate === true;
    const { event } = await mutate(req.params.id, async (e) => {
      if (!d.isActiveMember(e, req.authUid) && !req.isAdmin) throw new HttpError(403, 'Confirme presença antes de convidar outras pessoas');
      if (rotate && !d.canEdit(e, req.authUid, req.isAdmin)) throw new HttpError(403, 'Só o organizador pode trocar o link');
      if (!e.inviteToken || rotate) e.inviteToken = crypto.randomBytes(18).toString('base64url');
    });
    return res.json({ success: true, payload: { token: event.inviteToken, url: `${baseUrl}/convite/${event.inviteToken}` } });
  }));

  app.get('/invites/pending', authMiddleware, wrap(async (req, res) => {
    const events = (await Churrasco.find({ participants: { $elemMatch: { uid: req.authUid, status: 'invited' } } }).lean())
      .filter((e) => locationPolicy.eventStatus(e) === 'active');
    const profiles = await profilesFor(events);
    return res.json({ success: true, invites: events.map((e) => presentEvent(e, req.authUid, profiles, req.isAdmin)) });
  }));

  app.post('/invites/:token/accept', authMiddleware, wrap(async (req, res) => {
    if (!validToken(req.params.token)) throw new HttpError(404, 'Convite não encontrado');
    const found = await Churrasco.findOne({ inviteToken: req.params.token }).lean();
    if (!found) throw new HttpError(404, 'Esse convite expirou ou foi trocado pelo organizador');
    if (locationPolicy.eventStatus(found) !== 'active') throw new HttpError(410, 'Esse churrasco já aconteceu');
    const { event } = await mutate(String(found._id), async (e) => {
      if (e.inviteToken !== req.params.token) throw new HttpError(404, 'Esse convite foi trocado pelo organizador');
      const me = d.participantOf(e, req.authUid);
      if (!me && !d.isOrganizer(e, req.authUid)) e.participants.push({ uid: req.authUid, status: 'invited' });
      else if (me?.status === 'declined') me.status = 'invited';
    });
    return res.json({ success: true, id: String(event._id), churrasco: await presentOne(event, req) });
  }));

  // --- Custos e Pix ---------------------------------------------------------------

  app.post('/churrascos/:id/expenses', wrap(async (req, res) => {
    const amountCents = d.parseAmountCents(req.body.amountCents);
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    if (!description || description.length > 80) throw new HttpError(400, 'Descreva a despesa (até 80 caracteres)');
    const { event } = await mutate(req.params.id, async (e) => {
      if (!d.isActiveMember(e, req.authUid)) throw new HttpError(403, 'Confirme presença para lançar despesas');
      if (e.expenses.length >= 100) throw new HttpError(400, 'Limite de despesas atingido');
      e.expenses.push({ id: crypto.randomUUID(), uid: req.authUid, amountCents, description });
    });
    return res.status(201).json({ success: true, churrasco: await presentOne(event, req) });
  }));

  app.delete('/churrascos/:id/expenses/:expenseId', wrap(async (req, res) => {
    const { event } = await mutate(req.params.id, async (e) => {
      const expense = e.expenses.find((x) => x.id === req.params.expenseId);
      if (!expense) throw new HttpError(404, 'Despesa não encontrada');
      if (expense.uid !== req.authUid && !d.canEdit(e, req.authUid, req.isAdmin)) throw new HttpError(403, 'Só quem lançou ou o organizador pode apagar');
      e.expenses = e.expenses.filter((x) => x.id !== req.params.expenseId);
    });
    return res.json({ success: true, churrasco: await presentOne(event, req) });
  }));

  app.get('/churrascos/:id/balance', wrap(async (req, res) => {
    const event = await loadReadable(req);
    const members = d.memberUids(event);
    const result = d.settle(event.expenses, members);
    const profiles = await profilesFor([event]);
    const view = (uid) => ({ ...person(profiles, uid), pixKey: profiles.get(uid)?.pixKey || null });
    return res.json({
      success: true,
      payload: {
        totalCents: result.totalCents,
        shareCents: result.shareCents,
        members: members.length,
        balances: result.balances.map((b) => ({ ...view(b.uid), paidCents: b.paidCents, netCents: b.netCents })),
        transfers: result.transfers.map((t) => ({ from: view(t.fromUid), to: view(t.toUid), amountCents: t.amountCents })),
      },
    });
  }));

  // --- Chat e localização ---------------------------------------------------------

  app.post('/churrascos/:id/messages', wrap(async (req, res) => {
    if (!firebaseEnabled) throw new HttpError(503, 'Chat indisponível no momento');
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 500) throw new HttpError(400, 'Mensagem vazia ou longa demais');
    const event = await loadEvent(req.params.id);
    if (!d.isActiveMember(event, req.authUid)) throw new HttpError(403, 'Confirme presença antes de participar da conversa');
    const message = { senderUid: req.authUid, sender: req.profile.displayName, text, timestamp: Date.now() };
    await admin.database().ref(`churrascos/${String(event._id)}/messages`).push(message);
    const body = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    notifyLater(d.memberUids(event).filter((u) => u !== req.authUid), { type: 'chat_message', churrascoId: String(event._id), title: `Nova mensagem de ${req.profile.displayName}`, body });
    return res.json({ success: true, message: 'Mensagem enviada' });
  }));

  app.post('/churrascos/:id/location-session', wrap(async (req, res) => {
    if (!firebaseEnabled) throw new HttpError(503, 'Localização indisponível no momento');
    const event = await loadEvent(req.params.id);
    if (!d.isActiveMember(event, req.authUid) || !locationPolicy.isOpen(event)) throw new HttpError(403, 'O mapa abre 1 hora antes do churrasco, para quem confirmou presença');
    const fresh = locationPolicy.session(event, crypto.randomUUID());
    const ref = admin.database().ref(`churrascos/${req.params.id}/locations/${req.authUid}`);
    const result = await locationTransaction(ref, (current) => (current && current.expiresAt > Date.now() ? current : fresh));
    const value = result.snapshot.val();
    return res.json({ success: true, sessionId: value.sessionId, expiresAt: value.expiresAt });
  }));

  app.post('/churrascos/:id/location', wrap(async (req, res) => {
    if (!firebaseEnabled) throw new HttpError(503, 'Localização indisponível no momento');
    const { latitude, longitude, sessionId } = req.body;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new HttpError(400, 'Localização inválida');
    if (typeof sessionId !== 'string') throw new HttpError(400, 'Atualize o aplicativo e inicie uma sessão de compartilhamento');
    const event = await loadEvent(req.params.id);
    if (!locationPolicy.isOpen(event)) throw new HttpError(403, 'O mapa abre 1 hora antes do churrasco');
    if (!d.isActiveMember(event, req.authUid)) throw new HttpError(403, 'Confirme presença antes de compartilhar localização');
    const ref = admin.database().ref(`churrascos/${String(event._id)}/locations/${req.authUid}`);
    const result = await locationTransaction(ref, (current) => {
      if (!current) return undefined;
      return locationPolicy.position(current, sessionId, { uid: req.authUid, displayName: req.profile.displayName, latitude, longitude }) || undefined;
    });
    const location = result.snapshot.val();
    if (!result.committed || location?.sessionId !== sessionId || location?.latitude !== latitude) {
      throw new HttpError(410, 'Compartilhamento encerrado. Toque de novo para iniciar outra sessão');
    }
    return res.json({ success: true, message: 'Localização compartilhada', expiresAt: location.expiresAt });
  }));

  app.delete('/churrascos/:id/location', wrap(async (req, res) => {
    if (!firebaseEnabled) throw new HttpError(503, 'Localização indisponível no momento');
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, 'ID inválido');
    await admin.database().ref(`churrascos/${req.params.id}/locations/${req.authUid}`).remove();
    return res.json({ success: true, message: 'Compartilhamento encerrado' });
  }));

  // --- Erros ------------------------------------------------------------------------

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof HttpError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Corpo da requisição inválido' });
    console.error('Erro inesperado:', error?.message);
    return res.status(500).json({ success: false, message: 'Algo deu errado. Tente de novo em instantes.' });
  });

  return app;
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function firstName(name) { return String(name || '').trim().split(/\s+/)[0]; }

function invitePage({ title, subtitle, appLink, found }) {
  const download = 'https://github.com/arthursucka/Churrasco/releases/latest';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Plus+Jakarta+Sans:wght@400;600&display=swap">
<style>:root{color-scheme:light dark;--surface:#FFF8F3;--ink:#241A16;--card:#FFFFFF;--brasa:#C9471A;--on-brasa:#FFFFFF;--ouro:#DFA632}
@media(prefers-color-scheme:dark){:root{--surface:#181210;--ink:#F4DED5;--card:#241C18;--brasa:#FFB59C;--on-brasa:#5A1600}}
body{margin:0;font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:var(--surface);color:var(--ink);display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
.card{background:var(--card);border-radius:28px;padding:32px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 8px 32px #c9471a1f}
.logo{width:64px;height:79px;display:block;margin:0 auto}.logo .b{fill:var(--brasa)}.logo .o{fill:var(--ouro)}
h1{font-family:'Bricolage Grotesque','Plus Jakarta Sans',system-ui,sans-serif;font-weight:700;font-size:26px;margin:16px 0 8px}p{opacity:.8;margin:0 0 24px;line-height:1.5}
a.btn{display:block;padding:16px;border-radius:999px;text-decoration:none;font-weight:600;margin-top:12px}
.primary{background:var(--brasa);color:var(--on-brasa)}.secondary{border:1px solid var(--brasa);color:var(--brasa)}</style></head>
<body><main class="card"><svg class="logo" viewBox="0 0 1260 1550" role="img" aria-label="Manda Churras"><g transform="translate(-336 -190)">
<path class="b" fill-rule="evenodd" d="M566,591 H1366 A180,180 0 0 1 1546,771 V1268 A180,180 0 0 1 1366,1448 H880 L686,1666 Q640,1716 604,1680 Q593,1668 593,1640 V1448 H566 A180,180 0 0 1 386,1268 V771 A180,180 0 0 1 566,591 Z M884,1296 C800,1265 724,1190 724,1100 C724,960 860,900 905,830 C925,800 930,775 932,760 C934,738 955,733 970,746 C1030,795 1075,860 1072,945 C1070,965 1095,968 1100,950 C1105,925 1105,905 1115,898 C1122,892 1132,898 1136,905 C1180,965 1207,1035 1207,1100 C1207,1190 1140,1265 1050,1300 C1040,1295 1042,1286 1048,1282 C1080,1258 1095,1225 1095,1195 C1095,1100 990,1060 985,1020 C983,1005 975,998 966,998 C950,998 900,1050 870,1095 C840,1140 836,1175 836,1205 C836,1245 855,1268 885,1287 Z"/>
<path class="o" fill-rule="evenodd" d="M966,240 Q996,355 1111,385 Q996,415 966,530 Q936,415 821,385 Q936,355 966,240 Z"/></g></svg>
<h1>${title}</h1><p>${subtitle}</p>
${found ? `<a class="btn primary" href="${appLink}">Abrir no app</a>` : ''}
<a class="btn secondary" href="${download}">Baixar o Manda Churras</a></main></body></html>`;
}
