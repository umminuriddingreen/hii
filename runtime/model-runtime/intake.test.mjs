import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
const temp=await mkdtemp(path.join(os.tmpdir(),'hii-intake-test-'));process.env.HII_RUNTIME_DIR=temp;
const {context,attachment,imageKind,runtime,CONTEXT_BUDGET}=await import('./intake.mjs');
test('sniffs HEIC data despite PNG filename',()=>assert.equal(imageKind(Buffer.concat([Buffer.alloc(4),Buffer.from('ftypheic'),Buffer.alloc(12)])),'heic'));
test('retrieves relevant excerpts with a hard aggregate cap',async()=>{const ids=['a','b','c','d'].map(c=>c.repeat(64));for(const id of ids){const folder=path.join(temp,'context','attachments',id);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'record.json'),JSON.stringify({id,name:'document.txt',warnings:[],summary:'',preview:false}));await writeFile(path.join(folder,'extracted.txt'),'prefix '.repeat(600)+'\nNeedle courtyard daylight '+ 'detail '.repeat(1200));}const packet=await context(ids,'courtyard daylight');assert.ok(packet.includes('courtyard'));assert.ok(packet.length<=CONTEXT_BUDGET);assert.ok(!packet.includes('[characters 0-'));});
test('rejects path traversal and excess attachment references',async()=>{await assert.rejects(attachment('../secret'));await assert.rejects(context(Array(5).fill('a'.repeat(64))));});
test('verifies llama.cpp loaded identity from matching healthy status and advertised models',async()=>{
 const file=path.join(temp,'model-runtime','status.json');await mkdir(path.dirname(file),{recursive:true});
 await writeFile(file,JSON.stringify({backend:'llama.cpp',endpoint:'http://127.0.0.1:6127',loadedModel:'qwen-local',selection:{model:'qwen-local'}}));
 const previous=globalThis.fetch;
 globalThis.fetch=async url=>new Response(JSON.stringify(url.endsWith('/health')?{status:'ok'}:{data:[{id:'qwen-local'}]}),{status:200,headers:{'Content-Type':'application/json'}});
 try{
  assert.deepEqual((await runtime()).models,['qwen-local']);
  await writeFile(file,JSON.stringify({backend:'llama.cpp',endpoint:'http://127.0.0.1:6127',loadedModel:'qwen-local',selection:{model:'stale-model'}}));
  await assert.rejects(runtime(),/verified loaded model/);
  await writeFile(file,JSON.stringify({backend:'llama.cpp',endpoint:'http://127.0.0.1:6127',loadedModel:'qwen-local',selection:{model:'qwen-local'}}));
  globalThis.fetch=async url=>new Response(JSON.stringify(url.endsWith('/health')?{status:'starting'}:{data:[{id:'qwen-local'}]}),{status:200,headers:{'Content-Type':'application/json'}});
  await assert.rejects(runtime(),/verified loaded model/);
 }finally{globalThis.fetch=previous;}
});
