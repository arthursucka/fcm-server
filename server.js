// server.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('./firebase-services');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://churrasco-aa495-default-rtdb.firebaseio.com';

if (!MONGO_URI) {
  console.error('Erro: variavel MONGO_URI nao configurada.');
  process.exit(1);
}

// Explicit local rehearsal only. Never enable unsigned emulator tokens in production.
const localTest = process.env.CHURRASCO_LOCAL_TEST === '1';
if (localTest) {
  const loopback = /^127\.0\.0\.1:[0-9]+$/;
  if (!/^demo-[a-z0-9-]+$/.test(process.env.GCLOUD_PROJECT || '') ||
      !loopback.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || '') ||
      !loopback.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '') ||
      !/^mongodb:\/\/127\.0\.0\.1:[0-9]+\/churrasco_test[a-z0-9_]*(?:\?.*)?$/.test(MONGO_URI) ||
      FIREBASE_DATABASE_URL !== `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/?ns=${process.env.GCLOUD_PROJECT}`) {
    throw new Error('Local test requires demo project and isolated loopback targets');
  }
} else if (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  throw new Error('Emulator hosts require explicit isolated local test mode');
}

// Firebase Admin Init
let firebaseEnabled = false;

try {
  if (localTest) {
    admin.initializeApp({projectId: process.env.GCLOUD_PROJECT, databaseURL: FIREBASE_DATABASE_URL});
    firebaseEnabled = true;
    console.log('Firebase local demo initialized; notifications disabled');
  } else {
  const serviceAccountJson = resolveServiceAccountJson();

  if (!serviceAccountJson) {
    console.warn('Aviso: credencial Firebase nao configurada. Notificacoes e chat desativados.');
  } else {
    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL,
    });

    firebaseEnabled = true;
    console.log('Firebase Admin inicializado!');
  }
  }
} catch (error) {
  console.error('Erro ao inicializar Firebase Admin:', error);
  firebaseEnabled = false;
}

function resolveServiceAccountJson() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      'base64'
    ).toString('utf8');
  }

  if (process.env.SERVICE_ACCOUNT_KEY) {
    const value = process.env.SERVICE_ACCOUNT_KEY.trim();
    if (value.startsWith('{')) return value;

    return Buffer.from(value, 'base64').toString('utf8');
  }

  if (process.env.SERVICE_ACCOUNT_KEY_PATH && fs.existsSync(process.env.SERVICE_ACCOUNT_KEY_PATH)) {
    return fs.readFileSync(process.env.SERVICE_ACCOUNT_KEY_PATH, 'utf8');
  }

  return null;
}

// MongoDB Connect
mongoose
  .connect(MONGO_URI)
  .then(() => console.log('MongoDB conectado!'))
  .catch((err) => {
    console.error('Erro ao conectar ao MongoDB:', err);
    process.exit(1);
  });

// Schemas e Models
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, trim: true },
  displayName: { type: String, required: true, trim: true },
  fcmTokens: { type: [String], default: [] },
  firebaseUid: { type: String, unique: true, sparse: true },
  legacyLinkStatus: { type: String, enum: ['pending_access', 'ready'] },
});

const User = mongoose.model('User', userSchema);

const churrascoSchema = new mongoose.Schema({
  churrascoDate: { type: String, required: true },
  hora: { type: String, required: true },
  local: { type: String, required: true },
  fornecidos: { type: [String], default: [] },
  guestsConfirmed: [{ name: String, items: [String] }],
  guestsDeclined: { type: [String], default: [] },
  invitedUsers: { type: [String], default: [] },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const Churrasco = mongoose.model('Churrasco', churrascoSchema);

function mapChurrasco(c) {
  return {
    id: String(c._id),
    churrascoDate: c.churrascoDate,
    hora: c.hora,
    local: c.local,
    createdBy: c.createdBy,
    invitedUsers: c.invitedUsers || [],
    fornecidosAgregados: c.fornecidos || [],
    guestsConfirmed: c.guestsConfirmed || [],
    guestsDeclined: c.guestsDeclined || [],
  };
}

function participantCanShareLocation(churrasco, username) {
  if (churrasco.createdBy === username) return true;

  return (churrasco.guestsConfirmed || []).some(
    (guest) => guest.name === username
  );
}

function locationSharingWindowIsOpen(churrasco) {
  const eventTime = parseEventDateTime(churrasco.churrascoDate, churrasco.hora);
  if (!eventTime) return true;

  const now = Date.now();
  const opensAt = eventTime.getTime() - 60 * 60 * 1000;
  const closesAt = eventTime.getTime() + 4 * 60 * 60 * 1000;

  return now >= opensAt && now <= closesAt;
}

function parseEventDateTime(date, time) {
  const [day, month, year] = String(date).split('/').map(Number);
  const [hour, minute] = String(time).split(':').map(Number);

  if (![day, month, year, hour, minute].every(Number.isFinite)) {
    return null;
  }

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function safeFirebaseKey(value) {
  return String(value).replace(/[.#$/\[\]]/g, '_');
}

// A name/header/FCM token is not proof of identity. Legacy profiles require
// an explicit, reviewed UID binding; registration must never claim them.
async function authenticateFirebase(req, res, next) {
  const authorization = req.header('Authorization') || '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return res.status(401).json({ success: false, message: 'Entre na sua conta para continuar' });
  if (!firebaseEnabled) return res.status(503).json({ success: false, message: 'Autenticacao indisponivel' });
  try {
    const token = await admin.auth().verifyIdToken(match[1], true);
    if (typeof token.uid !== 'string' || !token.uid || token.uid.length > 128 || /[.#$\[\]/\u0000-\u001f\u007f]/.test(token.uid)) throw new Error('Invalid UID');
    req.authUid = token.uid;
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Sessao invalida ou expirada' });
  }
  return next();
}

async function authMiddleware(req, res, next) {
  return authenticateFirebase(req, res, async () => {
    try {
      const user = await User.findOne({ firebaseUid: req.authUid });
      if (!user) return res.status(403).json({ success: false, message: 'Complete seu cadastro ou solicite a migracao da conta antiga' });
      if (user.legacyLinkStatus === 'pending_access') return res.status(403).json({ success: false, message: 'Sua vinculacao esta sendo concluida. Aguarde e consulte a solicitacao.' });
      req.user = user.username;
      req.displayName = user.displayName;
      req.profile = user;
      return next();
    } catch (_) {
      return res.status(503).json({ success: false, message: 'Nao foi possivel validar seu cadastro' });
    }
  });
}

function canReadEvent(churrasco, username) {
  return churrasco.createdBy === username ||
    (churrasco.invitedUsers || []).includes(username) ||
    (churrasco.guestsConfirmed || []).some(guest => guest.name === username);
}

function canRespondToInvite(churrasco, username) {
  return churrasco.createdBy === username || (churrasco.invitedUsers || []).includes(username);
}

async function updateReadAccess(churrasco, req) {
  const ref = admin.database().ref(`eventAccess/${String(churrasco._id)}/${req.authUid}`);
  if (participantCanShareLocation(churrasco, req.user)) await ref.set(true);
  else await ref.remove();
}

async function revokeReadAccess(id, uid) {
  await admin.database().ref(`eventAccess/${id}/${uid}`).remove();
  await admin.database().ref(`churrascos/${id}/locations/${uid}`).remove();
}

function publicProfile(user) {
  return { username: user.username, displayName: user.displayName };
}

async function sendInviteNotifications(churrasco, tokens) {
  if (localTest) return;
  if (!firebaseEnabled) {
    console.warn('Firebase desativado. Convites criados sem notificacao.');
    return;
  }

  if (!tokens.length) {
    return;
  }

  const results = await Promise.allSettled(
    tokens.map((token) =>
      admin.messaging().send({
        token,
        data: {
          type: 'invite',
          churrascoId: String(churrasco._id),
          title: 'Voce foi convidado para um churrasco!',
          body: `Em ${churrasco.churrascoDate} as ${churrasco.hora} no ${churrasco.local}`,
        },
        android: {
          priority: 'high',
        },
      })
    )
  );

  const failedTokens = [];

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const token = tokens[index];
      const code = result.reason?.errorInfo?.code || result.reason?.code;

      console.error('Erro ao enviar FCM:', {
        code,
        message: result.reason?.message,
      });

      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument'
      ) {
        failedTokens.push(token);
      }
    }
  });

  if (failedTokens.length) {
    await User.updateMany(
      { fcmTokens: { $in: failedTokens } },
      { $pull: { fcmTokens: { $in: failedTokens } } }
    );

    console.log(`Tokens invalidos removidos: ${failedTokens.length}`);
  }
}

async function sendChatNotifications(churrasco, sender, text) {
  if (localTest) return;
  if (!firebaseEnabled) {
    console.warn('Firebase desativado. Mensagem salva sem notificacao.');
    return;
  }

  const confirmedUsers = (churrasco.guestsConfirmed || [])
    .map((guest) => guest.name)
    .filter(Boolean);

  const participants = Array.from(
    new Set([
      churrasco.createdBy,
      ...confirmedUsers,
    ].filter(Boolean))
  );

  const recipients = participants.filter((username) => username !== sender);

  if (!recipients.length) {
    return;
  }

  const users = await User.find({
    username: { $in: recipients },
  }).lean();

  const tokens = Array.from(
    new Set(users.flatMap((user) => user.fcmTokens || []))
  );

  if (!tokens.length) {
    return;
  }

  const body = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  const results = await Promise.allSettled(
    tokens.map((token) =>
      admin.messaging().send({
        token,
        data: {
          type: 'chat_message',
          churrascoId: String(churrasco._id),
          title: `Nova mensagem de ${sender}`,
          body,
        },
        android: {
          priority: 'high',
        },
      })
    )
  );

  const failedTokens = [];

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const token = tokens[index];
      const code = result.reason?.errorInfo?.code || result.reason?.code;

      console.error('Erro ao enviar FCM de chat:', {
        code,
        message: result.reason?.message,
      });

      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument'
      ) {
        failedTokens.push(token);
      }
    }
  });

  if (failedTokens.length) {
    await User.updateMany(
      { fcmTokens: { $in: failedTokens } },
      { $pull: { fcmTokens: { $in: failedTokens } } }
    );

    console.log(`Tokens invalidos de chat removidos: ${failedTokens.length}`);
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Backend do Churrasco online',
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    firebase: firebaseEnabled ? 'enabled' : 'disabled',
  });
});

// Rotas de usuario
const legacyOnboarding = require('./legacy-onboarding')({app, mongoose, User, Churrasco, admin, authenticateFirebase, env: process.env});
app.post('/users/register', authenticateFirebase, async (req, res) => {
  try {
    await legacyOnboarding.ready();
    const identity = await admin.auth().getUser(req.authUid);
    if (!identity.emailVerified || !identity.email || identity.disabled) return res.status(403).json({success:false,message:'Confirme seu e-mail antes de concluir o cadastro'});
    const { username, displayName } = req.body;
    if (typeof username !== 'string' || typeof displayName !== 'string' ||
        !username.trim() || !displayName.trim() || username.trim().length > 60 || displayName.trim().length > 60) {
      return res.status(400).json({ success: false, message: 'Informe um nome de ate 60 caracteres' });
    }
    const current = await User.findOne({ firebaseUid: req.authUid });
    if (current) return res.json({ success: true, payload: publicProfile(current) });
    if (await legacyOnboarding.hasActiveRequest(req.authUid)) return res.status(409).json({success:false,message:'Voce ja solicitou a recuperacao de uma conta antiga. Aguarde a revisao antes de criar outro perfil'});
    const existing = await User.findOne({ username: username.trim() });
    if (existing) return res.status(409).json({ success: false, message: 'Nome ja reservado. Contas antigas precisam de migracao assistida; escolha outro nome para uma conta nova.' });
    const user = await User.create({ username: username.trim(), displayName: displayName.trim(), firebaseUid: req.authUid });
    return res.status(201).json({ success: true, payload: publicProfile(user) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Cadastro ja existente; entre novamente' });
    return res.status(500).json({ success: false, message: 'Nao foi possivel concluir o cadastro' });
  }
});

app.post('/users/login', authMiddleware, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (fcmToken != null && (typeof fcmToken !== 'string' || !fcmToken.trim() || fcmToken.length > 4096)) {
      return res.status(400).json({ success: false, message: 'Token de notificacao invalido' });
    }
    if (fcmToken) {
      // Moving an installation to a different account cannot retain its old push recipients.
      await User.updateMany({ firebaseUid: { $ne: req.authUid }, fcmTokens: fcmToken }, { $pull: { fcmTokens: fcmToken } });
      await User.updateOne({ firebaseUid: req.authUid }, { $addToSet: { fcmTokens: fcmToken } });
    }
    return res.json({ success: true, payload: publicProfile(req.profile) });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Nao foi possivel abrir a sessao' });
  }
});

app.post('/users/logout', authMiddleware, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (typeof fcmToken === 'string' && fcmToken.length <= 4096) {
      await User.updateOne({ firebaseUid: req.authUid }, { $pull: { fcmTokens: fcmToken } });
    }
    return res.json({ success: true });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Nao foi possivel desvincular as notificacoes' });
  }
});

app.get('/users/:username', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    return res.json({ success: true, exists: !!user });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Nao foi possivel consultar o cadastro' });
  }
});

app.get('/users', authMiddleware, async (req, res) => {
  try {
    const users = await User.find()
      .select('username displayName -_id')
      .sort({ displayName: 1 })
      .lean();

    return res.json({
      success: true,
      payload: users,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get('/users/:username/invites', authMiddleware, async (req, res) => {
  try {
    const username = req.params.username;

    if (username !== req.user) {
      return res.status(403).json({
        success: false,
        message: 'Acesso negado',
      });
    }

    const churrascos = await Churrasco.find({ invitedUsers: username }).lean();

    const pendentes = churrascos.filter(
      (c) =>
        !c.guestsConfirmed.some((guest) => guest.name === username) &&
        !c.guestsDeclined.includes(username)
    );

    return res.json({
      success: true,
      invites: pendentes.map(mapChurrasco),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Rotas de churrasco
app.use('/churrascos', authMiddleware, (req, res, next) => {
  if (process.env.CHURRASCO_LEGACY_MIGRATION_WINDOW === '1' && req.method !== 'GET') return res.status(503).json({success:false,message:'Estamos recuperando as contas antigas. Alteracoes em churrascos ficam pausadas durante esta etapa.'});
  return next();
});

app.post('/churrascos', async (req, res) => {
  try {
    const { churrascoDate, hora, local, fornecidos, invitedUsers } = req.body;

    if (
      !churrascoDate ||
      !hora ||
      !local ||
      !Array.isArray(fornecidos) ||
      !Array.isArray(invitedUsers)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Dados incompletos',
      });
    }

    const churrasco = await Churrasco.create({
      churrascoDate,
      hora,
      local,
      fornecidos,
      guestsConfirmed: [],
      guestsDeclined: [],
      invitedUsers,
      createdBy: req.user,
    });

    await updateReadAccess(churrasco, req);

    const users = await User.find({
      username: { $in: invitedUsers },
    }).lean();

    const tokens = users.flatMap((user) => user.fcmTokens || []);

    sendInviteNotifications(churrasco, tokens).catch((error) => {
      console.error('Erro inesperado ao enviar notificacoes:', error);
    });

    return res.status(201).json({
      success: true,
      id: String(churrasco._id),
    });
  } catch (error) {
    console.error('ERRO AO CRIAR CHURRASCO:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Erro desconhecido',
    });
  }
});

app.get('/churrascos', async (req, res) => {
  try {
    const status = req.query.status;
    const now = new Date();

    const churrascos = await Churrasco.find({ $or: [
      { createdBy: req.user }, { invitedUsers: req.user }, { 'guestsConfirmed.name': req.user },
    ] }).lean();

    const filtered = churrascos.filter((c) => {
      const [day, month, year] = c.churrascoDate.split('/').map(Number);
      const [hour, minute] = c.hora.split(':').map(Number);
      const eventDate = new Date(year, month - 1, day, hour, minute);

      if (status === 'active') return eventDate >= now;
      if (status === 'past') return eventDate < now;

      return true;
    });

    return res.json({
      success: true,
      churrascos: filtered.map(mapChurrasco),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get('/churrascos/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'ID invalido',
      });
    }

    const churrasco = await Churrasco.findById(req.params.id).lean();

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
    }

    if (!canReadEvent(churrasco, req.user)) {
      return res.status(403).json({ success: false, message: 'Voce nao participa deste evento' });
    }
    // Reads must not recreate revoked Firebase access from a stale Mongo snapshot.

    return res.json({
      success: true,
      churrasco: mapChurrasco(churrasco),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post('/churrascos/:id/messages', async (req, res) => {
  try {
    const { text } = req.body;
    const sender = req.user;

    if (!firebaseEnabled) {
      return res.status(503).json({
        success: false,
        message: 'Chat indisponivel no momento',
      });
    }

    if (typeof text !== 'string' || !text.trim() || text.trim().length > 500) {
      return res.status(400).json({
        success: false,
        message: 'Mensagem vazia',
      });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'ID invalido',
      });
    }

    const churrasco = await Churrasco.findById(req.params.id);

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
    }

    const confirmedUsers = (churrasco.guestsConfirmed || [])
      .map((guest) => guest.name)
      .filter(Boolean);

    const participants = Array.from(
      new Set([
        churrasco.createdBy,
        ...confirmedUsers,
      ].filter(Boolean))
    );

    if (!participants.includes(sender)) {
      return res.status(403).json({
        success: false,
        message: 'Confirme presenca antes de participar da conversa',
      });
    }

    const message = {
      sender,
      text: text.trim(),
      timestamp: Date.now(),
    };

    await admin
      .database()
      .ref(`churrascos/${String(churrasco._id)}/messages`)
      .push(message);

    sendChatNotifications(churrasco, sender, message.text).catch((error) => {
      console.error('Erro inesperado ao enviar notificacoes de chat:', error);
    });

    return res.json({
      success: true,
      message: 'Mensagem enviada',
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem de chat:', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post('/churrascos/:id/location', async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const sender = req.user;

    if (!firebaseEnabled) {
      return res.status(503).json({
        success: false,
        message: 'Localização indisponível no momento',
      });
    }

    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: 'Localização inválida',
      });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'ID invalido',
      });
    }

    const churrasco = await Churrasco.findById(req.params.id);

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
    }

    if (!locationSharingWindowIsOpen(churrasco)) {
      return res.status(403).json({
        success: false,
        message: 'O mapa libera 1 hora antes do churrasco',
      });
    }

    if (!participantCanShareLocation(churrasco, sender)) {
      return res.status(403).json({
        success: false,
        message: 'Confirme presença antes de compartilhar localização',
      });
    }

    const now = Date.now();
    const location = {
      username: sender,
      displayName: req.displayName || sender,
      latitude,
      longitude,
      updatedAt: now,
      expiresAt: now + 2 * 60 * 60 * 1000,
    };

    await admin
      .database()
      .ref(`churrascos/${String(churrasco._id)}/locations/${req.authUid}`)
      .set(location);

    return res.json({
      success: true,
      message: 'Localização compartilhada',
    });
  } catch (error) {
    console.error('Erro ao compartilhar localização:', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.delete('/churrascos/:id/location', async (req, res) => {
  try {
    if (!firebaseEnabled) {
      return res.status(503).json({
        success: false,
        message: 'Localização indisponível no momento',
      });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'ID invalido',
      });
    }

    await admin
      .database()
      .ref(`churrascos/${req.params.id}/locations/${req.authUid}`)
      .remove();

    return res.json({
      success: true,
      message: 'Compartilhamento encerrado',
    });
  } catch (error) {
    console.error('Erro ao encerrar localização:', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post('/churrascos/:id/confirm-presenca', async (req, res) => {
  try {
    const { selectedItems } = req.body;
    const name = req.user;

    if (!name || !Array.isArray(selectedItems)) {
      return res.status(400).json({
        success: false,
        message: 'Payload invalido',
      });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'ID invalido',
      });
    }

    if (req.body.name != null && req.body.name !== req.user) {
      return res.status(403).json({ success: false, message: 'Voce so pode responder por sua conta' });
    }

    const churrasco = await Churrasco.findById(req.params.id);

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
    }

    if (!canRespondToInvite(churrasco, req.user)) {
      return res.status(403).json({ success: false, message: 'Voce nao foi convidado para este evento' });
    }

    const previousGuest = churrasco.guestsConfirmed.find(
      (guest) => guest.name === name
    );
    const previousItems = previousGuest?.items || [];
    const currentItemsFromOtherGuests = churrasco.guestsConfirmed
      .filter((guest) => guest.name !== name)
      .flatMap((guest) => guest.items || []);
    const reservedItems = new Set([
      ...churrasco.fornecidos.filter((item) => !previousItems.includes(item)),
      ...currentItemsFromOtherGuests,
    ]);
    const duplicatedItems = selectedItems.filter((item) => reservedItems.has(item));

    if (duplicatedItems.length) {
      return res.status(409).json({
        success: false,
        message: `Item ja assumido: ${duplicatedItems.join(', ')}`,
      });
    }

    churrasco.guestsConfirmed = churrasco.guestsConfirmed.filter(
      (guest) => guest.name !== name
    );

    churrasco.guestsDeclined = churrasco.guestsDeclined.filter(
      (guestName) => guestName !== name
    );

    churrasco.guestsConfirmed.push({
      name,
      items: selectedItems,
    });

    const mergedItems = new Set([
      ...churrasco.fornecidos,
      ...selectedItems,
    ]);

    churrasco.fornecidos = Array.from(mergedItems);

    await churrasco.save();
    await updateReadAccess(churrasco, req);

    return res.json({
      success: true,
      message: 'Presenca confirmada',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post('/churrascos/:id/decline-presenca', async (req, res) => {
  try {
    const name = req.user;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Payload invalido',
      });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'ID invalido',
      });
    }

    if (req.body.name != null && req.body.name !== req.user) {
      return res.status(403).json({ success: false, message: 'Voce so pode responder por sua conta' });
    }

    const churrasco = await Churrasco.findById(req.params.id);

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
    }

    if (!canRespondToInvite(churrasco, req.user)) {
      return res.status(403).json({ success: false, message: 'Voce nao foi convidado para este evento' });
    }

    // Revoke first. If Mongo saving fails, access stays denied until a valid refresh.
    if (churrasco.createdBy !== req.user) await revokeReadAccess(String(churrasco._id), req.authUid);

    churrasco.guestsConfirmed = churrasco.guestsConfirmed.filter(
      (guest) => guest.name !== name
    );

    if (!churrasco.guestsDeclined.includes(name)) {
      churrasco.guestsDeclined.push(name);
    }

    await churrasco.save();

    return res.json({
      success: true,
      message: 'Presenca recusada',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.delete('/churrascos/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'ID invalido',
      });
    }

    const churrasco = await Churrasco.findById(req.params.id);

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
    }

    if (churrasco.createdBy !== req.user) {
      return res.status(403).json({
        success: false,
        message: 'Apenas o criador pode cancelar este churrasco',
      });
    }

    // Revoke Firebase reads before removing the Mongo event.
    await admin.database().ref(`eventAccess/${req.params.id}`).remove();
    await admin.database().ref(`churrascos/${req.params.id}`).remove();
    await Churrasco.findByIdAndDelete(req.params.id);

    return res.json({
      success: true,
      message: 'Churrasco cancelado',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.listen(PORT, localTest ? '127.0.0.1' : undefined, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
