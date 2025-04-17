const { initializeApp } = require('firebase-admin/app');
const admin = require("firebase-admin");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const churrascos = new Map();

// Inicializa o Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(bodyParser.json());
app.use(cors({
  origin: "*", // Permite todas as origens. Substitua "*" por URLs específicas, se necessário.
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Endpoint para enviar notificação
app.post("/send-notification", async (req, res) => {
  const { topic, title, body, data } = req.body;

  // Log do payload recebido
  console.log("Payload recebido no backend:", req.body);

  // Validação do payload
  if (!topic || !title || !body || !data) {
    return res.status(400).send({
      success: false,
      message: "Payload inválido. Certifique-se de enviar 'topic', 'title', 'body' e 'data'.",
    });
  }

  /// Configuração da mensagem
  const message = {
    notification: { title, body },
    data: {
    // Campos obrigatórios como strings
    evento:         String(data.evento || ""),
    churrascoDate:  String(data.churrascoDate || ""),
    hora:           String(data.hora || ""),
    local:          String(data.local || ""),
    // Converte arrays em CSV; caso contrário, faz cast pra string
    fornecidos: Array.isArray(data.fornecidos) && data.fornecidos.length > 0
     ? data.fornecidos.join(",")
     : (data.fornecidos ? String(data.fornecidos) : "Nenhum item fornecido"),
  itensNaoFornecidos: Array.isArray(data.itensNaoFornecidos) && data.itensNaoFornecidos.length > 0
      ? data.itensNaoFornecidos.join(",")
      : (data.itensNaoFornecidos ? String(data.itensNaoFornecidos) : "Nenhum item pendente")
  },
  topic
};

app.post("/churrascos", (req, res) => {
  const { churrascoDate, hora, local, fornecidos, userName, token } = req.body;
  if (!churrascoDate || !hora || !local || !Array.isArray(fornecidos) || !userName || !token) {
    return res.status(400).json({ success:false, message:"Dados incompletos" });
  }
  const id = uuidv4();
  churrascos.set(id, {
    id,
    churrascoDate,
    hora,
    local,
    fornecidos: [...fornecidos],     // itens do churrasqueiro
    guestsConfirmed: [],             // lista de { name, items: [...] }
    guestsDeclined: [],              // lista de nomes
    createdBy: userName,
    createdByToken: token,
    createdAt: new Date().toISOString()
  });
  res.status(201).json({ success: true, id });
});

app.get("/churrascos", (req, res) => {
  const status = req.query.status;
  const now = new Date();
  const result = [];

  for (const churrasco of churrascos.values()) {
    // converter "DD/MM/YYYY" para objeto Date
    const [d, m, y] = churrasco.churrascoDate.split("/").map(Number);
    const eventDate = new Date(y, m - 1, d, ...churrasco.hora.split(":").map(Number));

    const isPast = eventDate < now;
    if ((status === "active" && !isPast) || (status === "past" && isPast)) {
      result.push(churrasco);
    }
  }

  res.json({ success: true, churrascos: result });
});

app.get("/churrascos/:id", (req, res) => {
  const c = churrascos.get(req.params.id);
  if (!c) return res.status(404).json({ success:false, message:"Churrasco não encontrado" });

  // dados resumidos para envio
  res.json({
    success: true,
    churrascoDate:   c.churrascoDate,
    hora:            c.hora,
    local:           c.local,
    fornecidosAgregados: c.fornecidos,
    guestsConfirmed:    c.guestsConfirmed,
    guestsDeclined:     c.guestsDeclined
  });
});

app.post("/churrascos/:id/confirm-presenca", (req, res) => {
  const { name, selectedItems } = req.body;
  const id = req.params.id;
  const c = churrascos.get(id);
  if (!c) return res.status(404).json({ success:false, message:"Churrasco não encontrado" });
  if (!name || !Array.isArray(selectedItems)) {
    return res.status(400).json({ success:false, message:"Dados inválidos" });
  }
  // adiciona guest confirmado
  c.guestsConfirmed.push({ name, items: selectedItems });
  // adiciona itens ao fornecidos agregados
  c.fornecidos.push(...selectedItems);
  churrascos.set(id, c);
  return res.json({ success:true, message:"Presença confirmada" });
});

app.post("/churrascos/:id/decline-presenca", (req, res) => {
  const { name } = req.body;
  const id = req.params.id;
  const c = churrascos.get(id);
  if (!c) return res.status(404).json({ success:false, message:"Churrasco não encontrado" });
  if (!name) return res.status(400).json({ success:false, message:"Nome é obrigatório" });

  c.guestsDeclined.push(name);
  churrascos.set(id, c);
  return res.json({ success:true, message:"Presença recusada" });
});

 // Log da mensagem configurada
 console.log("Mensagem configurada para envio ao Firebase:", message);
 
  try {
    // Envia a notificação usando a API HTTP v1
    const response = await admin.messaging().send(message);
    console.log("Mensagem enviada com sucesso:", response);
    res.status(200).send({ success: true, response });
  } catch (error) {
    console.error("Erro ao enviar notificação:", error);
    res.status(500).send({ success: false, error: error.message });
  }
});

// Log do payload recebido (para depuração)
app.use((req, res, next) => {
  console.log(`Requisição recebida: ${req.method} ${req.url}`);
  console.log("Payload recebido:", req.body);
  next();
});

// Servidor rodando
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
