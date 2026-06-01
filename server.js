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
