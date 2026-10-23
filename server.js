// server.js
require('dotenv').config();

const mongoose = require('mongoose');
const admin = require('./firebase-services');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://churrasco-aa495-default-rtdb.firebaseio.com';

if (!MONGO_URI) {
  console.error('Erro: variavel MONGO_URI nao configurada.');
  process.exit(1);
}

// Explicit local rehearsal only. Never enable unsigned emulator tokens in production.
const localTest = process.env.CHURRASCO_LOCAL_TEST === '1';
if (localTest) {
  const loopback = /^127\.0\.0\.1:[0-9]+$/;
  if (!/^demo-[a-z0-9-]+$/.test(process.env.GCLOUD_PROJECT || '') ||
      !loopback.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || '') ||
      !loopback.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '') ||
      !/^mongodb:\/\/127\.0\.0\.1:[0-9]+\/churrasco_test[a-z0-9_]*(?:\?.*)?$/.test(MONGO_URI) ||
      FIREBASE_DATABASE_URL !== `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/?ns=${process.env.GCLOUD_PROJECT}`) {
    throw new Error('Local test requires demo project and isolated loopback targets');
  }
} else if (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  throw new Error('Emulator hosts require explicit isolated local test mode');
}

// Firebase Admin Init
let firebaseEnabled = false;

try {
  if (localTest) {
    admin.initializeApp({projectId: process.env.GCLOUD_PROJECT, databaseURL: FIREBASE_DATABASE_URL});
    firebaseEnabled = true;
    console.log('Firebase local demo initialized; notifications disabled');
  } else {
  const serviceAccountJson = resolveServiceAccountJson();

  if (!serviceAccountJson) {
    console.warn('Aviso: credencial Firebase nao configurada. Notificacoes e chat desativados.');
  } else {
    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL,
    });

    firebaseEnabled = true;
    console.log('Firebase Admin inicializado!');
  }
  }
} catch (error) {
  console.error('Erro ao inicializar Firebase Admin:', error);
  firebaseEnabled = false;
}

function resolveServiceAccountJson() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      'base64'
    ).toString('utf8');
  }

  if (process.env.SERVICE_ACCOUNT_KEY) {
    const value = process.env.SERVICE_ACCOUNT_KEY.trim();
    if (value.startsWith('{')) return value;

    return Buffer.from(value, 'base64').toString('utf8');
  }

  if (process.env.SERVICE_ACCOUNT_KEY_PATH && fs.existsSync(process.env.SERVICE_ACCOUNT_KEY_PATH)) {
    return fs.readFileSync(process.env.SERVICE_ACCOUNT_KEY_PATH, 'utf8');
  }

  return null;
}

// MongoDB Connect
mongoose
  .connect(MONGO_URI)
  .then(() => console.log('MongoDB conectado!'))
  .catch((err) => {
    console.error('Erro ao conectar ao MongoDB:', err);
    process.exit(1);
  });

// Rotas da API v2 (lib/app.js); aqui só ficam inicialização e tarefas periódicas.
const locationPolicy = require('./location-policy');
const locationTransaction = require('./location-session-store');
const models = require('./lib/models')(mongoose);
const app = require('./lib/app')({ mongoose, models, admin, env: process.env, firebaseEnabled, localTest });

app.listen(PORT, localTest ? '127.0.0.1' : undefined, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Strip expired coordinates while retaining the session deadline. An update
// cannot restart it; only an explicit session request can start a new one.
let expiringLocations=false;
async function expireLocations(){
 if(!firebaseEnabled||expiringLocations)return;
 expiringLocations=true;
 try{
  const events=(await admin.database().ref('churrascos').get()).val()||{};
  for(const [id,event] of Object.entries(events))for(const [uid,loc] of Object.entries(event.locations||{})){
   if(loc.expiresAt<=Date.now()&&('latitude' in loc||'longitude' in loc)){
    const ref=admin.database().ref(`churrascos/${id}/locations/${uid}`);
    await locationTransaction(ref,current=>current?locationPolicy.expiredWithoutCoordinates(current):undefined);
   }
  }
 }catch(_){console.error('Falha na limpeza de coordenadas expiradas');}finally{expiringLocations=false;}
}
const locationExpiryTimer=setInterval(expireLocations,localTest ? 1000 : 60000);locationExpiryTimer.unref();
expireLocations();



