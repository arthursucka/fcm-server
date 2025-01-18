const { initializeApp } = require('firebase-admin/app');
const admin = require("firebase-admin");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

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

  // Validação do payload
  if (!topic || !title || !body || !data) {
    return res.status(400).send({
      success: false,
      message: "Payload inválido. Certifique-se de enviar 'topic', 'title', 'body' e 'data'.",
    });
  }

  /// Configuração da mensagem
const message = {
  notification: {
    title,
    body,
  },
  data: {
    ...data, // Inclui os campos 'churrascoDate', 'hora', 'local', etc., enviados no corpo da requisição
    fornecidos: data.fornecidos?.join(",") || "", // Adiciona os itens fornecidos como uma string separada por vírgulas
  },
  topic,
};

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
