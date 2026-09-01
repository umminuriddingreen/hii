import { describe, expect, it } from 'vitest';
import { historyShortcut } from '../../lib/workspace/history-shortcut';

const key = (value: string, shiftKey = false) => ({ key: value, metaKey: true, ctrlKey: false, altKey: false, shiftKey });

describe('workspace history shortcuts', () => {
  it('maps Command-braces and their physical bracket equivalents', () => {
    expect(historyShortcut(key('{', true))).toBe('undo');
    expect(historyShortcut(key('}', true))).toBe('redo');
    expect(historyShortcut(key('['))).toBe('undo');
    expect(historyShortcut(key(']'))).toBe('redo');
  });

  it('keeps standard undo and redo', () => {
    expect(historyShortcut(key('z'))).toBe('undo');
    expect(historyShortcut(key('Z', true))).toBe('redo');
  });
});
