'use strict';
// Offline ownership intake only. No credentials, network, identities or database changes.
const fs=require('node:fs');
function prepareOwnershipReview(inventory,review){
 const errors=[],pending=[],rows=[],seen=new Set(),emails=new Map();
 const fail=(code,username)=>errors.push({code,username});
 if(!inventory||!Array.isArray(inventory.accounts)||!review||!Array.isArray(review.entries))return {status:'invalid',errors:[{code:'INVALID_INPUT'}],rows:[],migrationReady:false};
 const names=new Set();
 for(const account of inventory.accounts){if(!account||typeof account.username!=='string'||!account.username.trim()||names.has(account.username))fail('INVALID_INVENTORY',account?.username);else names.add(account.username);}
 for(const entry of review.entries){
  const name=entry?.username;
  if(!names.has(name)){fail('UNKNOWN_ACCOUNT',name);continue;}
  if(seen.has(name)){fail('DUPLICATE_ACCOUNT',name);continue;}seen.add(name);
  const email=typeof entry.email==='string'?entry.email.trim():'';
  const row={username:name,email,confirmedByOwner:entry.confirmedByOwner===true,evidenceReference:typeof entry.evidenceReference==='string'?entry.evidenceReference.trim():'',reviewer:typeof entry.reviewer==='string'?entry.reviewer.trim():''};
  rows.push(row);
  if(email){
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)fail('INVALID_EMAIL',name);
   const match=email.toLowerCase();if(emails.has(match))fail('EMAIL_ASSIGNED_TWICE',name);else emails.set(match,name);
  }
  const missing=[];if(!email)missing.push('email');if(!row.confirmedByOwner)missing.push('owner_confirmation');if(!row.evidenceReference)missing.push('evidence');if(!row.reviewer)missing.push('reviewer');
  if(missing.length)pending.push({username:name,missing});
 }
 for(const name of names)if(!seen.has(name))pending.push({username:name,missing:['entry']});
 return {status:errors.length?'invalid':pending.length?'pending':'ownership_review_complete',errors,pending,rows,migrationReady:false,
  notes:['Owner confirmation and evidence are statements supplied by the reviewer, not independently verified by this tool.','Email ownership and Firebase UIDs still require authenticated verification. No account binding or permissions are generated.']};
}
module.exports={prepareOwnershipReview};
if(require.main===module){try{const [inventoryFile,reviewFile]=process.argv.slice(2);if(!inventoryFile||!reviewFile)throw Error();const result=prepareOwnershipReview(JSON.parse(fs.readFileSync(inventoryFile,'utf8')),JSON.parse(fs.readFileSync(reviewFile,'utf8')));process.stdout.write(JSON.stringify(result,null,2)+'\n');if(result.status!=='ownership_review_complete')process.exitCode=2;}catch{process.stderr.write('Unable to read review input. No data changed.\n');process.exitCode=2;}}
