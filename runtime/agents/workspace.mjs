import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const dir=()=>process.env.HII_AGENT_REGISTRY_HOME||path.join(os.homedir(),'.hii','agents');
export async function readWorkspace(){try{return JSON.parse(await readFile(path.join(dir(),'workspace.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {schemaVersion:1,revision:0,chats:[],activeId:null};throw e;}}
export async function writeWorkspace(body){
 if(!body||!Number.isInteger(body.expectedRevision)||!Array.isArray(body.chats)||body.chats.length>500)throw Error('Expected revision and up to 500 chats required');
 if(Buffer.byteLength(JSON.stringify(body))>8*1024*1024)throw Error('Workspace exceeds 8 MB');
 const ids=new Set();for(const c of body.chats){if(typeof c.id!=='string'||!c.id||ids.has(c.id)||typeof c.name!=='string'||!Array.isArray(c.messages)||c.messages.length>2000)throw Error('Invalid chat');ids.add(c.id);}
 if(body.activeId&&!ids.has(body.activeId))throw Error('Active chat is missing');
 await mkdir(dir(),{recursive:true,mode:0o700});const lock=path.join(dir(),'workspace.lock');let handle;try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST'){const err=Error('Workspace is being updated; retry');err.status=409;throw err;}throw e;}
 const temp=path.join(dir(),'workspace.'+process.pid+'.tmp');try{const previous=await readWorkspace();if(previous.revision!==body.expectedRevision){const e=Error('Workspace changed in another surface. Reload before saving.');e.status=409;throw e;}const next={schemaVersion:1,revision:previous.revision+1,updatedAt:new Date().toISOString(),chats:body.chats,activeId:body.activeId||null};await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,path.join(dir(),'workspace.json'));return next;}finally{await handle.close();await unlink(lock).catch(()=>{});await unlink(temp).catch(()=>{});}
}
export async function runWorkspaceCommand(args){let result;if(args[0]==='write'){let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>8*1024*1024)throw Error('Input exceeds 8 MB');}result=await writeWorkspace(JSON.parse(input));}else if(!args[0]||args[0]==='read')result=await readWorkspace();else throw Error('usage: hii agents workspace read|write --json (write reads expectedRevision/chats/activeId JSON from stdin)');console.log(JSON.stringify(result,null,2));}
