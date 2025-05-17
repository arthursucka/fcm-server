require('dotenv').config()

const express = require('express')
const mongoose = require('mongoose')
const bodyParser = require('body-parser')
const cors = require('cors')
const admin = require('firebase-admin')

// Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
})

// MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Atlas conectado!'))
  .catch(err => {
    console.error('Erro ao conectar MongoDB:', err)
    process.exit(1)
  })

// Esquema do churrasco
const churrascoSchema = new mongoose.Schema({
  churrascoDate: String,
  hora: String,
  local: String,
  fornecidos: [String],
  guestsConfirmed: [{ name: String, items: [String] }],
  guestsDeclined: [String],
  createdBy: String,
  createdAt: { type: Date, default: Date.now }
})

const Churrasco = mongoose.model('Churrasco', churrascoSchema)

// App Express
const app = express()
app.use(bodyParser.json())
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }))

// 🔸 Criar churrasco
app.post('/churrascos', async (req, res) => {
  try {
    const { churrascoDate, hora, local, fornecidos, userName } = req.body
    if (!churrascoDate || !hora || !local || !userName || !Array.isArray(fornecidos)) {
      return res.status(400).json({ success: false, message: 'Dados incompletos' })
    }

    const churrasco = await Churrasco.create({
      churrascoDate,
      hora,
      local,
      fornecidos,
      guestsConfirmed: [],
      guestsDeclined: [],
      createdBy: userName
    })

    return res.status(201).json({ success: true, id: churrasco._id })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ success: false, message: e.message })
  }
})

// 🔸 Listar churrascos ativos ou passados
app.get('/churrascos', async (req, res) => {
  try {
    const status = req.query.status
    const now = new Date()
    const all = await Churrasco.find().lean()
    const filtered = all.filter(c => {
      const [d, m, y] = c.churrascoDate.split('/').map(Number)
      const [h, mi] = c.hora.split(':').map(Number)
      const dateObj = new Date(y, m - 1, d, h, mi)
      return status === 'active' ? dateObj >= now : dateObj < now
    })
    return res.json({ success: true, churrascos: filtered })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ success: false, message: e.message })
  }
})

// 🔸 Detalhes de um churrasco
app.get('/churrascos/:id', async (req, res) => {
  try {
    const c = await Churrasco.findById(req.params.id).lean()
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' })

    return res.json({
      success: true,
      churrascoDate: c.churrascoDate,
      hora: c.hora,
      local: c.local,
      createdBy: c.createdBy,
      fornecidosAgregados: c.fornecidos,
      guestsConfirmed: c.guestsConfirmed,
      guestsDeclined: c.guestsDeclined
    })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ success: false, message: e.message })
  }
})

// 🔸 Confirmar presença
app.post('/churrascos/:id/confirm-presenca', async (req, res) => {
  try {
    const { name, selectedItems } = req.body
    const c = await Churrasco.findById(req.params.id)
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' })

    c.guestsConfirmed.push({ name, items: selectedItems })
    c.fornecidos.push(...selectedItems)
    await c.save()
    return res.json({ success: true, message: 'Presença confirmada' })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ success: false, message: e.message })
  }
})

// 🔸 Recusar presença
app.post('/churrascos/:id/decline-presenca', async (req, res) => {
  try {
    const { name } = req.body
    const c = await Churrasco.findById(req.params.id)
    if (!c) return res.status(404).json({ success: false, message: 'Churrasco não encontrado' })

    c.guestsDeclined.push(name)
    await c.save()
    return res.json({ success: true, message: 'Presença recusada' })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ success: false, message: e.message })
  }
})

// 🔸 Envio de notificação
app.post('/send-notification', async (req, res) => {
  const { to, notification, data } = req.body

  if (!to || !notification?.title || !notification?.body || !data) {
    return res.status(400).json({ success: false, message: 'Payload inválido' })
  }

  const message = {
    notification: {
      title: notification.title,
      body: notification.body
    },
    data: {
      id: String(data.id || ''),
      churrascoDate: String(data.churrascoDate || ''),
      hora: String(data.hora || ''),
      local: String(data.local || ''),
      fornecidos: String(data.fornecidos || '')
    },
    topic: to.replace('/topics/', '')
  }

  try {
    const response = await admin.messaging().send(message)
    console.log('Notificação enviada:', response)
    return res.json({ success: true, response })
  } catch (error) {
    console.error('Erro ao enviar notificação:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

// Middleware opcional de log
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`)
  console.log('📦 Payload:', req.body)
  next()
})

// Inicia o servidor
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`))
