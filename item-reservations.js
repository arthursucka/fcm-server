'use strict';
class ReservationError extends Error { constructor(status,message){super(message);this.status=status;} }
function validateItems(items){
 if(!Array.isArray(items)||items.length>100||items.some(i=>typeof i!=='string'||!i.trim()||i.length>100))throw new ReservationError(400,'Informe itens validos');
 const result=items.map(i=>i.trim());if(new Set(result).size!==result.length)throw new ReservationError(400,'Nao repita o mesmo item');return result;
}
function aggregate(organizerItems,guests){return [...new Set([...organizerItems,...guests.flatMap(g=>g.items||[])])];}
module.exports=function({Churrasco,canRespondToInvite,revoke,grant}){
 // Serialize the Firebase side effects on this instance; Mongo CAS additionally
 // prevents lost updates and duplicate reservations across multiple instances.
 const queues=new Map();
 async function serialized(id,operation){const previous=queues.get(id)||Promise.resolve();let release;const gate=new Promise(r=>release=r);const tail=previous.then(()=>gate);queues.set(id,tail);await previous;try{return await operation();}finally{release();if(queues.get(id)===tail)queues.delete(id);}}
 async function change({id,name,uid,selectedItems,decline=false,context}){
 const items=decline?null:validateItems(selectedItems);
 return serialized(id,async()=>{
  for(let attempt=0;attempt<5;attempt++){
   const event=await Churrasco.findById(id);
   if(!event)throw new ReservationError(404,'Churrasco nao encontrado');
   if(!canRespondToInvite(event,name))throw new ReservationError(403,'Voce nao foi convidado para este evento');
   if(!Array.isArray(event.organizerItems))throw new ReservationError(409,'Este evento antigo precisa da revisao dos itens pelo organizador antes de alterar a participacao');
   const plain=event.toObject?event.toObject():event;
   const guests=plain.guestsConfirmed||[],declined=plain.guestsDeclined||[];
   const others=guests.filter(g=>g.name!==name);
   if(!decline){const reserved=new Set(aggregate(plain.organizerItems,others));const conflicts=items.filter(i=>reserved.has(i));if(conflicts.length)throw new ReservationError(409,`Item ja assumido: ${conflicts.join(', ')}`);}
   const nextGuests=decline?others:[...others,{name,items}];
   const nextDeclined=decline?[...new Set([...declined,name])]:declined.filter(n=>n!==name);
   if(decline&&event.createdBy!==name)await revoke(id,uid);
   const version=plain.__v;
   const filter={_id:id,__v:version===undefined?{$exists:false}:version,createdBy:plain.createdBy,invitedUsers:plain.invitedUsers||[],guestsConfirmed:guests,guestsDeclined:declined,fornecidos:plain.fornecidos||[],organizerItems:plain.organizerItems};
   const updated=await Churrasco.findOneAndUpdate(filter,{$set:{guestsConfirmed:nextGuests,guestsDeclined:nextDeclined,fornecidos:aggregate(plain.organizerItems,nextGuests)},$inc:{__v:1}},{new:true,runValidators:true});
   if(!updated)continue;
   if(!decline)await grant(updated,context);
   return updated;
  }
  throw new ReservationError(409,'O evento mudou durante sua resposta. Atualize e tente novamente');
 });
 }
 return {change};
};
module.exports.validateItems=validateItems;
module.exports.aggregate=aggregate;
module.exports.ReservationError=ReservationError;
