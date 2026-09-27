import {test} from 'node:test';import assert from 'node:assert/strict';import {projectChatObjects} from './public/objects.mjs';
test('streaming updates one text object; shared assets retain identity and placement',()=>{
 const chat={id:'chat',messages:[{role:'assistant',content:'Hi',generating:true,attachments:[{id:'file',name:'notes.txt'}]}]};
 const first=projectChatObjects(chat,'2026-01-01');assert.equal(first.length,2);assert.equal(first[0].type,'text');first[0].x=900;
 chat.messages[0].content='Hi there';chat.messages[0].generating=false;chat.messages.push({role:'user',content:'Read this',attachments:[{id:'file',name:'notes.txt'}]});
 const next=projectChatObjects(chat,'2026-01-02');assert.equal(next.length,3);assert.equal(next[0].id,first[0].id);assert.equal(next[0].x,900);assert.equal(next[0].payload.text,'Hi there');assert.equal(next[0].payload.generating,false);
});
test('ready attachments become objects before a message is sent',()=>{
 const c={id:'chat',messages:[],files:[{id:'photo',mimeType:'image/png',name:'photo.png'},{pending:true,name:'upload'}]};assert.equal(projectChatObjects(c).length,1);assert.equal(c.objects[0].type,'image');
});
