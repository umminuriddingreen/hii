import test from 'node:test';
import assert from 'node:assert/strict';
import {runArgs,workspace,projectEvent} from './agent-runs.mjs';
test('agent command has fixed workspace, disabled hooks, bounded authority and literal goal',()=>{
 const goal='$(touch /tmp/unsafe) --yolo';
 assert.deepEqual(runArgs({goal,model:'local'},['local']),['run','--no-hooks','--jsonl','--no-context','--authority','workspace','--max-steps','20','--deadline','3m','-C',workspace,'--model','local','--',goal]);
});
test('rejects absent, oversized goals and models not loaded',()=>{
 for(const b of [{goal:'',model:'local'},{goal:'x'.repeat(20001),model:'local'},{goal:'hi',model:'other'},null])assert.throws(()=>runArgs(b,['local']));
});

test('events never forward model context or unrestricted fields',()=>{assert.deepEqual(projectEvent({event:'model.request',data:{messages:[{content:'secret system'}],model:'local',step:1}}),{event:'model.request',data:{model:'local',step:1}});});

test('CLI lifecycle waits for durable registry events and completion',async()=>{
 const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');const {createRuns}=await import('./agent-runs.mjs');
 const saved=[],events=[];const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=99999999;
 const response=new EventEmitter();response.destroyed=false;response.writableEnded=false;response.writeHead=()=>{};response.write=()=>{};let ended;const complete=new Promise(r=>ended=r);response.end=()=>{response.writableEnded=true;ended();};
 const registry={recordRun:async r=>saved.push({...r}),event:async(id,e)=>events.push(e),runs:async()=>saved.slice(-1)};
 const runs=createRuns({registry,spawnProcess:()=>child});await runs.start({goal:'test',model:'local'},['local'],response);
 child.stdout.write(JSON.stringify({event:'run.started',data:{run_id:'native-proof',messages:['hidden']}})+'\n');child.emit('close',0);await complete;
 assert.equal(saved.at(-1).nativeRunId,'native-proof');assert.equal(saved.at(-1).status,'completed');assert.equal(events.length,1);assert.equal(events[0].data.messages,undefined);
});
