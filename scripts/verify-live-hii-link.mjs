#!/usr/bin/env node
// Production smoke for one short-lived authenticated HII session.
import WebSocket from 'ws';

const origin = process.env.HII_VERIFY_ORIGIN ?? 'https://humaninformationinterface.com';
const token = process.env.HII_VERIFY_SESSION_TOKEN ?? '';
const hostId = process.env.HII_VERIFY_HOST_ID ?? '';
const mode = process.env.HII_VERIFY_MODE ?? 'both';
if (!token || !hostId) throw new Error('verification_session_and_host_required');
const socketOrigin = origin.replace(/^http/, 'ws');
const options = { headers: { Cookie: `__Host-hii_session=${token}` } };

function viewerProof() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${socketOrigin}/api/remote/view?host=${encodeURIComponent(hostId)}`, options);
    let frames = 0;
    let bytes = 0;
    let selected = '';
    let hello = null;
    let capturedFrames = 0;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`viewer_proof_timeout:${JSON.stringify({ frames, bytes, selected, hello, capturedFrames })}`));
    }, 60_000);
    const finish = () => {
      if (frames < 8 || !hello || !selected || capturedFrames < 1) return;
      clearTimeout(timer);
      socket.close();
      resolve({ frames, bytes, selected, hello, capturedFrames });
    };
    socket.on('message', (data, binary) => {
      if (binary) {
        frames += 1;
        bytes += data.length;
        finish();
        return;
      }
      let value;
      try { value = JSON.parse(data.toString()); } catch { return; }
      if (value.t === 'sources') {
        const source = value.sources?.find((item) => item.bundleIdentifier === 'com.openai.codex');
        if (source && selected !== source.id) {
          selected = source.id;
          socket.send(JSON.stringify({ t: 'source', id: source.id }));
        }
      }
      if (value.t === 'hello' && value.source?.bundleIdentifier === 'com.openai.codex') {
        hello = { application: value.source.application, width: value.screen?.width, height: value.screen?.height };
      }
      if (value.t === 'host-stats') capturedFrames = Number(value.capturedFrames) || 0;
      finish();
    });
    socket.on('error', reject);
  });
}

function chatProof() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${socketOrigin}/api/remote/chat?host=${encodeURIComponent(hostId)}`, options);
    const requestId = crypto.randomUUID();
    let started = false;
    let answer = '';
    const timer = setTimeout(() => { socket.close(); reject(new Error('chat_proof_timeout')); }, 150_000);
    socket.on('message', (data, binary) => {
      if (binary) return;
      let value;
      try { value = JSON.parse(data.toString()); } catch { return; }
      if (value.t === 'chat.room' && value.hostOnline === true && !started) {
        started = true;
        socket.send(JSON.stringify({ t: 'chat.run', requestId, prompt: 'Reply with exactly five words confirming HII Chat is live.', context: [] }));
      }
      if (value.requestId !== requestId) return;
      if (value.t === 'chat.delta') answer += String(value.text ?? '');
      if (value.t === 'chat.error') {
        clearTimeout(timer);
        socket.close();
        reject(new Error(String(value.error ?? 'chat_failed')));
      }
      if (value.t === 'chat.done') {
        clearTimeout(timer);
        socket.close();
        if (!answer.trim()) reject(new Error('chat_returned_no_answer'));
        else resolve({ answerCharacters: answer.trim().length, answerPreview: answer.trim().slice(0, 120) });
      }
    });
    socket.on('error', reject);
  });
}

if (mode === 'viewer') console.log(JSON.stringify({ viewer: await viewerProof() }));
else if (mode === 'chat') console.log(JSON.stringify({ chat: await chatProof() }));
else {
  const [viewer, chat] = await Promise.all([viewerProof(), chatProof()]);
  console.log(JSON.stringify({ viewer, chat }));
}
