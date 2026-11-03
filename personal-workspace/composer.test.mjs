import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

async function page(t, responseFactory) {
  const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {url: 'http://localhost', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window;
  w.crypto.randomUUID = () => 'stable-chat-id';
  w.TextDecoder = TextDecoder;
  w.scrollTo = () => {};
  const requests = [];
  w.fetch = async (url, options = {}) => {
    requests.push({url, options});
    if (url === '/api/agent-chat/stable-chat-id') return {ok: true, json: async () => ({messages: []})};
    return responseFactory(url, options);
  };
  const js = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  w.eval(js);
  await new Promise(resolve => setTimeout(resolve, 0));
  return {w, requests};
}

function streamResponse(frames, {complete = true} = {}) {
  const data = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + (complete ? 'data: {"type":"complete","exitCode":0}\n\n' : '');
  let sent = false;
  return {ok: true, body: {getReader: () => ({read: async () => sent ? {done: true} : (sent = true, {done: false, value: new TextEncoder().encode(data)})})}};
}

test('Enter sends, Shift+Enter preserves a newline, and SSE answer renders as text', async t => {
  const {w, requests} = await page(t, (url, options) => url === '/api/agent-chat'
    ? streamResponse([{type: 'queued', position: 1}, {type: 'answer', text: '<reply>'}])
    : ({ok: true, text: async () => ''}));
  const prompt = w.document.querySelector('#prompt');
  prompt.value = 'hello';
  prompt.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  await new Promise(resolve => setTimeout(resolve, 0));
  const send = requests.find(request => request.url === '/api/agent-chat');
  assert.ok(send);
  assert.deepEqual(JSON.parse(send.options.body), {chatId: 'stable-chat-id', goal: 'hello'});
  assert.equal(prompt.value, '');
  assert.equal(w.document.querySelector('#messages .assistant div').textContent, '<reply>');
  assert.equal(w.document.querySelector('#messages .assistant div').children.length, 0);
  const newline = new w.KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true, cancelable: true});
  prompt.value = 'line one';
  prompt.dispatchEvent(newline);
  assert.equal(newline.defaultPrevented, false);
});

test('an interrupted SSE stream is reported without retrying the accepted turn', async t => {
  const {w, requests} = await page(t, (url) => url === '/api/agent-chat'
    ? streamResponse([{type: 'queued', position: 1}], {complete: false})
    : ({ok: true, text: async () => ''}));
  const prompt = w.document.querySelector('#prompt');
  prompt.value = 'work';
  w.document.querySelector('#form').dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.filter(request => request.url === '/api/agent-chat').length, 1);
  assert.match(w.document.querySelector('#status').textContent, /Disconnected/);
});
