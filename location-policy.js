'use strict';
const HOUR=3600000,ZONE='America/Sao_Paulo';
function parseEventDateTime(date,time){
 if(typeof date!=='string'||typeof time!=='string'||!/^\d{2}\/\d{2}\/\d{4}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))return null;
 const [day,month,year]=date.split('/').map(Number),[hour,minute]=time.split(':').map(Number);
 if(year<2020||year>2100||month<1||month>12||day<1||hour>23||minute>59)return null;
 const wall=Date.UTC(year,month-1,day,hour,minute),d=new Date(wall);
 if(d.getUTCDate()!==day||d.getUTCMonth()!==month-1)return null;
 const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 let instant=wall;
 for(let n=0;n<3;n++){const p=Object.fromEntries(formatter.formatToParts(instant).map(p=>[p.type,p.value]));const shown=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);instant+=wall-shown;}
 return new Date(instant);
}
function windowFor(event){const d=parseEventDateTime(event.churrascoDate,event.hora);return d?{opensAt:+d-HOUR,closesAt:+d+4*HOUR}:null;}
function isOpen(event,now=Date.now()){const w=windowFor(event);return !!w&&now>=w.opensAt&&now<w.closesAt;}
function session(event,id,now=Date.now()){const w=windowFor(event);if(!w||!isOpen(event,now))return null;return {sessionId:id,startedAt:now,expiresAt:Math.min(now+2*HOUR,w.closesAt)};}
function position(current,id,coords,now=Date.now()){
 if(!current||current.sessionId!==id||!Number.isFinite(current.expiresAt)||now>=current.expiresAt)return null;
 return {...current,...coords,updatedAt:now};
}
function expiredWithoutCoordinates(current,now=Date.now()){
 if(!current||!(current.expiresAt<=now))return current;
 return {sessionId:current.sessionId||null,startedAt:current.startedAt||null,expiresAt:current.expiresAt};
}
module.exports={ZONE,HOUR,parseEventDateTime,windowFor,isOpen,session,position,expiredWithoutCoordinates};
