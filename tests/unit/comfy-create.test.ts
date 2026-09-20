import { describe, expect, it } from 'vitest';
import { buildZImagePrompt, compileCanvasContext, HII_COMFY_LOCAL_URL } from '../../lib/web/comfy-create';
import type { WorkspaceNode } from '../../lib/workspace/types';

describe('HII canvas to local ComfyUI', () => {
  it('compiles only explicit selected objects into bounded text context', () => {
    const nodes = [{ id: 'n1', type: 'canvas-text', payload: { title: 'Courtyard', text: 'Filtered daylight and brick' } }] as WorkspaceNode[];
    expect(compileCanvasContext(nodes)).toBe('canvas-text: Courtyard | Filtered daylight and brick');
    expect(compileCanvasContext([])).toBe('');
  });

  it('builds the installed local Z-Image workflow without cloud endpoints', () => {
    const workflow = buildZImagePrompt('courtyard study', 42);
    expect(HII_COMFY_LOCAL_URL).toBe('http://127.0.0.1:8189');
    expect(workflow['4'].inputs.text).toBe('courtyard study');
    expect(workflow['7'].inputs.seed).toBe(42);
    expect(workflow['10'].class_type).toBe('SaveImage');
    expect(JSON.stringify(workflow)).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });
});
