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

// Esquema de Churrasco, agora com invitedUsers :contentReference[oaicite:0]{index=0}:contentReference[oaicite:1]{index=1}
const churrascoSchema = new mongoose.Schema({
  churrascoDate:    { type: String, required: true },
  hora:             { type: String, required: true },
  local:            { type: String, required: true },
  fornecidos:       { type: [String], default: [] },
  guestsConfirmed:  { type: [{ name: String, items: [String] }], default: [] },
  guestsDeclined:   { type: [String], default: [] },
  invitedUsers:     { type: [String], default: [] },         // NOVO
  createdBy:        { type: String, required: true },
  createdAt:        { type: Date, default: Date.now }
});

const Churrasco = mongoose.model('Churrasco', churrascoSchema);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Helper para normalizar o documento Mongo em JSON para o cliente
const mapChurrasco = c => ({
  id:                   String(c._id),
  churrascoDate:        c.churrascoDate,
  hora:                 c.hora,
  local:                c.local,
  createdBy:            c.createdBy,
  fornecidosAgregados:  c.fornecidos,
  guestsConfirmed:      c.guestsConfirmed,
  guestsDeclined:       c.guestsDeclined
});

// ── ROTAS ─────────────────────────────────────────────────────────

// Cria churrasco e notifica o tópico específico :contentReference[oaicite:2]{index=2}:contentReference[oaicite:3]{index=3}
app.post('/churrascos', async (req, res) => {
  try {
    const { churrascoDate, hora, local, fornecidos, userName, invitedUsers } = req.body;
    if (!churrascoDate || !hora || !local || !userName
        || !Array.isArray(fornecidos) || !Array.isArray(invitedUsers)) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }

    const churrasco = await Churrasco.create({
      churrascoDate, hora, local, fornecidos,
      guestsConfirmed: [], guestsDeclined: [],
      invitedUsers, createdBy: userName
    });

    // Inscrever voluntariamente no tópico criado (opcional)
    // invitedUsers.forEach(u =>
    //   // aqui você poderia manter no servidor tokens e fazer subscribe via API Admin,
    // );

    // Envia notificação via FCM ao tópico do churrasco
    const topic = `churrasco_${churrasco._id}`;
    const message = {
      notification: {
        title: 'Você foi convidado para um churrasco!',
        body: `Novo churrasco em ${churrascoDate} às ${hora} no ${local}`
      },
      data: { churrascoId: String(churrasco._id) },
      topic
    };
    await admin.messaging().send(message);

    return res.status(201).json({ success: true, id: String(churrasco._id) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Lista churrascos ativos ou passados (sem mudanças) :contentReference[oaicite:4]{index=4}:contentReference[oaicite:5]{index=5}
app.get('/churrascos', async (req, res) => {
  try {
    const status = req.query.status;
    const now    = new Date();
    const all    = await Churrasco.find().lean();
    const filtered = all.filter(c => {
      const [d,m,y] = c.churrascoDate.split('/').map(Number);
      const [h,mi]  = c.hora.split(':').map(Number);
      const dt      = new Date(y, m-1, d, h, mi);
      return status === 'active' ? dt >= now : dt < now;
    });
    return res.json({ success: true, churrascos: filtered.map(mapChurrasco) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Detalhes de um churrasco, wrap em “churrasco” :contentReference[oaicite:6]{index=6}:contentReference[oaicite:7]{index=7}
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

// Confirmar presença e unsubscribe do tópico :contentReference[oaicite:8]{index=8}:contentReference[oaicite:9]{index=9}
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

    // Cancela inscrição do tópico
    const topic = `churrasco_${req.params.id}`;
    // Aqui assumimos que o cliente faz unsubscribe local; opcionalmente:
    // await admin.messaging().unsubscribeFromTopic(token, topic);

    return res.json({ success: true, message: 'Presença confirmada' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Recusar presença e unsubscribe do tópico :contentReference[oaicite:10]{index=10}:contentReference[oaicite:11]{index=11}
app.post('/churrascos/:id/decline-presenca', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Payload inválido' });
    const c = await Churrasco.findById(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' });

    c.guestsDeclined.push(name);
    await c.save();

    // Cancela inscrição do tópico
    const topic = `churrasco_${req.params.id}`;
    // await admin.messaging().unsubscribeFromTopic(token, topic);

    return res.json({ success: true, message: 'Presença recusada' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// DELETE /churrascos/:id — cancela e notifica (sem mudanças) :contentReference[oaicite:12]{index=12}:contentReference[oaicite:13]{index=13}
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

// Lista convites pendentes de um usuário
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

// Inicializa servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
