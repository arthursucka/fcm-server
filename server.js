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

// Conecta ao MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true
})
  .then(() => console.log('MongoDB Atlas conectado!'))
  .catch(err => {
    console.error('Erro ao conectar MongoDB:', err);
    process.exit(1);
  });

// Esquema de Churrasco, agora com invitedUsers
const churrascoSchema = new mongoose.Schema({
  churrascoDate:    { type: String, required: true },
  hora:             { type: String, required: true },
  local:            { type: String, required: true },
  fornecidos:       { type: [String], default: [] },
  guestsConfirmed:  { type: [{ name: String, items: [String] }], default: [] },
  guestsDeclined:   { type: [String], default: [] },
  invitedUsers:     { type: [String], default: [] },
  createdBy:        { type: String, required: true },
  createdAt:        { type: Date, default: Date.now }
});
const Churrasco = mongoose.model('Churrasco', churrascoSchema);

// Helper para formatar o objeto enviado ao cliente
function mapChurrasco(c) {
  return {
    id:                  String(c._id),
    churrascoDate:       c.churrascoDate,
    hora:                c.hora,
    local:               c.local,
    createdBy:           c.createdBy,
    fornecidosAgregados: c.fornecidos,
    guestsConfirmed:     c.guestsConfirmed,
    guestsDeclined:      c.guestsDeclined
  };
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── ROTAS ────────────────────────────────────────────────────────

// 1) Criar churrasco + notificar tópico
app.post('/churrascos', async (req, res) => {
  try {
    const { churrascoDate, hora, local, fornecidos, userName, invitedUsers } = req.body;
    if (!churrascoDate || !hora || !local || !userName
        || !Array.isArray(fornecidos) || !Array.isArray(invitedUsers)) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }

    const c = await Churrasco.create({
      churrascoDate, hora, local, fornecidos,
      guestsConfirmed: [], guestsDeclined: [],
      invitedUsers, createdBy: userName
    });

    // Envia notificação FCM ao tópico deste churrasco
    const topicName = `churrasco_${c._id}`;
    const message = {
      notification: {
        title: 'Você foi convidado para um churrasco!',
        body:  `Novo churrasco em ${churrascoDate} às ${hora} no ${local}`
      },
      data: {
        id:            String(c._id),
        churrascoDate, // opcional, o app já pode buscar
        hora,
        local
      },
      topic: topicName
    };
    await admin.messaging().send(message);

    return res.status(201).json({ success: true, id: String(c._id) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 2) Listar churrascos ativos/passados
app.get('/churrascos', async (req, res) => {
  try {
    const status = req.query.status;
    const now    = new Date();
    const all    = await Churrasco.find().lean();
    const filtered = all.filter(c => {
      const [d, m, y] = c.churrascoDate.split('/').map(Number);
      const [h, mi]   = c.hora.split(':').map(Number);
      const dt        = new Date(y, m - 1, d, h, mi);
      return status === 'active' ? dt >= now : dt < now;
    });
    return res.json({ success: true, churrascos: filtered.map(mapChurrasco) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 3) Detalhes de um churrasco
app.get('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findById(req.params.id).lean();
    if (!c) {
      return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    }
    return res.json({ success: true, churrasco: mapChurrasco(c) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 4) Confirmar presença
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

    // (Opcional) unsubscribe do tópico via Admin SDK, se você mantiver tokens no servidor
    // const topicName = `churrasco_${req.params.id}`;
    // await admin.messaging().unsubscribeFromTopic([token], topicName);

    return res.json({ success: true, message: 'Presença confirmada' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 5) Recusar presença
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

    // (Opcional) unsubscribe do tópico...
    return res.json({ success: true, message: 'Presença recusada' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 6) Cancelar churrasco
app.delete('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findByIdAndDelete(req.params.id);
    if (!c) {
      return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    }
    return res.json({ success: true, message: 'Churrasco cancelado' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 7) Convites pendentes de um usuário
app.get('/users/:userName/invites', async (req, res) => {
  try {
    const u = req.params.userName;
    const all = await Churrasco.find({ invitedUsers: u }).lean();
    const pendentes = all.filter(c =>
      !c.guestsConfirmed.some(g => g.name === u) &&
      !c.guestsDeclined.includes(u)
    );
    return res.json({ success: true, invites: pendentes.map(mapChurrasco) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 8) Endpoint genérico de notificação (para chamadas do RetrofitClient.sendNotification)
app.post('/send-notification', async (req, res) => {
  try {
    const { to, notification, data } = req.body;
    if (!to || !notification?.title || !notification?.body) {
      return res.status(400).json({ success: false, message: 'Payload inválido' });
    }

    // remove prefix "/topics/" se existir
    const topic = to.startsWith('/topics/') ? to.slice(8) : to;

    // garante que todos os valores de data sejam strings
    const dataStrings = {};
    Object.entries(data || {}).forEach(([k, v]) => {
      dataStrings[k] = String(v);
    });

    const message = {
      notification: {
        title: notification.title,
        body:  notification.body
      },
      data: dataStrings,
      topic
    };

    const fcmResponse = await admin.messaging().send(message);
    return res.json({ success: true, response: fcmResponse });
  } catch (e) {
    console.error('Erro em /send-notification:', e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
