import {test} from 'node:test';import assert from 'node:assert/strict';import {server} from './server.mjs';

test('white composer is served at root and terminal alias with same-origin assets',async()=>{
 const request=async (url,method='GET')=>{
  const req={url,method,headers:{host:'localhost'},async *[Symbol.asyncIterator](){}};
  const response={status:200,headers:{},headersSent:false,body:'',setHeader(name,value){this.headers[name]=value;},writeHead(status,headers={}){this.status=status;Object.assign(this.headers,headers);this.headersSent=true;},end(value=''){this.body+=value;this.writableEnded=true;}};
  await server.listeners('request')[0](req,response);return response;
 };
 const chat=await request('/api/agent-chat/api-surface-probe');
 assert.equal(chat.status,200);assert.deepEqual(JSON.parse(chat.body),{id:'api-surface-probe',messages:[],memory:'',compacted:0,turns:[]});
 const home=await request('/');assert.equal(home.status,200);assert.match(home.body,/textarea id="prompt"/);assert.match(home.headers['Content-Security-Policy'],/default-src 'self'/);
 const terminal=await request('/terminal');assert.equal(terminal.status,200);assert.equal(terminal.body,home.body);
 const app=await request('/app.js');assert.equal(app.status,200);assert.match(app.body,/event\.key === 'Enter'/);
 const css=await request('/style.css');assert.equal(css.status,200);assert.match(css.body,/background: #fff/);
 const oldChat=await request('/api/chat','POST');assert.equal(oldChat.status,405);
});
