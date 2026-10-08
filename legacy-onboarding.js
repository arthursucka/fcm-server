'use strict';
// Authenticated, reviewed legacy onboarding. Never infer ownership from a name.
module.exports=function mountLegacyOnboarding({app,mongoose,User,Churrasco,admin,authenticateFirebase,env}){
 const schema=new mongoose.Schema({firebaseUid:{type:String,unique:true,required:true},username:{type:String,required:true},email:{type:String,required:true},status:{type:String,enum:['pending','activating','approved','rejected'],required:true},createdAt:{type:Date,default:Date.now},updatedAt:{type:Date,default:Date.now},reviewerUid:String,evidenceReference:String,reason:String,decisions:{type:[{action:String,reviewerUid:String,reference:String,at:Date}],default:[]}});
 const Request=mongoose.model('LegacyLinkRequest',schema);
 let indexesFailed=false;const initialization=Promise.all([User.init(),Request.init()]).catch(()=>{indexesFailed=true;});
 const ready=async()=>{await initialization;if(indexesFailed)throw Error('INDEXES_UNAVAILABLE');};
 const windowOpen=()=>env.CHURRASCO_LEGACY_MIGRATION_WINDOW==='1';
 const requestsOpen=()=>env.CHURRASCO_LEGACY_ONBOARDING_ENABLED==='1';
 const publicRequest=r=>r?{id:String(r._id),username:r.username,email:r.email,status:r.status,reason:r.reason||null}:null;
 async function verified(req,res,next){try{await ready();const identity=await admin.auth().getUser(req.authUid);if(identity.disabled||!identity.emailVerified||!identity.email)return res.status(403).json({success:false,message:'Confirme seu e-mail antes de continuar'});req.verifiedIdentity=identity;return next();}catch{return res.status(503).json({success:false,message:'Nao foi possivel verificar seu e-mail agora'});}}
 async function reviewer(req,res,next){if(!env.CHURRASCO_MIGRATION_REVIEWER_UID||req.authUid!==env.CHURRASCO_MIGRATION_REVIEWER_UID)return res.status(403).json({success:false,message:'Revisao disponivel somente ao administrador'});return next();}
 function migrationWindow(req,res,next){if(!windowOpen())return res.status(503).json({success:false,message:'A vinculacao das contas antigas ainda nao foi liberada'});return next();}
 app.get('/legacy-link/me',authenticateFirebase,verified,async(req,res)=>{try{const request=await Request.findOne({firebaseUid:req.authUid}).lean();return res.json({success:true,payload:{request:publicRequest(request),canReview:req.authUid===env.CHURRASCO_MIGRATION_REVIEWER_UID,windowOpen:windowOpen(),requestsOpen:requestsOpen()}});}catch{return res.status(503).json({success:false,message:'Nao foi possivel consultar a solicitacao'});}});
 app.post('/legacy-link/request',authenticateFirebase,verified,async(req,res)=>{
  if(!requestsOpen())return res.status(503).json({success:false,message:'A recuperacao das contas antigas ainda nao foi liberada'});
  try{const name=req.body.username;if(typeof name!=='string'||!name.trim()||name.trim().length>60)return res.status(400).json({success:false,message:'Informe o nome usado na conta antiga'});
   if(await User.findOne({firebaseUid:req.authUid}))return res.status(409).json({success:false,message:'Seu acesso ja esta vinculado a um perfil'});
   const account=await User.findOne({username:name.trim()});if(!account||account.firebaseUid!==undefined)return res.status(409).json({success:false,message:'Conta antiga indisponivel para vinculacao. Confira o nome com o administrador'});
   const current=await Request.findOne({firebaseUid:req.authUid});
   if(current&&current.status!=='rejected'){if(current.username!==name.trim()||current.email!==req.verifiedIdentity.email)return res.status(409).json({success:false,message:'Ja existe uma solicitacao em analise para este acesso'});return res.json({success:true,payload:publicRequest(current)});}
   if(current&&current.decisions.length>=3)return res.status(429).json({success:false,message:'Converse com o administrador antes de enviar outra solicitacao'});
   const record=current?await Request.findOneAndUpdate({_id:current._id,firebaseUid:req.authUid,status:'rejected'},{$set:{username:name.trim(),email:req.verifiedIdentity.email,status:'pending',reason:null,updatedAt:new Date()}},{new:true}):await Request.create({firebaseUid:req.authUid,username:name.trim(),email:req.verifiedIdentity.email,status:'pending'});
   if(!record)return res.status(409).json({success:false,message:'A solicitacao mudou. Atualize a tela'});
   return res.status(201).json({success:true,payload:publicRequest(record)});
  }catch(e){return res.status(e.code===11000?409:503).json({success:false,message:'Nao foi possivel enviar a solicitacao agora'});}
 });
 app.get('/legacy-link/review',authenticateFirebase,verified,reviewer,async(req,res)=>{try{const requests=await Request.find({status:{$in:['pending','activating']}}).sort({createdAt:1}).lean();return res.json({success:true,payload:requests.map(publicRequest)});}catch{return res.status(503).json({success:false,message:'Nao foi possivel carregar a revisao'});}});
 app.post('/legacy-link/:id/reject',authenticateFirebase,verified,reviewer,migrationWindow,async(req,res)=>{try{if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({success:false,message:'Solicitacao invalida'});const reason=req.body.reason;if(typeof reason!=='string'||!reason.trim()||reason.length>500)return res.status(400).json({success:false,message:'Informe o motivo da recusa'});const r=await Request.findOneAndUpdate({_id:req.params.id,status:'pending'},{$set:{status:'rejected',reason:reason.trim(),updatedAt:new Date()},$push:{decisions:{action:'rejected',reviewerUid:req.authUid,reference:reason.trim(),at:new Date()}}},{new:true});if(!r)return res.status(409).json({success:false,message:'Solicitacao indisponivel para recusa'});return res.json({success:true,payload:publicRequest(r)});}catch{return res.status(503).json({success:false,message:'Nao foi possivel registrar a recusa'});}});
 app.post('/legacy-link/:id/approve',authenticateFirebase,verified,reviewer,migrationWindow,async(req,res)=>{
  let session;
  try{
   if(!mongoose.isValidObjectId(req.params.id)||req.body.confirmedOwner!==true||typeof req.body.evidenceReference!=='string'||!req.body.evidenceReference.trim()||req.body.evidenceReference.length>500)return res.status(400).json({success:false,message:'Confirme o titular e registre como a identidade foi conferida'});
   let request=await Request.findById(req.params.id).lean();if(!request||!['pending','activating','approved'].includes(request.status))return res.status(409).json({success:false,message:'Solicitacao indisponivel para aprovacao'});
   if(req.body.expectedUsername!==request.username||req.body.expectedEmail!==request.email)return res.status(409).json({success:false,message:'Os dados da solicitacao mudaram. Atualize a revisao antes de aprovar'});
   const identity=await admin.auth().getUser(request.firebaseUid);
   if(identity.disabled||!identity.emailVerified||identity.email!==request.email)return res.status(409).json({success:false,message:'O e-mail do solicitante mudou ou ainda nao foi confirmado'});
   if(request.status==='approved'){
    const result=await User.updateOne({username:request.username,firebaseUid:request.firebaseUid},{$set:{legacyLinkStatus:'ready'}});
    if(result.matchedCount!==1)throw Error('CONFLICT');
    return res.json({success:true,payload:publicRequest(request)});
   }
   if(request.status==='pending'){
    session=await mongoose.startSession();
    await session.withTransaction(async()=>{
     const locked=await Request.findOneAndUpdate({_id:request._id,status:'pending',username:request.username,email:request.email},{$set:{status:'activating',reviewerUid:req.authUid,evidenceReference:req.body.evidenceReference.trim(),updatedAt:new Date()},$push:{decisions:{action:'approved_identity',reviewerUid:req.authUid,reference:req.body.evidenceReference.trim(),at:new Date()}}},{new:true,session});
     if(!locked)throw Error('CONFLICT');
     if(await User.findOne({firebaseUid:request.firebaseUid}).session(session))throw Error('CONFLICT');
     const account=await User.findOne({username:request.username,firebaseUid:{$exists:false}}).session(session);
     if(!account)throw Error('CONFLICT');
     const result=await User.updateOne({username:request.username,firebaseUid:{$exists:false}},{$set:{firebaseUid:request.firebaseUid,legacyLinkStatus:'pending_access',displayName:account.displayName||request.username,fcmTokens:[]}},{session});
     if(result.modifiedCount!==1)throw Error('CONFLICT');
    });
   }
   const linked=await User.findOne({username:request.username,firebaseUid:request.firebaseUid});if(!linked)throw Error('CONFLICT');
   // During this explicit window all app event writes are blocked. Other UIDs are preserved.
   const events=await Churrasco.find({$or:[{createdBy:request.username},{'guestsConfirmed.name':request.username},{invitedUsers:request.username}]}).lean();
   for(const event of events){const eligible=event.createdBy===request.username||(event.guestsConfirmed||[]).some(g=>g.name===request.username);const ref=admin.database().ref(`eventAccess/${event._id}/${request.firebaseUid}`);if(eligible)await ref.set(true);else await ref.remove();}
   const readyResult=await User.updateOne({username:request.username,firebaseUid:request.firebaseUid},{$set:{legacyLinkStatus:'ready'}});
   if(readyResult.matchedCount!==1)throw Error('CONFLICT');
   request=await Request.findOneAndUpdate({_id:request._id,status:'activating'},{$set:{status:'approved',updatedAt:new Date()}},{new:true});
   if(!request)throw Error('CONFLICT');
   return res.json({success:true,payload:publicRequest(request)});
  }catch(e){return res.status(e.message==='CONFLICT'||e.code===11000?409:503).json({success:false,message:'Vinculacao pendente. Atualize a revisao e tente novamente; o historico foi preservado'});}
  finally{if(session)await session.endSession();}
 });
 return {Request,ready,hasActiveRequest:async uid=>!!(await Request.findOne({firebaseUid:uid,status:{$in:['pending','activating']}}))};
};
