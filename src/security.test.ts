import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveAllowedPath } from './security.js';

test('resolveAllowedPath allows descendants of approved roots', () => {
  const root = path.resolve('/tmp/hii-test-root');
  const resolved = resolveAllowedPath(path.join(root, 'notes', 'a.md'), [root]);
  assert.equal(resolved, path.join(root, 'notes', 'a.md'));
});

test('resolveAllowedPath rejects paths outside approved roots', () => {
  const root = path.resolve('/tmp/hii-test-root');
  const resolved = resolveAllowedPath('/etc/passwd', [root]);
  assert.equal(resolved, null);
});
