const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
function attempt(extra) {
  assert(!fs.existsSync(path.join(__dirname,'.env')),'Test directory must not contain environment secrets');
  return spawnSync(process.execPath,[path.join(__dirname,'../server.js')],{
    cwd:__dirname,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,MONGO_URI:'mongodb://127.0.0.1:19999/churrasco_test_guard',...extra},encoding:'utf8',timeout:10000,windowsHide:true});
}
test('unsigned emulator token support requires explicit local demo mode',()=>{
  const result=attempt({FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19099'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Emulator hosts require explicit/);
  assert(!result.stdout.includes('Servidor rodando'));
});
test('local demo mode rejects a remote Mongo target before startup',()=>{
  const result=attempt({CHURRASCO_LOCAL_TEST:'1',MONGO_URI:'mongodb://remote.invalid/churrasco_test_guard',GCLOUD_PROJECT:'demo-churrasco-security',
    FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19099',FIREBASE_DATABASE_EMULATOR_HOST:'127.0.0.1:19000',FIREBASE_DATABASE_URL:'http://127.0.0.1:19000/?ns=demo-churrasco-security'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Local test requires demo project/);
  assert(!result.stdout.includes('Servidor rodando'));
});
