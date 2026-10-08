'use strict';
// Local/demo only. Never connects to production and never loads .env/credentials.
const fs = require('node:fs');
const crypto = require('node:crypto');
const {MongoClient, ObjectId} = require('mongodb');
const {initializeApp, deleteApp} = require('firebase-admin/app');
const {getDatabase} = require('firebase-admin/database');
const {getAuth} = require('firebase-admin/auth');
const {planIdentityMigration} = require('./plan-identity-migration');
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k])]));
  return v;
}
const json = v => JSON.stringify(canonical(v));
const equal = (a,b) => json(a)===json(b);
const hash = v => crypto.createHash('sha256').update(json(v)).digest('hex');
function accounts(rows) {return rows.map(a => ({username:a.username,...(a.firebaseUid!==undefined?{firebaseUid:a.firebaseUid}:{})})).sort((a,b)=>a.username.localeCompare(b.username));}
function events(rows) {return rows.map(e => ({id:String(e.id || e._id),createdBy:e.createdBy,guestsConfirmed:(e.guestsConfirmed||[]).map(g=>({name:g.name})),invitedUsers:e.invitedUsers||[]})).sort((a,b)=>a.id.localeCompare(b.id));}
function fail(code) {throw new Error(code);}
function validateTargets(mongoUri) {
  const projectId=process.env.GCLOUD_PROJECT;
  const auth=process.env.FIREBASE_AUTH_EMULATOR_HOST, database=process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!/^demo-[a-z0-9-]+$/.test(projectId||'') || !/^127\.0\.0\.1:[0-9]+$/.test(auth||'') || !/^127\.0\.0\.1:[0-9]+$/.test(database||'') ||
      !/^mongodb:\/\/127\.0\.0\.1:[0-9]+\/churrasco_test[a-z0-9_]*(?:\?.*)?$/.test(mongoUri||'')) fail('LOCAL_DEMO_TARGETS_REQUIRED');
  return {projectId, databaseName:new URL(mongoUri).pathname.slice(1), databaseURL:`http://${database}/?ns=${projectId}`};
}
async function withTargets(mongoUri, fn) {
  const target=validateTargets(mongoUri), client=new MongoClient(mongoUri);
  const app=initializeApp({projectId:target.projectId,databaseURL:target.databaseURL},'rehearsal-'+crypto.randomUUID());
  try {await client.connect(); return await fn({client,db:client.db(target.databaseName),access:getDatabase(app).ref('eventAccess'),auth:getAuth(app),target});}
  finally {await client.close();await deleteApp(app);}
}
function createJournal(file, journal) {
  const fd=fs.openSync(file,'wx');
  try {fs.writeFileSync(fd,JSON.stringify(journal,null,2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function saveJournal(file,journal) {
  const tmp=file+'.next'; const fd=fs.openSync(tmp,'wx');
  try {fs.writeFileSync(fd,JSON.stringify(journal,null,2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(tmp,file);
}
async function inventory(db,session) {
  const opts=session?{session}:{};
  const users=await db.collection('users').find({}, {...opts,projection:{_id:1,username:1,firebaseUid:1}}).toArray();
  const records=await db.collection('churrascos').find({}, {...opts,projection:{_id:1,createdBy:1,guestsConfirmed:1,invitedUsers:1}}).toArray();
  return {users,accounts:accounts(users),events:events(records)};
}
async function replaceAcl(access, expected, desired) {
  // Keep a live read while starting the transaction. A new SDK connection can
  // initially supply null to the updater before its server cache is populated.
  let listener;
  const loaded=new Promise((resolve,reject)=>{
    listener=snapshot=>resolve(snapshot.val());
    access.on('value',listener,reject);
  });
  try {
    await loaded;
    const result=await access.transaction(current=>equal(current,expected)?desired:undefined,undefined,false);
    if (!result.committed) fail('ACL_CHANGED_SINCE_SNAPSHOT');
  } finally {access.off('value',listener);}
}
async function applyDemoMigration({input,mongoUri,journalFile,hooks={}}) {
  const plan=planIdentityMigration(input);
  if (plan.status!=='prepared_only') fail('REVIEWED_COMPLETE_PLAN_REQUIRED');
  return withTargets(mongoUri,async ({client,db,access,auth,target})=>{
    const original=await inventory(db);
    if (!equal(original.accounts,accounts(input.accounts)) || !equal(original.events,events(input.events))) fail('INVENTORY_CHANGED_OR_INCOMPLETE');
    const index=await db.collection('users').indexes();
    if (!index.some(i=>i.unique===true && i.sparse===true && equal(i.key,{firebaseUid:1}))) fail('UNIQUE_SPARSE_UID_INDEX_REQUIRED');
    for (const i of input.identities) await auth.getUser(i.uid);
    const beforeAcl=(await access.get()).val();
    const desiredAcl=Object.keys(plan.eventAccess).length?plan.eventAccess:null;
    const updates=plan.uidBindings.map(b=>({...b,id:String(original.users.find(a=>a.username===b.username)._id)}));
    const afterAccounts=accounts(original.accounts.map(a=>({...a,firebaseUid:input.bindings.find(b=>b.username===a.username)?.firebaseUid || a.firebaseUid})));
    const journal={version:1,scope:'local_demo_only',projectId:target.projectId,databaseName:target.databaseName,phase:'prepared',
      beforeAccounts:original.accounts,afterAccounts,beforeEventsHash:hash(original.events),beforeAcl,desiredAcl,updates,planHash:hash(plan)};
    createJournal(journalFile,journal);
    const phase=p=>{journal.phase=p;saveJournal(journalFile,journal);};
    const session=client.startSession();
    try {
      phase('revocation_attempt'); await replaceAcl(access,beforeAcl,null); phase('revoked');
      phase('uid_commit_attempt');
      await session.withTransaction(async ()=>{
        const current=await inventory(db,session);
        if (!equal(current.accounts,journal.beforeAccounts) || hash(current.events)!==journal.beforeEventsHash) fail('INVENTORY_CHANGED_SINCE_SNAPSHOT');
        for (const u of updates) {
          const result=await db.collection('users').updateOne({_id:new ObjectId(u.id),username:u.username,firebaseUid:{$exists:false}},{$set:{firebaseUid:u.firebaseUid}},{session});
          if (result.matchedCount!==1) fail('UID_PRECONDITION_CHANGED');
        }
      });
      phase('uid_committed');
      if (hooks.afterUidCommit) await hooks.afterUidCommit();
      const latest=await inventory(db);
      if (!equal(latest.accounts,journal.afterAccounts) || hash(latest.events)!==journal.beforeEventsHash) fail('INVENTORY_CHANGED_BEFORE_ACL_PUBLISH');
      await replaceAcl(access,null,desiredAcl); phase('applied_demo');
      return {status:'applied_demo',bindings:updates.length,events:Object.keys(plan.eventAccess).length,journalFile};
    } catch(e) {journal.phase='recovery_required';journal.failure=e.message;saveJournal(journalFile,journal);throw e;}
    finally {await session.endSession();}
  });
}
async function rollbackDemoMigration({mongoUri,journalFile}) {
  const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
  if (journal.version!==1 || journal.scope!=='local_demo_only' || !Array.isArray(journal.updates)) fail('INVALID_JOURNAL');
  return withTargets(mongoUri,async ({client,db,access,target})=>{
    if (journal.projectId!==target.projectId || journal.databaseName!==target.databaseName) fail('JOURNAL_TARGET_MISMATCH');
    if (journal.phase==='rolled_back_demo') return {status:'already_rolled_back_demo'};
    const current=await inventory(db), acl=(await access.get()).val();
    if ((!equal(current.accounts,journal.beforeAccounts) && !equal(current.accounts,journal.afterAccounts)) || hash(current.events)!==journal.beforeEventsHash) fail('ROLLBACK_INVENTORY_CHANGED');
    if (!equal(acl,journal.desiredAcl) && acl!==null && !equal(acl,journal.beforeAcl)) fail('ROLLBACK_ACL_CHANGED');
    journal.phase='rollback_attempt';saveJournal(journalFile,journal);
    await replaceAcl(access,acl,null);
    const session=client.startSession();
    try {
      await session.withTransaction(async ()=>{
        const state=await inventory(db,session);
        if (hash(state.events)!==journal.beforeEventsHash) fail('ROLLBACK_INVENTORY_CHANGED');
        if (equal(state.accounts,journal.afterAccounts)) {
          for (const u of journal.updates) {
            const result=await db.collection('users').updateOne({_id:new ObjectId(u.id),username:u.username,firebaseUid:u.firebaseUid},{$unset:{firebaseUid:''}},{session});
            if (result.matchedCount!==1) fail('ROLLBACK_UID_CHANGED');
          }
        } else if (!equal(state.accounts,journal.beforeAccounts)) fail('ROLLBACK_INVENTORY_CHANGED');
      });
      await replaceAcl(access,null,journal.beforeAcl);
      journal.phase='rolled_back_demo';saveJournal(journalFile,journal);
      return {status:'rolled_back_demo'};
    } finally {await session.endSession();}
  });
}
module.exports={applyDemoMigration,rollbackDemoMigration,validateTargets};
if(require.main===module) {
  (async ()=>{
    const [action,file,journalFile]=process.argv.slice(2);
    if(action==='apply-demo' && file && journalFile) return applyDemoMigration({input:JSON.parse(fs.readFileSync(file,'utf8')),mongoUri:process.env.CHURRASCO_TEST_MONGO_URI,journalFile});
    if(action==='rollback-demo' && file && !journalFile) return rollbackDemoMigration({mongoUri:process.env.CHURRASCO_TEST_MONGO_URI,journalFile:file});
    fail('Usage: apply-demo INPUT JOURNAL or rollback-demo JOURNAL; loopback/demo environment required');
  })().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=2;});
}
