// Local-only integration check against fixture accounts, never production cookies.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base='http://localhost:4199';
for(const [token,status] of [['',401],['test-other-session',404],['test-owner-session',200]]) {
 for(const path of ['/api/personal/access','/personal/','/personal/app.js']) {
  const r=await fetch(base+path,{headers:token?{Cookie:'__Host-hii_session='+token}:{},signal:AbortSignal.timeout(5000)});assert.equal(r.status,status,path);if(status===200&&path==='/personal/')assert.match(r.headers.get('cache-control'),/no-store/);
 }
}
const socket=new WebSocket(base.replace('http:','ws:')+'/api/personal/socket',{headers:{Cookie:'__Host-hii_session=test-owner-session',Origin:'https://humaninformationinterface.com'}});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('socket timeout')),10000);socket.on('error',reject);socket.on('message',data=>{const m=JSON.parse(data);if(m.t==='ready'){assert.equal(m.online,true);clearTimeout(timer);resolve();}});});
const result=await new Promise((resolve,reject)=>{const chunks=[];const timer=setTimeout(()=>reject(Error('relay timeout')),15000);socket.on('message',data=>{const m=JSON.parse(data);if(m.id!=='smoke')return;if(m.t==='error')reject(Error(m.message));if(m.t==='headers')assert.equal(m.status,200);if(m.t==='data')chunks.push(Buffer.from(m.data,'base64'));if(m.t==='done'){clearTimeout(timer);resolve(JSON.parse(Buffer.concat(chunks)));}});socket.send(JSON.stringify({t:'request',id:'smoke',path:'/api/devices',method:'GET'}));socket.send(JSON.stringify({t:'end',id:'smoke'}));});
assert.ok(Array.isArray(result)&&result.some(d=>d.id==='hii'));socket.close();
console.log('PASS: anonymous denied; other account denied; owner assets private; authenticated relay reaches real Mac/PC discovery.');
