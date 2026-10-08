'use strict';
// Explicit configuration only. Source operations are reads; never dumps secrets to stdout.
const fs=require('node:fs');const path=require('node:path');
const {MongoClient}=require('mongodb');
const {initializeApp,deleteApp,cert}=require('firebase-admin/app');
const {getDatabase}=require('firebase-admin/database');const {getAuth}=require('firebase-admin/auth');
const {captureHistory,saveHistory}=require('./preserve-history');
async function captureFromConfig({envFile,destination,keyFile,authorizedCredentialPath,allowUnconfiguredAuth=false}){
 const env=require('dotenv').parse(fs.readFileSync(envFile));
 if(!env.MONGO_URI||!env.FIREBASE_DATABASE_URL)throw new Error('SOURCE_CONFIGURATION_INCOMPLETE');
 if(process.env.FIREBASE_AUTH_EMULATOR_HOST||process.env.FIREBASE_DATABASE_EMULATOR_HOST)throw new Error('REAL_CAPTURE_REFUSES_EMULATOR_ENVIRONMENT');
 let raw;
 if(env.FIREBASE_SERVICE_ACCOUNT_BASE64)raw=Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_BASE64,'base64').toString('utf8');
 else if(env.SERVICE_ACCOUNT_KEY)raw=env.SERVICE_ACCOUNT_KEY.trim().startsWith('{')?env.SERVICE_ACCOUNT_KEY:Buffer.from(env.SERVICE_ACCOUNT_KEY,'base64').toString('utf8');
 else if(env.SERVICE_ACCOUNT_KEY_PATH){
  const credentialPath=fs.realpathSync(path.resolve(path.dirname(envFile),env.SERVICE_ACCOUNT_KEY_PATH));
  if(/^G:/i.test(credentialPath)&&(!authorizedCredentialPath||fs.realpathSync(authorizedCredentialPath)!==credentialPath))throw new Error('RESTRICTED_CREDENTIAL_SOURCE');
  raw=fs.readFileSync(credentialPath,'utf8');
 }
 if(!raw)throw new Error('FIREBASE_CREDENTIAL_UNAVAILABLE');
 const account=JSON.parse(raw), app=initializeApp({credential:cert(account),databaseURL:env.FIREBASE_DATABASE_URL},'read-only-capture-'+Date.now());
 const client=new MongoClient(env.MONGO_URI,{serverSelectionTimeoutMS:10000,connectTimeoutMS:10000});
 try{
  await client.connect();
  const snapshot=await captureHistory({mongoClient:client,db:client.db(),firebaseRoot:getDatabase(app).ref(),auth:getAuth(app),projectId:account.project_id,allowUnconfiguredAuth});
  return saveHistory(snapshot,{destination,keyFile});
 }finally{await client.close();await deleteApp(app);}
}
module.exports={captureFromConfig};
if(require.main===module){
 const [envFile,destination,keyFile]=process.argv.slice(2);
 if(!envFile||!destination||!keyFile){process.stderr.write('Usage: node scripts/capture-history.js CONFIG_ENV NEW_BACKUP_DIR SEPARATE_KEY_FILE\n');process.exitCode=2;}
 else captureFromConfig({envFile,destination,keyFile}).then(manifest=>process.stdout.write(JSON.stringify(manifest)+'\n')).catch(e=>{
  const allowed=['SOURCE_CONFIGURATION_INCOMPLETE','REAL_CAPTURE_REFUSES_EMULATOR_ENVIRONMENT','RESTRICTED_CREDENTIAL_SOURCE','FIREBASE_CREDENTIAL_UNAVAILABLE','SOURCE_CHANGED_DURING_CAPTURE','UNSUPPORTED_COLLECTION_TYPE','DESTINATION_ALREADY_EXISTS','PRIVATE_KEY_PERMISSIONS_FAILED'];
  process.stderr.write(JSON.stringify({status:'capture_failed',reason:allowed.includes(e.message)?e.message:e.name,sourceDataModified:false})+'\n');process.exitCode=2;
 });
}
