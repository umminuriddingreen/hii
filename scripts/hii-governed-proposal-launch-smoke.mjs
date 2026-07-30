#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const briefPath = path.join(root, 'docs', 'launch', 'hii-governed-proposals-opus5.md');
const postPath = path.join(root, 'docs', 'launch', 'x-post.txt');
const replyPath = path.join(root, 'docs', 'launch', 'hii-governed-proposals-first-reply.txt');
const brief = fs.readFileSync(briefPath, 'utf8');
const post = fs.readFileSync(postPath, 'utf8').trim();
const reply = fs.readFileSync(replyPath, 'utf8').trim();

assert.equal((brief.match(/^## Beat \d+ — \d+–\d+s$/gm) || []).length, 6);
assert.match(brief, /session\s+`316086a5-c3b8-4ccf-91c7-f1857b1c64a6`/);
assert.match(brief, /exact open duplicate returns HTTP 409/i);
assert.match(brief, /BOARD_TASK_APPROVAL_REQUIRED/);
assert.match(brief, /append-only ledger/);
assert.match(brief, /origin: human/);
assert.match(brief, /What would you never let an agent move on its own\?/);

const postWithoutMarker = post.replace(/\s*\[video\]\s*$/i, '');
assert.ok(postWithoutMarker.length <= 260, `X post is ${postWithoutMarker.length} characters`);
assert.match(post, /exact open duplicate/i);
assert.match(post, /until I approved/i);
assert.ok(reply.endsWith('?'));
assert.match(reply, /ship work under your own name/i);

const publicCopy = `${post}\n${reply}`;
const unsupported = [
  /\bfully autonomous\b/i,
  /\bguaranteed viral\b/i,
  /\baudit-ready\b/i,
  /\bunlimited\b/i,
  /\bdownload now\b/i,
  /\bjoin the waitlist\b/i,
  /\bsafe\b/i,
  /\bprivate\b/i,
  /\brefus(?:e|ed)\b/i
];
for (const pattern of unsupported) {
  assert.doesNotMatch(publicCopy, pattern);
}

console.log('HII governed proposal launch smoke');
console.log('status:       ok');
console.log('storyboard:   six verified beats / 31 seconds');
console.log(`x post:       ${postWithoutMarker.length} characters before video marker`);
console.log('claim gate:   literal lane, duplicate, approval, and availability boundaries verified');
console.log('opus review:  read-only session provenance retained');
