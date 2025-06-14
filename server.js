require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const admin    = require('firebase-admin');

// Inicializa Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Conecta ao MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB conectado!'))
  .catch(err => {
    console.error('Erro ao conectar ao MongoDB:', err);
    process.exit(1);
  });

// ── MODELS ───────────────────────────────────────────────────────────────

// Usuário
const userSchema = new mongoose.Schema({
  username:    { type: String, unique: true, required: true },
  displayName: { type: String, required: true },
  fcmTokens:   { type: [String], default: [] }
});
const User = mongoose.model('User', userSchema);

// Churrasco
const churrascoSchema = new mongoose.Schema({
  churrascoDate:   { type: String, required: true },
  hora:            { type: String, required: true },
  local:           { type: String, required: true },
  fornecidos:      { type: [String], default: [] },
  guestsConfirmed: [{ name: String, items: [String] }],
  guestsDeclined:  { type: [String], default: [] },
  invitedUsers:    { type: [String], default: [] },
  createdBy:       { type: String, required: true },
  createdAt:       { type: Date, default: Date.now },
});
const Churrasco = mongoose.model('Churrasco', churrascoSchema);

// Helper para normalizar objetos para o front
function mapChurrasco(c) {
  return {
    id:                   String(c._id),
    churrascoDate:        c.churrascoDate,
    hora:                 c.hora,
    local:                c.local,
    createdBy:            c.createdBy,
    invitedUsers:         c.invitedUsers,
    fornecidosAgregados:  c.fornecidos,
    guestsConfirmed:      c.guestsConfirmed,
    guestsDeclined:       c.guestsDeclined,
  };
}

const app = express();
app.use(cors());
app.use(express.json());

// ── ROTAS DE USUÁRIO ────────────────────────────────────────────────────

// Registro de usuário
app.post('/users/register', async (req, res) => {
  try {
    const { username, displayName } = req.body;
    if (!username || !displayName) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }
    await User.create({ username, displayName });
    return res.json({ success: true });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ success: false, message: 'Username já existe' });
    }
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Login de usuário (registra token FCM)
app.post('/users/login', async (req, res) => {
  try {
    const { username, fcmToken } = req.body;
    if (!username || !fcmToken) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }
    const u = await User.findOne({ username });
    if (!u) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
    }
    if (!u.fcmTokens.includes(fcmToken)) {
      u.fcmTokens.push(fcmToken);
      await u.save();
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Middleware de autenticação (via header X-User)
async function authMiddleware(req, res, next) {
  const user = req.header('X-User');
  if (!user) {
    return res.status(401).json({ success: false, message: 'Não autorizado' });
  }
  const u = await User.findOne({ username: user });
  if (!u) {
    return res.status(401).json({ success: false, message: 'Usuário inválido' });
  }
  req.user = u.username;
  next();
}

// ── ROTAS DE CHURRASCO (protegidas) ─────────────────────────────────────
app.use('/churrascos', authMiddleware);

// Criar churrasco e notificar convidados
app.post('/churrascos', async (req, res) => {
  try {
    const { churrascoDate, hora, local, fornecidos, invitedUsers } = req.body;
    if (
      !churrascoDate || !hora || !local ||
      !Array.isArray(fornecidos) ||
      !Array.isArray(invitedUsers)
    ) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }
    const createdBy = req.user;
    const c = await Churrasco.create({
      churrascoDate, hora, local, fornecidos,
      guestsConfirmed: [], guestsDeclined: [],
      invitedUsers, createdBy
    });

    // Busca tokens dos convidados
    const users = await User.find({ username: { $in: invitedUsers } });
    const tokens = users.flatMap(u => u.fcmTokens);

    if (tokens.length) {
      // Envia notificação a todos os tokens convidados
      await admin.messaging().sendMulticast({
        notification: {
          title: 'Você foi convidado para um churrasco!',
          body: `Em ${churrascoDate} às ${hora} no ${local}`
        },
        data: { churrascoId: String(c._id) },
        tokens
      });
    }

    return res.status(201).json({ success: true, id: String(c._id) });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Listar churrascos (ativos ou passados)
app.get('/churrascos', async (req, res) => {
  try {
    const status = req.query.status;
    const now = new Date();
    const all = await Churrasco.find().lean();
    const filtered = all.filter(c => {
      const [d,m,y] = c.churrascoDate.split('/').map(Number);
      const [h,mi]  = c.hora.split(':').map(Number);
      const dt = new Date(y, m-1, d, h, mi);
      return status === 'active' ? dt >= now : dt < now;
    });
    return res.json({ success: true, churrascos: filtered.map(mapChurrasco) });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Detalhes de um churrasco
app.get('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findById(req.params.id).lean();
    if (!c) {
      return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    }
    return res.json({ success: true, churrasco: mapChurrasco(c) });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Confirmar presença
app.post('/churrascos/:id/confirm-presenca', async (req, res) => {
  try {
    const { name, selectedItems } = req.body;
    if (!name || !Array.isArray(selectedItems)) {
      return res.status(400).json({ success: false, message: 'Payload inválido' });
    }
    const c = await Churrasco.findById(req.params.id);
    if (!c) {
      return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    }
    c.guestsConfirmed.push({ name, items: selectedItems });
    c.fornecidos.push(...selectedItems);
    await c.save();
    return res.json({ success: true, message: 'Presença confirmada' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Recusar presença
app.post('/churrascos/:id/decline-presenca', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Payload inválido' });
    }
    const c = await Churrasco.findById(req.params.id);
    if (!c) {
      return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    }
    c.guestsDeclined.push(name);
    await c.save();
    return res.json({ success: true, message: 'Presença recusada' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Deletar churrasco
app.delete('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findByIdAndDelete(req.params.id);
    if (!c) {
      return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    }
    return res.json({ success: true, message: 'Churrasco cancelado' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Convites pendentes de um usuário
app.get('/users/:username/invites', authMiddleware, async (req, res) => {
  try {
    const u = req.params.username;
    const all = await Churrasco.find({ invitedUsers: u }).lean();
    const pendentes = all.filter(c =>
      !c.guestsConfirmed.some(g => g.name === u) &&
      !c.guestsDeclined.includes(u)
    );
    return res.json({ success: true, invites: pendentes.map(mapChurrasco) });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// (Opcional) Listar todos usuários — útil para seleção de convidados
app.get('/users', authMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('username displayName -_id').lean();
    return res.json({ success: true, users });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
