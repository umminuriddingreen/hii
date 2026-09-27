import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const workspace=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
export function runArgs(body,loadedModels){
 if(!body||typeof body.goal!=='string'||!body.goal.trim()||body.goal.length>20000)throw Error('A goal of 1–20,000 characters is required');
 if(typeof body.model!=='string'||!loadedModels.includes(body.model))throw Error('Select a currently loaded HII model');
 return ['run','--no-hooks','--jsonl','--no-context','--authority','workspace','--max-steps','20','--deadline','3m','-C',workspace,'--model',body.model,'--',body.goal.trim()];
}
export function projectEvent(event){const redact=s=>String(s).slice(0,8000).replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g,'[redacted token]');const projected={};for(const key of ['type','event','timestamp','ts','name'])if(typeof event[key]==='string')projected[key]=redact(event[key]);const data=event.data||{};projected.data={};for(const key of ['step','model','tool','action','status','text','output','result','message','summary']){const value=data[key];if(typeof value==='string')projected.data[key]=redact(value);else if(typeof value==='number'||typeof value==='boolean')projected.data[key]=value;}return projected;}
export function createRuns({registry,spawnProcess=spawn,now=()=>new Date().toISOString()}={}){
 const records=[];let active=null;
 const publicRecord=r=>({id:r.id,goal:r.goal,model:r.model,workspace,status:r.status,startedAt:r.startedAt,finishedAt:r.finishedAt,exitCode:r.exitCode});
 function stop(r){if(!r||r.status!=='running')return false;r.stopping=true;clearTimeout(r.killTimer);if(!Number.isInteger(r.child.pid)||r.child.pid<=1)return false;try{process.kill(-r.child.pid,'SIGTERM');}catch{}r.killTimer=setTimeout(()=>{try{process.kill(-r.child.pid,'SIGKILL');}catch{}},2500);r.killTimer.unref();return true;}
 return {
 list:async()=>registry?(await registry.runs()).map(r=>r.status==='running'&&!records.some(own=>own.id===r.id&&own.status==='running')?{...r,status:'interrupted',notice:'Process ownership was lost after service restart'}:r):records.map(publicRecord),
 stop(id){const r=records.find(r=>r.id===id);if(!r)return null;stop(r);return publicRecord(r);},
 async start(body,models,res){
 const args=runArgs(body,models);if(active){const error=Error('An agent run is already active');error.status=409;throw error;}
 const r={id:randomUUID(),goal:body.goal.trim(),model:body.model,status:'running',startedAt:now()};active=r;
 try{if(registry)await registry.recordRun({...publicRecord(r),source:'HII Web',authority:'workspace'});r.child=spawnProcess('/Users/ummi/bin/hii',args,{cwd:workspace,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env}});}catch(error){active=null;r.status='failed';if(registry)await registry.recordRun({...publicRecord(r),source:'HII Web'}).catch(()=>{});throw error;}
 const child=r.child;records.unshift(r);records.splice(30);
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-HII-Run-Id':r.id});
 let total=0;const send=event=>{if(res.destroyed||res.writableEnded)return;const json=JSON.stringify(event);total+=json.length;if(total>2*1024*1024){stop(r);return;}res.write('data: '+json+'\n\n');};
 let pending=Promise.resolve();const persist=task=>{pending=pending.then(task).catch(error=>send({type:'diagnostic',text:'Registry persistence failed: '+error.message.slice(0,300)}));};
 send({type:'started',run:publicRecord(r)});
 let buffer='',dropping=false;
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
 for(const part of chunk.split(/(?<=\n)/)){if(dropping){if(part.endsWith('\n'))dropping=false;continue;}buffer+=part;if(buffer.length>65536){buffer='';dropping=!part.endsWith('\n');send({type:'output',text:'[Oversized CLI event omitted]'});continue;}if(buffer.endsWith('\n')){const line=buffer.trim();buffer='';if(!line)continue;try{const raw=JSON.parse(line),projected=projectEvent(raw);if(raw.event==='run.started'&&typeof raw.data?.run_id==='string')r.nativeRunId=raw.data.run_id;if(raw.event==='run.finished'){if(typeof raw.data?.run_id==='string')r.nativeRunId=raw.data.run_id;if(typeof raw.data?.receipt==='string')r.receiptPath=raw.data.receipt;if(typeof raw.data?.receipt_path==='string')r.receiptPath=raw.data.receipt_path;}if(registry)persist(async()=>{await registry.event(r.id,projected);if(r.nativeRunId)await registry.recordRun({...publicRecord(r),nativeRunId:r.nativeRunId,receiptPath:r.receiptPath});});send({type:'event',event:projected});}catch{send({type:'output',text:line});}}}});
 let diagnostics=0;child.stderr.setEncoding('utf8');child.stderr.on('data',text=>{const bounded=text.slice(0,Math.max(0,8192-diagnostics));diagnostics+=bounded.length;if(bounded)send({type:'diagnostic',text:bounded});});
 let finished=false;const finish=async(code,error)=>{if(finished)return;finished=true;clearTimeout(r.killTimer);clearTimeout(r.deadline);r.status=r.stopping?'stopped':error||code!==0?'failed':'completed';r.exitCode=code;r.finishedAt=now();if(buffer.trim())send({type:'output',text:buffer.trim()});if(error)send({type:'diagnostic',text:error.message.slice(0,1000)});if(registry){persist(()=>registry.recordRun({...publicRecord(r),nativeRunId:r.nativeRunId,receiptPath:r.receiptPath,source:'HII Web'}));await pending;}active=null;send({type:'completed',run:publicRecord(r)});res.end();};
 child.on('error',error=>finish(null,error));child.on('close',code=>finish(code));res.on('close',()=>{if(!finished)stop(r);});r.deadline=setTimeout(()=>stop(r),190000);r.deadline.unref();return publicRecord(r);
 }
 };
}
