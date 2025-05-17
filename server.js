require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors    = require('cors');
const admin   = require('firebase-admin');

// Inicializa Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Conecta ao MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('MongoDB Atlas conectado!'))
  .catch(err => {
    console.error('Erro ao conectar MongoDB:', err);
    process.exit(1);
  });

// Define esquema e modelo de Churrasco
const churrascoSchema = new mongoose.Schema({
  churrascoDate: { type: String, required: true },
  hora:          { type: String, required: true },
  local:         { type: String, required: true },
  fornecidos:    { type: [String], default: [] },
  guestsConfirmed: {
    type: [{ name: String, items: [String] }],
    default: []
  },
  guestsDeclined: { type: [String], default: [] },
  createdBy:      { type: String, required: true },
  createdAt:      { type: Date, default: Date.now }
});

const Churrasco = mongoose.model('Churrasco', churrascoSchema);

const app = express();

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json());

// Logger (antes das rotas) :contentReference[oaicite:8]{index=8}:contentReference[oaicite:9]{index=9}
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  console.log('📦 Payload:', req.body);
  next();
});

// Helper para normalizar o documento Mongo em JSON consumível pelo cliente
const mapChurrasco = c => ({
  id: String(c._id),
  churrascoDate: c.churrascoDate,
  hora:          c.hora,
  local:         c.local,
  createdBy:     c.createdBy,
  fornecidosAgregados: c.fornecidos,
  guestsConfirmed:     c.guestsConfirmed,
  guestsDeclined:      c.guestsDeclined
});

// Criar churrasco
app.post('/churrascos', async (req, res) => {
  try {
    const { churrascoDate, hora, local, fornecidos, userName } = req.body;
    if (!churrascoDate || !hora || !local || !userName || !Array.isArray(fornecidos)) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }
    const churrasco = await Churrasco.create({
      churrascoDate, hora, local, fornecidos, createdBy: userName
    });
    return res.status(201).json({ success: true, id: String(churrasco._id) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Listar churrascos ativos ou passados
app.get('/churrascos', async (req, res) => {
  try {
    const status = req.query.status;
    const now = new Date();
    const all = await Churrasco.find().lean();
    const filtered = all.filter(c => {
      const [d, m, y] = c.churrascoDate.split('/').map(Number);
      const [h, mi]    = c.hora.split(':').map(Number);
      const dateObj = new Date(y, m - 1, d, h, mi);
      return status === 'active' ? dateObj >= now : dateObj < now;
    });
    const result = filtered.map(mapChurrasco);
    return res.json({ success: true, churrascos: result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Detalhes de um churrasco com wrapper "churrasco" :contentReference[oaicite:10]{index=10}:contentReference[oaicite:11]{index=11}
app.get('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    return res.json({ success: true, churrasco: mapChurrasco(c) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Confirmar presença (spread para fornecidos) :contentReference[oaicite:12]{index=12}:contentReference[oaicite:13]{index=13}
app.post('/churrascos/:id/confirm-presenca', async (req, res) => {
  try {
    const { name, selectedItems } = req.body;
    if (!name || !Array.isArray(selectedItems)) {
      return res.status(400).json({ success: false, message: 'Payload inválido' });
    }
    const c = await Churrasco.findById(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    c.guestsConfirmed.push({ name, items: selectedItems });
    c.fornecidos.push(...selectedItems);
    await c.save();
    return res.json({ success: true, message: 'Presença confirmada' });
  } catch (e) {
    console.error(e);
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
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    c.guestsDeclined.push(name);
    await c.save();
    return res.json({ success: true, message: 'Presença recusada' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Cancelar churrasco (DELETE) — rota adicionada para o cliente :contentReference[oaicite:14]{index=14}:contentReference[oaicite:15]{index=15}
app.delete('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    return res.json({ success: true, message: 'Churrasco cancelado' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Envio de notificação via FCM
app.post('/send-notification', async (req, res) => {
  const { to, notification, data } = req.body;
  if (!to || !notification?.title || !notification?.body || !data) {
    return res.status(400).json({ success: false, message: 'Payload inválido' });
  }
  const message = {
    notification: { title: notification.title, body: notification.body },
    data: {
      id:          String(data.id || ''),
      churrascoDate: String(data.churrascoDate || ''),
      hora:        String(data.hora || ''),
      local:       String(data.local || ''),
      fornecidos:  String(data.fornecidos || '')
    },
    topic: to.replace('/topics/', '')
  };
  try {
    const response = await admin.messaging().send(message);
    console.log('Notificação enviada:', response);
    return res.json({ success: true, response });
  } catch (error) {
    console.error('Erro ao enviar notificação:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
