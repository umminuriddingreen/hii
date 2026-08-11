#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TOKEN_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['GitHub token', /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['OpenAI-style key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ['Supabase service-role JWT', /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g]
];

const ASSIGNMENT_PATTERN = /\b(?:SERVICE_ROLE_KEY|SECRET_ACCESS_KEY|API_SECRET|CLIENT_SECRET|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN)\s*[:=]\s*["']?([^\s"'#,}]{16,})/gi;
const PLACEHOLDER_PATTERN = /^(?:example|placeholder|replace[_-]?me|your[_-]|test[_-]|dummy|xxx|<|\$\{)/i;

function findingsForText(text) {
  const findings = [];
  for (const [label, pattern] of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ label, index: match.index });
  }
  ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
    if (!PLACEHOLDER_PATTERN.test(match[1])) findings.push({ label: 'sensitive assignment', index: match.index });
  }
  return findings;
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function selfTest() {
  assert.equal(findingsForText('SUPABASE_SERVICE_ROLE_KEY=your_service_role_key').length, 0);
  assert.equal(findingsForText('API_SECRET=replace_me').length, 0);
  assert.equal(findingsForText('API_SECRET=real-looking-secret-value-1234').length, 1);
  assert.equal(findingsForText('-----BEGIN PRIVATE KEY-----').length, 1);
  assert.equal(findingsForText('token = github_pat_' + 'A'.repeat(50)).length, 1);
}

selfTest();

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const findings = [];

for (const file of tracked) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue;
  for (const finding of findingsForText(content)) {
    findings.push(`${file}:${lineAt(content, finding.index)} ${finding.label}`);
  }
}

if (findings.length) {
  console.error('Potential secrets found in tracked files:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${tracked.length} tracked files; scanner self-test passed).`);
}
