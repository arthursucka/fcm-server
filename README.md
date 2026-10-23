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
| `MIN_APP_VERSION` | não | `versionCode` mínimo do app (padrão `21`). Versões abaixo recebem `426 Atualize o app` |
| `CHURRASCO_ADMIN_UIDS` | não | UIDs do Firebase, separados por vírgula, que podem editar ou cancelar qualquer churrasco |
| `PUBLIC_BASE_URL` | não | Endereço público usado nos links de convite (padrão: o do Render) |
| `ANDROID_CERT_SHA256` | não | Impressões SHA-256 do certificado do app para os App Links (`/.well-known/assetlinks.json`) |
| `CHURRASCO_LEGACY_ONBOARDING_ENABLED` | não | `1` libera pedidos de recuperação de contas antigas |
| `CHURRASCO_MIGRATION_REVIEWER_UID` | não | UID de quem revisa os pedidos (também conta como admin) |
| `CHURRASCO_LEGACY_MIGRATION_WINDOW` | não | `1` só enquanto aprova pedidos: pausa alterações em churrascos |

Nunca faça commit de `.env` ou de arquivos de conta de serviço — o `.gitignore` já bloqueia esses arquivos.

## Testes

```bash
npm test
```

Os testes sobem a API contra um MongoDB real em memória (`mongodb-memory-server`) e um Firebase falso, então não precisam de rede nem de credenciais. Rodam automaticamente no GitHub Actions a cada push e pull request.

Um agendamento (`.github/workflows/keepalive.yml`) chama `/health` a cada 10 minutos para o Render gratuito não dormir.

## Migração para a v2

A v2 identifica as pessoas pelo UID do Firebase em vez do nome. Para converter um banco da v1:

```bash
node scripts/migrate-v2.js --dry-run   # mostra o que mudaria
node scripts/migrate-v2.js             # faz backup em backups/<data>/ e migra
```

Quem ainda não vinculou a conta antiga fica com `legacyUsername` nos eventos; a aprovação do pedido de recuperação troca pelo UID.

## Estrutura

```
server.js                  # Inicialização (Mongo, Firebase, listen) e limpeza de localizações
lib/app.js                 # API v2: usuários, amigos, churrascos, convites, custos, chat e mapa
lib/models.js              # Esquemas do Mongo
lib/domain.js              # Regras puras: itens, papéis, divisão de custos
firebase-services.js       # Inicialização do Firebase Admin
location-policy.js         # Regras do compartilhamento de localização
location-session-store.js  # Sessões de localização
legacy-onboarding.js       # Recuperação de contas antigas
scripts/                   # Scripts de migração e backup (offline/locais)
test/                      # Testes (node:test)
```

## Licença

[Apache 2.0](LICENSE)
