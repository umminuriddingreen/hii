// Adapt the existing fetch-based UI to HII's authenticated outbound bridge.
let socket,connecting;const pending=new Map();
const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function fail(id,message){const p=pending.get(id);if(!p)return;clearTimeout(p.timer);p.cleanup?.();pending.delete(id);const e=Error(message);if(p.started)p.stream.error(e);else p.reject(e);}
async function connect(){
 if(socket?.readyState===WebSocket.OPEN)return socket;
 if(connecting)return connecting;
 connecting=new Promise((resolve,reject)=>{
  const ws=new WebSocket(location.origin.replace('https:','wss:')+'/api/personal/socket');socket=ws;
  const timeout=setTimeout(()=>ws.close(),12000);
  ws.onmessage=e=>{
   const m=JSON.parse(e.data);
   if(m.t==='ready'){clearTimeout(timeout);resolve(ws);return;}
   const p=pending.get(m.id);if(!p)return;
   if(m.t==='headers'){p.started=true;p.resolve(new Response(new ReadableStream({start(c){p.stream=c;},cancel(){ws.send(JSON.stringify({t:'cancel',id:m.id}));fail(m.id,'Request stopped.');}}),{status:m.status,headers:{'Content-Type':m.contentType}}));}
   else if(m.t==='data')p.stream?.enqueue(decode(m.data));
   else if(m.t==='done'){p.stream?.close();clearTimeout(p.timer);p.cleanup?.();pending.delete(m.id);}
   else if(m.t==='error')fail(m.id,m.message);
  };
  ws.onerror=()=>reject(Error('Sign in to your private HII account and reload.'));
  ws.onclose=()=>{clearTimeout(timeout);connecting=null;socket=null;reject(Error('Private HII connection closed.'));for(const id of pending.keys())fail(id,'Your Mac disconnected. Reconnect and retry.');};
 });
 try{return await connecting;}finally{connecting=null;}
}
export async function privateFetch(path,options={}){
 if(!path.startsWith('/api/'))return globalThis.fetch(path,options);
 const ws=await connect();if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
 const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  const p={resolve,reject,timer:setTimeout(()=>fail(id,'Request timed out.'),305000)};pending.set(id,p);
  const cancel=()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({t:'cancel',id}));fail(id,'Request stopped.');};
  options.signal?.addEventListener('abort',cancel,{once:true});p.cleanup=()=>options.signal?.removeEventListener('abort',cancel);
  (async()=>{
   ws.send(JSON.stringify({t:'request',id,path,method:options.method||'GET'}));
   const body=new TextEncoder().encode(options.body||'');
   for(let i=0;i<body.length;i+=48*1024){
    while(ws.bufferedAmount>512*1024){if(ws.readyState!==WebSocket.OPEN||options.signal?.aborted)throw Error('Request stopped.');await new Promise(r=>setTimeout(r,20));}
    ws.send(JSON.stringify({t:'upload',id,data:btoa(String.fromCharCode(...body.subarray(i,i+48*1024)))}));
   }
   ws.send(JSON.stringify({t:'end',id}));
  })().catch(e=>fail(id,e.message));
 });
}
// Private images use the same authenticated channel, never a public asset URL.
const images=new Map();
async function hydrate(img){const src=img.getAttribute('src');if(!src?.startsWith('/api/')||img.dataset.loading===src)return;img.dataset.loading=src;try{if(!images.has(src))images.set(src,privateFetch(src).then(async r=>{if(!r.ok)throw Error('Image unavailable');return URL.createObjectURL(await r.blob());}).catch(e=>{images.delete(src);throw e;}));const url=await images.get(src);img.src=url;if(img.parentElement?.tagName==='A')img.parentElement.href=url;}catch{img.alt='Image unavailable. Reconnect your Mac.';}}
new MutationObserver(()=>document.querySelectorAll('img[src^="/api/"]').forEach(hydrate)).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
