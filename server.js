const { initializeApp } = require('firebase-admin/app');
const admin = require("firebase-admin");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

// Inicializa o Firebase Admin SDK
// const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
const serviceAccount = require("./serviceAccountKey.json");


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
