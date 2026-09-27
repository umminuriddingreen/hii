import {allowed} from './protocol.mjs';
export function createBridgeHandler({send,active=new Map(),fetchLocal=fetch,isOpen=()=>true,bufferedAmount=()=>0}){
const MAX=18*1024*1024;
 return async bytes=>{
  let m;try{m=JSON.parse(bytes.toString());}catch{return;}
  if(typeof m.client!=='string'||typeof m.id!=='string'&&m.t!=='disconnect')return;
  const key=m.client+':'+m.id;
  if(m.t==='disconnect'){for(const [id,r] of active)if(r.client===m.client){r.controller.abort();clearTimeout(r.timer);active.delete(id);}return;}
  const respond=o=>send({...o,id:m.id,client:m.client});
  if(m.t==='cancel'){const r=active.get(key);r?.controller.abort();clearTimeout(r?.timer);active.delete(key);return;}
  if(m.t==='request'){
   if(!allowed(m.method,m.path)||active.has(key)||active.size>=32){respond({t:'error',message:'Request not permitted or bridge busy.'});return;}
   const controller=new AbortController();const r={client:m.client,method:m.method,path:m.path,body:[],size:0,nextSequence:0,expectedBytes:m.bodyBytes,controller};
   if(!Number.isSafeInteger(r.expectedBytes)||r.expectedBytes<0||r.expectedBytes>MAX){respond({t:'error',message:'Refresh this page to update the private HII connection.'});return;}
   r.timer=setTimeout(()=>{controller.abort();active.delete(key);respond({t:'error',message:'Request timed out.'});},300000);active.set(key,r);respond({t:'upload-ready'});return;
  }
  const r=active.get(key);if(!r)return;
  if(m.t==='upload'){
   if(typeof m.data!=='string'||m.sequence!==r.nextSequence||r.started){respond({t:'error',message:'Invalid upload sequence.'});r.controller.abort();clearTimeout(r.timer);active.delete(key);return;}
   const chunk=Buffer.from(m.data,'base64');r.size+=chunk.length;
   if(r.size>MAX||r.size>r.expectedBytes){r.controller.abort();clearTimeout(r.timer);active.delete(key);respond({t:'error',message:'Upload too large.'});return;}
   r.body.push(chunk);r.nextSequence++;respond({t:'upload-ack',sequence:m.sequence});return;
  }
  if(m.t!=='end'||r.started)return;if(r.size!==r.expectedBytes){respond({t:'error',message:'Upload incomplete.'});clearTimeout(r.timer);active.delete(key);return;}r.started=true;
  try{
   const response=await fetchLocal('http://127.0.0.1:4188'+r.path,{method:r.method,headers:{'Content-Type':'application/json'},body:r.method==='POST'?Buffer.concat(r.body):undefined,signal:r.controller.signal,redirect:'error'});
   r.body=[];respond({t:'headers',status:response.status,contentType:response.headers.get('content-type')||'application/json'});
   for await(const chunk of response.body){
    for(let i=0;i<chunk.length;i+=48*1024){
     while(bufferedAmount()>1024*1024){if(!isOpen()||r.controller.signal.aborted)throw Error('Disconnected');await new Promise(resolve=>setTimeout(resolve,25));}
     respond({t:'data',data:Buffer.from(chunk.subarray(i,i+48*1024)).toString('base64')});
    }
   }
   respond({t:'done'});
  }catch(e){respond({t:'error',message:r.controller.signal.aborted?'Request stopped.':'The local HII service is unavailable.'});}
  finally{clearTimeout(r.timer);active.delete(key);}
 };

}
