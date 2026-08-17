import { describe, expect, it } from 'vitest';
import { canMutateCanvas, canvasMode, canvasModes, modeIntent, nextCanvasMode, type CanvasModeId } from '../../lib/workspace/canvas-modes';

describe('canvas interaction modes', () => {
  it('cycles through every mode and returns to build', () => {
    let current: CanvasModeId = 'build';
    const visited = [current];
    for (let index = 0; index < canvasModes.length; index += 1) {
      current = nextCanvasMode(current);
      visited.push(current);
    }
    expect(visited).toEqual(['build', 'plan', 'browse', 'see', 'show', 'build']);
  });

  it('keeps observation modes read-only', () => {
    expect(canvasMode('plan').authority).toBe('read-only');
    expect(canvasMode('browse').authority).toBe('read-only');
    expect(canvasMode('see').authority).toBe('read-only');
    expect(canvasMode('build').authority).toBe('workspace');
    expect(canvasMode('show').authority).toBe('workspace');
    expect(canMutateCanvas('plan')).toBe(false);
    expect(canMutateCanvas('browse')).toBe(false);
    expect(canMutateCanvas('see')).toBe(false);
    expect(canMutateCanvas('build')).toBe(true);
    expect(canMutateCanvas('show')).toBe(true);
  });

  it('makes browse mode explicitly use SearxNG and preserve links', () => {
    const prompt = modeIntent('browse', 'find visual references');
    expect(prompt).toContain('local SearxNG');
    expect(prompt).toContain('web_fetch');
    expect(prompt).toContain('Keep source URLs visible');
  });
});
