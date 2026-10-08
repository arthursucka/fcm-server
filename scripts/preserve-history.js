'use strict';
// Read-only source capture. Raw documents stay inside an authenticated encrypted archive.
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {BSON}=require('mongodb');
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const encode=v=>JSON.stringify(canonical(v));
async function readCatalog(db){
  const catalog=[];
  for(const c of (await db.listCollections({}, {nameOnly:false}).toArray()).sort((a,b)=>a.name.localeCompare(b.name))){
    if(c.type!=='collection')throw new Error('UNSUPPORTED_COLLECTION_TYPE');
    catalog.push({...c,indexes:await db.collection(c.name).indexes()});
  }
  return catalog;
}
async function readMongo(db,session,catalog){
  const options=session?{session}:{};
  const collections=[];
  for(const c of catalog||await readCatalog(db)){
    const collection=db.collection(c.name);
    const documents=await collection.find({},options).sort({_id:1}).toArray();
    collections.push({name:c.name,options:BSON.EJSON.serialize(c.options||{}),indexes:BSON.EJSON.serialize(c.indexes),documents:BSON.EJSON.serialize(documents)});
  }
  return {databaseName:db.databaseName,collections};
}
async function readAuth(auth){
  const users=[];let page;
  do{
    const batch=await auth.listUsers(1000,page);
    for(const u of batch.users)users.push({uid:u.uid,email:u.email||null,emailVerified:u.emailVerified,displayName:u.displayName||null,disabled:u.disabled,providerData:u.providerData,metadata:u.metadata,customClaims:u.customClaims||{}});
    page=batch.pageToken;
  }while(page);
  return users.sort((a,b)=>a.uid.localeCompare(b.uid));
}
async function captureHistory({mongoClient,db,firebaseRoot,auth,projectId,allowUnconfiguredAuth=false}){
  const authSnapshot=async()=>{try{return {state:'configured',users:await readAuth(auth)};}catch(e){if(allowUnconfiguredAuth&&e.code==='auth/configuration-not-found')return {state:'not_configured',users:[]};throw e;}};
  const startedAt=new Date().toISOString(),session=mongoClient.startSession();
  let mongo;
  try{const catalog=await readCatalog(db);await session.withTransaction(async()=>{mongo=await readMongo(db,session,catalog);},{readConcern:{level:'snapshot'}});}finally{await session.endSession();}
  const firebase=(await firebaseRoot.get()).val(), authResult=await authSnapshot(),identities=authResult.users;
  // Stability samples are an extra conflict check, not a cross-system transaction.
  const again=await readMongo(db);
  const firebaseAgain=(await firebaseRoot.get()).val(), authAgain=await authSnapshot();
  if(encode(mongo)!==encode(again)||encode(firebase)!==encode(firebaseAgain)||encode(authResult)!==encode(authAgain))throw new Error('SOURCE_CHANGED_DURING_CAPTURE');
  return {format:'churrasco-history',version:1,startedAt,finishedAt:new Date().toISOString(),projectId,mongo,firebase,authMetadata:identities,
    consistency:'Mongo snapshot plus observed stability samples; no atomic Mongo/Firebase/Auth snapshot',authState:authResult.state,authScope:authResult.state==='not_configured'?'Firebase Auth not configured; no authentication identities exported':'metadata only; no passwords, password hashes, salts or refresh tokens'};
}
function sealHistory(snapshot,key){
  if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('KEY_MUST_HAVE_32_BYTES');
  const header={format:'churrasco-encrypted-history',version:1,algorithm:'AES-256-GCM'};
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(encode(header)));
  const ciphertext=Buffer.concat([cipher.update(encode(snapshot)),cipher.final()]);
  return {...header,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
function openHistory(archive,key){
  if(archive.format!=='churrasco-encrypted-history'||archive.version!==1||archive.algorithm!=='AES-256-GCM')throw new Error('UNSUPPORTED_ARCHIVE');
  const {format,version,algorithm}=archive;
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(archive.iv,'base64'));
  decipher.setAAD(Buffer.from(encode({format,version,algorithm})));decipher.setAuthTag(Buffer.from(archive.tag,'base64'));
  const plaintext=Buffer.concat([decipher.update(Buffer.from(archive.ciphertext,'base64')),decipher.final()]);
  const snapshot=JSON.parse(plaintext.toString('utf8'));
  if(snapshot.format!=='churrasco-history'||snapshot.version!==1)throw new Error('INVALID_HISTORY');
  return snapshot;
}
function inventoryHistory(snapshot){
  const records=name=>snapshot.mongo.collections.find(c=>c.name===name)?.documents||[];
  const users=records('users'),events=records('churrascos');
  const accounts=users.map(u=>({username:u.username,...(u.firebaseUid!==undefined?{firebaseUid:u.firebaseUid}:{})}));
  const identities=snapshot.authMetadata.map(u=>({uid:u.uid}));
  const eventInput=events.map(e=>({id:e._id?.$oid||String(e._id),createdBy:e.createdBy,invitedUsers:e.invitedUsers||[],guestsConfirmed:(e.guestsConfirmed||[]).map(g=>({name:g.name}))}));
  return {status:'pending_ownership_review',accounts,identities,events:eventInput,
    bindings:accounts.map(a=>({username:a.username,firebaseUid:null,approved:false,evidenceReference:'',reviewer:''})),
    notes:['Every existing account must be reviewed. No automatic name/email matching.','Encrypted source archive and restoration check must accompany this inventory.']};
}
function saveHistory(snapshot,{destination,keyFile}){
  const key=crypto.randomBytes(32),archive=sealHistory(snapshot,key);
  // Key must remain outside the deliverable directory; never overwrite existing files.
  const dest=path.resolve(destination),keyPath=path.resolve(keyFile);
  if(keyPath===dest||keyPath.startsWith(dest+path.sep))throw new Error('KEY_MUST_BE_STORED_SEPARATELY');
  if(fs.existsSync(dest)||fs.existsSync(keyPath))throw new Error('DESTINATION_ALREADY_EXISTS');
  fs.mkdirSync(dest);
  const keyFd=fs.openSync(keyPath,'wx',0o600);
  try{
    if(process.platform==='win32'){
      const literal=keyPath.replace(/'/g,"''");
      const script=`$ErrorActionPreference='Stop'; $p='${literal}'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.Security.AccessControl.FileSecurity]::new(); $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','Allow')); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','Allow')); ([System.IO.FileInfo]::new($p)).SetAccessControl($acl)`;
      const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
      const result=spawnSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,stdio:'pipe'});
      if(result.status!==0)throw new Error('PRIVATE_KEY_PERMISSIONS_FAILED');
    }
    fs.writeFileSync(keyFd,key);fs.fsyncSync(keyFd);
  }finally{fs.closeSync(keyFd);}
  const bytes=Buffer.from(JSON.stringify(archive));
  fs.writeFileSync(path.join(dest,'history.encrypted.json'),bytes,{flag:'wx'});
  fs.writeFileSync(path.join(dest,'ownership-review.json'),JSON.stringify(inventoryHistory(snapshot),null,2),{flag:'wx'});
  const manifest={format:archive.format,version:1,status:'captured_requires_restoration_and_ownership_review',startedAt:snapshot.startedAt,finishedAt:snapshot.finishedAt,
    sha256:crypto.createHash('sha256').update(bytes).digest('hex'),collections:snapshot.mongo.collections.map(c=>({name:c.name,documents:c.documents.length,indexes:c.indexes.length})),
    authMetadataUsers:snapshot.authMetadata.length,authScope:snapshot.authScope,consistency:snapshot.consistency,
    keyIncluded:false,keyProtection:process.platform==='win32'?'Windows ACL: current user and SYSTEM':'owner-only file mode',warning:'Keep the separate key private. The inventory contains names/UIDs; it is not public.'};
  fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  return manifest;
}
async function restoreHistoryDemo(snapshot,{db,firebaseRoot}){
  if(!/^churrasco_test[a-z0-9_]*$/.test(db.databaseName))throw new Error('TEST_DATABASE_REQUIRED');
  const hosts=db.client.options.hosts;
  if(!hosts.every(h=>h.host==='127.0.0.1'))throw new Error('LOOPBACK_DATABASE_REQUIRED');
  const url=new URL(firebaseRoot.database.app.options.databaseURL);
  const namespace=url.searchParams.get('ns');
  if(url.hostname!=='127.0.0.1'||!/^demo-[a-z0-9-]+$/.test(namespace||''))throw new Error('DEMO_FIREBASE_REQUIRED');
  if((await db.listCollections().toArray()).length!==0 || (await firebaseRoot.get()).val()!==null)throw new Error('RESTORE_DESTINATION_NOT_EMPTY');
  for(const c of snapshot.mongo.collections){
    await db.createCollection(c.name,BSON.EJSON.deserialize(c.options));
    const docs=BSON.EJSON.deserialize(c.documents);
    if(docs.length)await db.collection(c.name).insertMany(docs);
    for(const i of BSON.EJSON.deserialize(c.indexes)){
      if(i.name==='_id_')continue;
      const {key,v,ns,...options}=i;
      await db.collection(c.name).createIndex(key,options);
    }
  }
  await firebaseRoot.set(snapshot.firebase);
  // Auth is metadata-only and is not recreated or overwritten.
  const restored=await readMongo(db),firebase=(await firebaseRoot.get()).val();
  if(encode(restored.collections)!==encode(snapshot.mongo.collections)||encode(firebase)!==encode(snapshot.firebase))throw new Error('RESTORE_VERIFICATION_FAILED');
  return {status:'restored_and_verified_demo',collections:restored.collections.length,authRecreated:false};
}
module.exports={captureHistory,sealHistory,openHistory,inventoryHistory,saveHistory,restoreHistoryDemo};
