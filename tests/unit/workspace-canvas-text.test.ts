import { describe, expect, it } from 'vitest';
import { canvasTextSeed, canvasTextSize, clipboardFiles, defaultSize } from '../../lib/workspace/ingest';

describe('canvas text sizing', () => {
  it('keeps the default size for a short line', () => {
    expect(canvasTextSize('hello')).toEqual(defaultSize['canvas-text']);
  });

  it('grows with wrapped lines so long text is not hidden', () => {
    const short = canvasTextSize('a');
    const long = canvasTextSize('word '.repeat(120));

    expect(long.h).toBeGreaterThan(short.h);
    expect(long.w).toBe(short.w);
  });

  it('grows with explicit newlines', () => {
    expect(canvasTextSize('a\nb\nc\nd\ne\nf\ng\nh').h).toBeGreaterThan(defaultSize['canvas-text'].h);
  });

  it('never exceeds the height ceiling', () => {
    expect(canvasTextSize('line\n'.repeat(5000)).h).toBe(720);
  });
});

describe('canvasTextSeed', () => {
  it('creates an empty text object for a double-click', () => {
    const seed = canvasTextSeed();

    expect(seed.type).toBe('canvas-text');
    expect(seed.payload.text).toBe('');
  });

  it('carries the first typed character so no keystroke is lost', () => {
    expect(canvasTextSeed('h').payload.text).toBe('h');
  });

  it('is already tall enough for the text it was seeded with', () => {
    const value = 'word '.repeat(200);
    expect(canvasTextSeed(value).h).toBe(canvasTextSize(value).h);
  });
});

describe('clipboardFiles', () => {
  const file = new File(['x'], 'pasted.png', { type: 'image/png' });

  it('reads a pasted image from files', () => {
    expect(clipboardFiles({ files: [file], items: [] } as unknown as DataTransfer)).toEqual([file]);
  });

  it('falls back to items when files is empty, as Safari reports it', () => {
    const transfer = {
      files: [],
      items: [{ kind: 'file', getAsFile: () => file }]
    } as unknown as DataTransfer;

    expect(clipboardFiles(transfer)).toEqual([file]);
  });

  it('ignores plain-text clipboard entries', () => {
    const transfer = {
      files: [],
      items: [{ kind: 'string', getAsFile: () => null }]
    } as unknown as DataTransfer;

    expect(clipboardFiles(transfer)).toEqual([]);
  });

  it('tolerates a clipboard with no items at all', () => {
    expect(clipboardFiles({ files: [] } as unknown as DataTransfer)).toEqual([]);
  });
});
