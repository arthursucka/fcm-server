'use strict';
// Keep a value subscription while transacting: an unsubscribed Admin SDK ref
// may initially report null from its local cache even when server data exists.
module.exports=async function transaction(ref,update){
 const listener=()=>{};
 ref.on('value',listener);
 try{await ref.once('value');return await ref.transaction(update,undefined,false);}
 finally{ref.off('value',listener);}
};
