import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allowed} from './protocol.mjs';
test('bridge permits only bounded HII application routes',()=>{
 for(const [method,path] of [['GET','/api/workspace'],['POST','/api/chat'],['GET','/api/sessions/codex:session-123'],['POST','/api/files'],['POST','/api/agent-chat/chat_1/stop']])assert.equal(allowed(method,path),true);
 for(const [method,path] of [['GET','/'],['POST','/api/auth/login'],['DELETE','/api/workspace'],['GET','http://evil.test/api/workspace'],['GET','/api/sessions/../../etc/passwd'],['GET','/api/sessions/%2e%2e'],['GET','/api/workspace?url=http://evil.test'],['POST','/api/runs/something/stop']])assert.equal(allowed(method,path),false,method+' '+path);
});
