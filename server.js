require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');

// Inicializa Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Conecta ao MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB Atlas conectado!'))
.catch(err => {
  console.error('Erro ao conectar MongoDB:', err);
  process.exit(1);
});

// Define esquema e modelo Mongoose para "Churrasco"
const churrascoSchema = new mongoose.Schema({
  churrascoDate:   { type: String, required: true },
  hora:            { type: String, required: true },
  local:           { type: String, required: true },
  fornecidos:      { type: [String], default: [] },
  guestsConfirmed: [{ name: String, items: [String] }],
  guestsDeclined:  { type: [String], default: [] },
  createdBy:       { type: String, required: true },
  createdByToken:  { type: String, required: true },
  createdAt:       { type: Date, default: Date.now },
});
const Churrasco = mongoose.model('Churrasco', churrascoSchema);

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));

// Endpoint para criar churrasco
app.post('/churrascos', async (req, res) => {
  try {
    const { churrascoDate, hora, local, fornecidos, userName, token } = req.body;
    if (!churrascoDate || !hora || !local || !Array.isArray(fornecidos) || !userName || !token) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }
    const c = await Churrasco.create({
      churrascoDate,
      hora,
      local,
      fornecidos,
      guestsConfirmed: [],
      guestsDeclined: [],
      createdBy: userName,
      createdByToken: token,
    });
    return res.status(201).json({ success: true, id: c._id });
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
      const [h, mi] = c.hora.split(':').map(Number);
      const dateObj = new Date(y, m - 1, d, h, mi);
      return status === 'active' ? dateObj >= now : dateObj < now;
    });
    return res.json({ success: true, churrascos: filtered });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Detalhes de um churrasco
app.get('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    return res.json({
      success: true,
      churrascoDate: c.churrascoDate,
      hora: c.hora,
      local: c.local,
      createdBy: c.createdBy,
      fornecidosAgregados: c.fornecidos,
      guestsConfirmed: c.guestsConfirmed,
      guestsDeclined: c.guestsDeclined,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Confirmar presença
app.post('/churrascos/:id/confirm-presenca', async (req, res) => {
  try {
    const { name, selectedItems } = req.body;
    const c = await Churrasco.findById(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    if (!name || !Array.isArray(selectedItems)) {
      return res.status(400).json({ success: false, message: 'Dados inválidos' });
    }
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
    const c = await Churrasco.findById(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });
    if (!name) {
      return res.status(400).json({ success: false, message: 'Nome é obrigatório' });
    }
    c.guestsDeclined.push(name);
    await c.save();
    return res.json({ success: true, message: 'Presença recusada' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Cancelar churrasco
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

// Envio de notificação FCM
app.post('/send-notification', async (req, res) => {
  const { to, notification, data } = req.body;

  if (!to || !notification || !notification.title || !notification.body || !data) {
    return res.status(400).json({ success: false, message: "Payload inválido" });
  }

  const message = {
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: {
      id: String(data.id || ''),
      churrascoDate: String(data.churrascoDate || ''),
      hora: String(data.hora || ''),
      local: String(data.local || ''),
      fornecidos: Array.isArray(data.fornecidos) ? data.fornecidos.join(',') : String(data.fornecidos),
    },
    topic: to.replace('/topics/', ''),
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('Mensagem enviada com sucesso:', response);
    return res.json({ success: true, response });
  } catch (error) {
    console.error('Erro ao enviar notificação:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
