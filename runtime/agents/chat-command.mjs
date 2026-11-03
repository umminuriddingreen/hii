export async function chatCommand(args){
 const [command,id,...rest]=args;const base='http://127.0.0.1:4188/api/agent-chat';
 if(!['show','send','stop','compact','helper'].includes(command)||!id)throw Error('Usage: hii agents chat show|stop|compact|send|helper CHAT_ID [--model MODEL] TASK');
 let url=base+'/'+encodeURIComponent(id),options={};
 if(command==='stop'){url+='/stop';options.method='POST';}
 if(['send','helper','compact'].includes(command)){const mi=rest.indexOf('--model');let model;if(mi>=0){model=rest[mi+1];rest.splice(mi,2);}if(!model){const r=await fetch('http://127.0.0.1:4188/api/devices');const devices=await r.json();model=devices.find(d=>d.id==='hii')?.models?.[0];}url=base;options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId:id,model,device:'hii',goal:command==='compact'?'Compact our working memory and report what you remember.':(command==='helper'?'/agent ':'')+rest.join(' '),compact:command==='compact'})};}
 const response=await fetch(url,options);if(!response.ok)throw Error(await response.text());for await(const chunk of response.body)process.stdout.write(Buffer.from(chunk));
}
