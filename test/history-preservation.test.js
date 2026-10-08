const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {sealHistory,openHistory,inventoryHistory,saveHistory}=require('../scripts/preserve-history');
function fixture(){return {format:'churrasco-history',version:1,mongo:{databaseName:'fixture',collections:[
 {name:'users',indexes:[],documents:[{username:'owner',fcmTokens:['PRIVATE-FICTITIOUS-TOKEN']}]},
 {name:'churrascos',indexes:[],documents:[{_id:{$oid:'507f1f77bcf86cd799439011'},createdBy:'owner',guestsConfirmed:[],invitedUsers:[]}]}]},
 firebase:{churrascos:{event:{messages:{m1:{text:'Private fictional history'}}}}},authMetadata:[{uid:'new-uid'}],authScope:'metadata only',consistency:'fixture'};}
test('encrypted archive round trips without plaintext device tokens',()=>{
 const snapshot=fixture(),key=crypto.randomBytes(32),archive=sealHistory(snapshot,key);
 assert.deepEqual(openHistory(archive,key),snapshot);
 assert(!JSON.stringify(archive).includes('PRIVATE-FICTITIOUS-TOKEN'));
});
test('wrong key cannot decrypt backup',()=>{
 const archive=sealHistory(fixture(),crypto.randomBytes(32));
 assert.throws(()=>openHistory(archive,crypto.randomBytes(32)));
});
test('changed ciphertext is rejected',()=>{
 const key=crypto.randomBytes(32),archive=sealHistory(fixture(),key),bytes=Buffer.from(archive.ciphertext,'base64');
 bytes[0]^=1;archive.ciphertext=bytes.toString('base64');assert.throws(()=>openHistory(archive,key));
});
test('inventory never auto assigns identities and excludes device tokens',()=>{
 const inventory=inventoryHistory(fixture());
 assert.equal(inventory.events[0].id,'507f1f77bcf86cd799439011');
 assert.equal(inventory.bindings[0].firebaseUid,null);assert.equal(inventory.bindings[0].approved,false);
 assert(!JSON.stringify(inventory).includes('PRIVATE-FICTITIOUS-TOKEN'));
});
test('key cannot be saved beside encrypted deliverable',()=>{
 assert.throws(()=>saveHistory(fixture(),{destination:'C:/fictional/delivery',keyFile:'C:/fictional/delivery/key.bin'}),/KEY_MUST_BE_STORED_SEPARATELY/);
});
test('saving backup refuses existing key without overwriting it',()=>{
 const work='C:/Users/arthu/Documents/Codex/2026-10-07/https-www-youtube-com-watch-v/work';
 const temp=fs.mkdtempSync(path.join(work,'history-test-')),key=path.join(temp,'key.bin');fs.writeFileSync(key,'protected-fixture');
 assert.throws(()=>saveHistory(fixture(),{destination:path.join(temp,'delivery'),keyFile:key}),/DESTINATION_ALREADY_EXISTS/);
 assert.equal(fs.readFileSync(key,'utf8'),'protected-fixture');
});
