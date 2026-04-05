import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleCursor } from './menu.js';
import { cycleSlashCursor } from './slash-menu.js';

test('cycleCursor wraps forward and backward', () => {
  assert.equal(cycleCursor(5, 0, 1), 1);
  assert.equal(cycleCursor(5, 4, 1), 0);
  assert.equal(cycleCursor(5, 0, -1), 4);
});

test('cycleCursor is safe for empty menus', () => {
  assert.equal(cycleCursor(0, 0, 1), 0);
  assert.equal(cycleCursor(0, 3, -1), 0);
});

test('cycleSlashCursor wraps forward and backward', () => {
  assert.equal(cycleSlashCursor(3, 0, 1), 1);
  assert.equal(cycleSlashCursor(3, 2, 1), 0);
  assert.equal(cycleSlashCursor(3, 0, -1), 2);
});

test('cycleSlashCursor is safe for empty slash menus', () => {
  assert.equal(cycleSlashCursor(0, 0, 1), 0);
});
