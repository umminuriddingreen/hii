import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRegistry} from './registry.mjs';
test('durable concurrent run updates and safe events share registry',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'hii-registry-'));try{const a=createRegistry(dir),b=createRegistry(dir);await Promise.all([a.recordRun({id:'one',goal:'password is abc123',status:'running'}),b.recordRun({id:'two',status:'completed'})]);assert.equal((await b.runs()).length,2);assert.equal((await b.runs()).find(r=>r.id==='one').goal,'password is [redacted]');await a.event('one',{event:'tool.result',data:{text:'password is abc123',messages:[{text:'hidden'}]}});assert.deepEqual(await b.events('one'),[{event:'tool.result',data:{text:'password is [redacted]'}}]);await b.recordRun({id:'one',status:'completed',nativeRunId:'native-id'});assert.equal((await a.runs()).find(r=>r.id==='one').nativeRunId,'native-id');await assert.rejects(a.events('../bad'));}finally{await rm(dir,{recursive:true,force:true});}});
