# fcm-server

[![Testes](https://github.com/arthursucka/fcm-server/actions/workflows/test.yml/badge.svg)](https://github.com/arthursucka/fcm-server/actions/workflows/test.yml)

Backend em Node.js do app [Churrasco](https://github.com/arthursucka/Churrasco). Cuida de usuários, churrascos (eventos), convites, mensagens, reserva de itens e compartilhamento de localização, e envia notificações via Firebase Cloud Messaging.

## Stack

- Node.js 22 + Express
- MongoDB (Mongoose)
- Firebase Admin (Auth, Realtime Database, Cloud Messaging)

## Como rodar

```bash
npm install
# crie um arquivo .env com as variáveis abaixo
npm start
```

O servidor sobe na porta `PORT` (padrão `3000`). `GET /health` responde se está tudo ok.

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MONGO_URI` | sim | String de conexão do MongoDB |
| `PORT` | não | Porta HTTP (padrão `3000`) |
| `FIREBASE_DATABASE_URL` | não | URL do Realtime Database |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | uma das três | Conta de serviço do Firebase em base64 |
| `SERVICE_ACCOUNT_KEY` | uma das três | Conta de serviço do Firebase em JSON |
| `SERVICE_ACCOUNT_KEY_PATH` | uma das três | Caminho para o arquivo JSON da conta de serviço |

Nunca faça commit de `.env` ou de arquivos de conta de serviço — o `.gitignore` já bloqueia esses arquivos.

## Testes

```bash
npm test
```

Os testes rodam automaticamente no GitHub Actions a cada push e pull request.

## Estrutura

```
server.js                  # API HTTP (rotas /users e /churrascos)
firebase-services.js       # Inicialização do Firebase Admin
item-reservations.js       # Reserva de itens do churrasco
location-policy.js         # Regras do compartilhamento de localização
location-session-store.js  # Sessões de localização
legacy-onboarding.js       # Recuperação de contas antigas
scripts/                   # Scripts de migração e backup (offline/locais)
test/                      # Testes (node:test)
```

## Licença

[Apache 2.0](LICENSE)
