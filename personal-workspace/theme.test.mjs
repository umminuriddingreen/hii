import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme } from './public/theme.mjs';

test('explicit theme overrides system and unset or system follows OS', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});
