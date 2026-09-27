// Outbound, owner-authenticated transport to the existing local HII projection.
import WebSocket from 'ws';
import {createBridgeHandler} from './bridge-handler.mjs';
import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));

function connect(){
 const ws=new WebSocket(config.url,{headers:{Authorization:'Bearer '+config.key},maxPayload:192*1024});
 const send=(msg)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));};
 ws.on('open',()=>console.log(new Date().toISOString(),'Private HII bridge connected'));
 const active=new Map();
 ws.on('message',createBridgeHandler({send,active,isOpen:()=>ws.readyState===WebSocket.OPEN,bufferedAmount:()=>ws.bufferedAmount}));
 ws.on('error',()=>console.error('Private HII bridge connection unavailable'));
 ws.on('close',()=>{for(const r of active.values()){r.controller.abort();clearTimeout(r.timer);}active.clear();setTimeout(connect,3000);});
 const heartbeat=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.ping();},25000);
 ws.on('close',()=>clearInterval(heartbeat));
}
connect();
