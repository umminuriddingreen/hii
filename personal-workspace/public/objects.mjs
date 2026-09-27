// HII WorkspaceNode projections. Chat order and spatial placement share stable IDs.
export function projectChatObjects(chat, now=new Date().toISOString()) {
 const old=new Map((chat.objects||[]).map(n=>[n.id,n]));const nodes=[];
 const put=(id,type,payload,source)=>{const previous=old.get(id);nodes.push({id,type,x:previous?.x??(nodes.length%3)*400,y:previous?.y??Math.floor(nodes.length/3)*300,w:previous?.w??360,h:previous?.h??240,z:previous?.z??nodes.length+1,createdAt:previous?.createdAt??now,updatedAt:JSON.stringify(previous?.payload)===JSON.stringify(payload)?previous.updatedAt:now,objectRef:{authority:'hii-runtime',id:source,kind:type},payload});};
 const assets=new Set();
 const asset=(f,messageId)=>{const source=f.id||f.url;if(!source||assets.has(source)||f.pending)return;assets.add(source);const image=!!f.url||String(f.mimeType||f.mime||f.type||'').startsWith('image/');put('asset:'+source,image?'image':'file',{title:f.name||'Generated image',name:f.name||'Generated image',src:f.url||f.previewUrl||'',path:f.url||'/api/files/'+f.id,attachmentId:f.id,chatId:chat.id,messageId},source);};
 for(const [index,m] of (chat.messages||[]).entries()) {
  // Legacy IDs are deterministic so two clients migrating the same chat agree.
  m.id||=chat.id+':message:'+index;
  const text=typeof m.content==='string'?m.content:(m.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
  put(m.id,'text',{text,title:m.role==='assistant'?'Response':'Message',role:m.role,chatId:chat.id,generating:!!m.generating},m.id);
  for(const f of [...(m.attachments||[]),...(m.images||[])])asset(f,m.id);
 }
 for(const f of chat.files||[])asset(f,null);
 chat.objects=nodes;return nodes;
}
