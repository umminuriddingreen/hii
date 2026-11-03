import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint, validateConfig, snapshot, restore, lock, once, markedMacRelease, isMacReleaseDescendant } from './hii-device-auto-update.mjs';
async function temp(t) { const p=await fs.mkdtemp(path.join(os.tmpdir(),'hii-update-')); t.after(()=>fs.rm(p,{recursive:true,force:true})); return p; }
test('fingerprint skips prose but includes every shipped resource and Rust',()=>{
 const row=(p,h='abc')=>`100644 blob ${h}\t${p}`;
 const base=row('cli/src/main.rs');
 assert.equal(fingerprint(base),fingerprint(base+'\n'+row('docs/guide.md')));
 for(const p of ['runtime/agent.mjs','config/a.json','scripts/a.mjs','browser/dist/index.js','docs/HII_FEATURE_REGISTRY.yaml','AGENTS.md','package.json','fabric/protocol/src/lib.rs','Cargo.lock']) assert.notEqual(fingerprint(base),fingerprint(base+'\n'+row(p)),p);
});
test('host and Windows path reject shell/control input',()=>{
 for(const host of ['-oProxyCommand=x','hii-pc;whoami','a b']) assert.throws(()=>validateConfig({repo:'/tmp/repo',windows:{enabled:true,host,root:'C:/Users/example/.hii/auto-update'}}));
 assert.throws(()=>validateConfig({repo:'/tmp/repo',windows:{enabled:true,host:'hii-pc',root:'C:/Windows'}}));
 assert.throws(()=>validateConfig({repo:'relative'}));
});
test('rollback restores marker bytes, executable mode and missing launcher',async t=>{
 const root=await temp(t), f=path.join(root,'launcher'); await fs.writeFile(f,'old',{mode:0o755}); const old=await snapshot(f); await fs.writeFile(f,'new'); await restore(f,old); assert.equal(await fs.readFile(f,'utf8'),'old'); if(process.platform !== 'win32') assert.equal((await fs.stat(f)).mode&0o777,0o755); await restore(f,null); assert.equal(await snapshot(f),null);
});
test('exclusive lock prevents overlap',async t=>{const root=await temp(t),release=await lock(root); await assert.rejects(lock(root),{code:'EEXIST'}); await release(); const second=await lock(root); await second();});
test('default plan reads committed main, preserves dirty source, creates no worktree',async t=>{
 const root=await temp(t),repo=path.join(root,'repo'),state=path.join(root,'state'); await fs.mkdir(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'});
 git('init','-b','main'); git('config','user.email','test@example.invalid'); git('config','user.name','test'); await fs.mkdir(path.join(repo,'cli')); await fs.writeFile(path.join(repo,'cli/a'),'committed'); git('add','.'); git('commit','-m','fixture'); await fs.writeFile(path.join(repo,'cli/a'),'dirty');
 const result=await once({repo, enabled: 'true'},state); assert.equal(result.mode,'plan'); assert.equal(result.devices.mac.status,'planned'); assert.equal(await fs.readFile(path.join(repo,'cli/a'),'utf8'),'dirty'); await assert.rejects(fs.access(path.join(state,'sources')));
});
test('stale nonexistent PID lock recovers automatically',async t=>{const root=await temp(t); await fs.writeFile(path.join(root,'coordinator.lock'),'2147483647'); const release=await lock(root); assert.equal(await fs.readFile(path.join(root,'coordinator.lock'),'utf8'),String(process.pid)); await release();});
test('bounded subprocess rejects on timeout',async t=>{ const {run}=await import('./hii-device-auto-update.mjs'); await assert.rejects(run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:30,diagnosticRoot:await temp(t)}),{code:'TIMEOUT'}); });
test('unchanged fingerprint still invalidates a tampered installation',async t=>{
 const root=await temp(t), repo=path.join(root,'repo'), state=path.join(root,'state'); await fs.mkdir(repo); await fs.mkdir(state);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim(); git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','test'); await fs.writeFile(path.join(repo,'Cargo.toml'),'fixture');git('add','.');git('commit','-m','fixture');
 const commit=git('rev-parse','HEAD'), scopeHash=fingerprint(git('ls-tree','-r',commit)); await fs.writeFile(path.join(state,'state.json'),JSON.stringify({observed:commit,observedAt:0,devices:{mac:{status:'verified',commit,scopeHash,verifiedAt:'2000-01-01T00:00:00Z'}}}));
 const result=await once({repo,enabled:true,releaseRoot:path.join(root,'missing-release')},state); assert.equal(result.devices.mac.status,'pending');assert.equal(result.devices.mac.phase,'periodic-installed-verification');assert.equal(result.devices.mac.lastVerified.commit,commit);
});

test('verified Mac release descended from local main is held instead of downgraded',async t=>{
 const root=await temp(t), repo=path.join(root,'repo'), state=path.join(root,'state'), releaseRoot=path.join(root,'releases'); await fs.mkdir(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','test');await fs.writeFile(path.join(repo,'tracked'),'main');git('add','.');git('commit','-m','main');const target=git('rev-parse','HEAD');
 git('switch','-c','local-work');await fs.writeFile(path.join(repo,'tracked'),'local branch release');git('commit','-am','local branch release');const installed=git('rev-parse','HEAD');
 const binary=path.join(releaseRoot,installed,'hii');await fs.mkdir(path.dirname(binary),{recursive:true});await fs.writeFile(binary,'fixture release binary');
 const {createHash}=await import('node:crypto');const binarySha256=createHash('sha256').update(await fs.readFile(binary)).digest('hex');
 await fs.writeFile(path.join(releaseRoot,'current.bin'),`${binary}\n`);await fs.writeFile(path.join(path.dirname(binary),'release.json'),JSON.stringify({commit:installed,sourceCommitVerified:true,releaseBinary:binary,binarySha256}));
 const launcher=path.join(root,'hii');await fs.writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
 const c={repo,enabled:true,debounceSeconds:0,releaseRoot,launcherPath:launcher};
 assert.deepEqual(await markedMacRelease(c),{commit:installed,binarySha256});assert.equal(await isMacReleaseDescendant(repo,target,installed),true);
 const result=await once(c,state);assert.equal(result.devices.mac.status,'held-local-release');assert.equal(result.devices.mac.installedCommit,installed);assert.equal(result.devices.mac.targetCommit,target);await assert.rejects(fs.access(path.join(state,'sources')));
});

test('failed process retains only bounded private diagnostics and safe test names',async t=>{
 const {run}=await import('./hii-device-auto-update.mjs'); const root=await temp(t);let failure;
 try {await run(process.execPath,['-e',"process.stdout.write('x'.repeat(80000)+'\\ntest input::tests::queue ... FAILED\\n');process.stderr.write('failure detail');process.exitCode=2"],{diagnosticRoot:root});}catch(error){failure=error;}
 assert.equal(failure.exitCode,2);assert.deepEqual(failure.failedTests,['input::tests::queue']);const stat=await fs.stat(failure.diagnosticPath);if(process.platform !== 'win32') assert.equal(stat.mode&0o777,0o600);assert.ok(stat.size<=65536);assert.match(failure.diagnosticSha256,/^[a-f0-9]{64}$/);assert.ok((await fs.readFile(failure.diagnosticPath,'utf8')).includes('failure detail'));
});
