import {test} from 'node:test';import assert from 'node:assert/strict';import {validate} from './server.mjs';
test('accepts bounded text and durable HII file references',()=>assert.doesNotThrow(()=>validate({device:'hii',model:'vision',messages:[{role:'user',content:'Describe',attachments:['a'.repeat(64)]}]})));
test('rejects arbitrary routing and raw image payloads',()=>{assert.throws(()=>validate({device:'http://evil',model:'x',messages:[]}));assert.throws(()=>validate({device:'hii',model:'x',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'http://evil/image'}}]}]}));assert.throws(()=>validate({device:'hii',model:'x',messages:[{role:'user',content:'hi',attachments:['../../private']}]}));});

test('accepts configured PC HII route',()=>assert.doesNotThrow(()=>validate({device:'hii-pc',model:'vision',messages:[{role:'user',content:'Describe',attachments:['a'.repeat(64)]}]})));
