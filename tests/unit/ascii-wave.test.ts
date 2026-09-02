import { describe, expect, it } from 'vitest';
import { asciiWaveFrame } from '../../components/marketing/ascii-wave';

describe('HII ASCII wave', () => {
  it('moves while remaining deterministic and ASCII-only', () => {
    const first = asciiWaveFrame(0);
    const replay = asciiWaveFrame(0);
    const next = asciiWaveFrame(0.17);

    expect(first).toBe(replay);
    expect(next).not.toBe(first);
    expect(first.split('\n')).toHaveLength(17);
    expect([...first].every((character) => character === '\n' || character.charCodeAt(0) < 128)).toBe(true);
  });
});
