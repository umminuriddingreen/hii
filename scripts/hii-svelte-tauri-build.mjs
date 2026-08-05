#!/usr/bin/env node
import { access, chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'build');
const portable = path.join(root, '.hii-app');
const server = path.join(portable, 'server');
const runtime = path.join(portable, 'bin');
await rm(output,{recursive:true,force:true}); await rm(portable,{recursive:true,force:true});
const build=spawnSync('npm',['exec','--','vite','build'],{cwd:root,stdio:'inherit',env:{...process.env,HII_TARGET:'desktop',HII_TAURI:'1'}}); if(build.status!==0)process.exit(build.status??1);
try{await access(path.join(output,'handler.js'));await access(path.join(output,'client','brand','hii-wordmark.svg'))}catch{console.error('Missing SvelteKit adapter-node output or public brand assets.');process.exit(1)}
await mkdir(server,{recursive:true});
await cp(output,path.join(server,'build'),{recursive:true,force:true,verbatimSymlinks:true});
await cp(path.join(root,'server.mjs'),path.join(server,'server.mjs'),{force:true});
await cp(path.join(root,'server'),path.join(server,'server'),{recursive:true,force:true});
await mkdir(path.join(server,'node_modules'),{recursive:true});
for(const dependency of ['ws','node-pty','yaml']) await cp(path.join(root,'node_modules',dependency),path.join(server,'node_modules',dependency),{recursive:true,force:true,verbatimSymlinks:true});
await mkdir(path.join(server,'aii','capabilities'),{recursive:true});
await cp(path.join(root,'aii','capabilities','registry.json'),path.join(server,'aii','capabilities','registry.json'),{force:true});
await cp(path.join(root,'aii','daemon'),path.join(server,'aii','daemon'),{recursive:true,force:true,verbatimSymlinks:true});
await writeFile(path.join(server,'package.json'),'{"type":"module"}\n','utf8');

async function volta(){const base=path.join(os.homedir(),'.volta','tools','image','node');try{return(await readdir(base)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(v=>path.join(base,v,'bin','node'))}catch{return[]}}
function works(candidate){const probe=spawnSync(candidate,['-e',"require('node:sqlite');process.stdout.write(process.arch)"],{encoding:'utf8'});if(probe.status!==0||probe.stdout.trim()!==process.arch)return false;if(process.platform==='darwin'){const links=spawnSync('otool',['-L',candidate],{encoding:'utf8'});if(links.status!==0||/@rpath\/libnode|\/opt\/homebrew\//.test(links.stdout))return false}return true}
const node=[process.env.HII_NODE_RUNTIME,...await volta(),'/opt/homebrew/opt/node/bin/node','/usr/local/bin/node',process.execPath].filter(Boolean).find(works);if(!node){console.error('No portable Node runtime with node:sqlite support was found.');process.exit(1)}
const nodeName=process.platform==='win32'?'node.exe':'node';
await mkdir(runtime,{recursive:true});await cp(node,path.join(runtime,nodeName),{force:true});await chmod(path.join(runtime,nodeName),0o755);await chmod(path.join(server,'node_modules','node-pty','prebuilds','darwin-arm64','spawn-helper'),0o755).catch(()=>{});
console.log(`hii Svelte portable runtime: ${node}`);console.log(`hii app resources: ${path.relative(root,portable)}`);
