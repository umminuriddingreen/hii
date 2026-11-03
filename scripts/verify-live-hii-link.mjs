#!/usr/bin/env node
// Production smoke for one short-lived authenticated HII session.
import WebSocket from 'ws';

const origin = process.env.HII_VERIFY_ORIGIN ?? 'https://humaninformationinterface.com';
const token = process.env.HII_VERIFY_SESSION_TOKEN ?? '';
const hostId = process.env.HII_VERIFY_HOST_ID ?? '';
if (!token || !hostId) throw new Error('verification_session_and_host_required');
const socketOrigin = origin.replace(/^http/, 'ws');
const options = { headers: { Cookie: `__Host-hii_session=${token}` } };

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

console.log(JSON.stringify({ chat: await chatProof() }));
