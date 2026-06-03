// server.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
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

// Firebase Admin Init
let firebaseEnabled = false;

try {
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

async function authMiddleware(req, res, next) {
  try {
    const username = req.header('X-User');

    if (!username) {
      return res.status(401).json({
        success: false,
        message: 'Nao autorizado',
      });
    }

    const user = await User.findOne({ username });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario invalido',
      });
    }

    req.user = user.username;
    req.displayName = user.displayName;
    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

async function sendInviteNotifications(churrasco, tokens) {
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
        token,
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
        token,
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
app.post('/users/register', async (req, res) => {
  try {
    const { username, displayName } = req.body;

    if (!username || !displayName) {
      return res.status(400).json({
        success: false,
        message: 'Dados incompletos',
      });
    }

    await User.create({
      username: username.trim(),
      displayName: displayName.trim(),
    });

    return res.json({ success: true });
  } catch (error) {
    if (error.code === 11000) {
      return res.json({ success: true });
    }

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post('/users/login', async (req, res) => {
  try {
    const { username, fcmToken } = req.body;

    if (!username || !fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'Dados incompletos',
      });
    }

    const user = await User.findOne({ username: username.trim() });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario nao encontrado',
      });
    }

    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
      await user.save();
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get('/users/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });

    return res.json({
      success: true,
      exists: !!user,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
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
app.use('/churrascos', authMiddleware);

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

    const churrascos = await Churrasco.find().lean();

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

    if (!text || !text.trim()) {
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
      .ref(`churrascos/${String(churrasco._id)}/locations/${safeFirebaseKey(sender)}`)
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
      .ref(`churrascos/${req.params.id}/locations/${safeFirebaseKey(req.user)}`)
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
    const { name, selectedItems } = req.body;

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

    const churrasco = await Churrasco.findById(req.params.id);

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
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
    const { name } = req.body;

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

    const churrasco = await Churrasco.findById(req.params.id);

    if (!churrasco) {
      return res.status(404).json({
        success: false,
        message: 'Churrasco nao encontrado',
      });
    }

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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
