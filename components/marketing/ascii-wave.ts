const WIDTH = 58;
const HEIGHT = 17;
const EDGE_GLYPHS = ['.', ':', '-', '~', '=', '+'];

function near(value: number, target: number) {
  return Math.abs(value - target) < 0.72;
}

/** A deterministic frame so the animation can be verified without a live browser. */
export function asciiWaveFrame(phase: number) {
  const rows = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => ' '));

  for (let x = 2; x < WIDTH - 2; x += 1) {
    const top = 3.2 + Math.sin(x * 0.23 + phase) * 1.5;
    const bottom = HEIGHT - 4.2 + Math.sin(x * 0.19 + phase + 1.7) * 1.35;
    const glyph = EDGE_GLYPHS[(x + Math.floor(phase * 3)) % EDGE_GLYPHS.length];
    for (let y = 1; y < HEIGHT - 1; y += 1) {
      if (near(y, top) || near(y, bottom)) rows[y][x] = glyph;
    }
  }

  for (let y = 3; y < HEIGHT - 3; y += 1) {
    const left = 3.4 + Math.sin(y * 0.63 + phase * 1.2) * 1.35;
    const right = WIDTH - 4.4 + Math.sin(y * 0.57 + phase * 1.2 + 2.1) * 1.35;
    for (let x = 1; x < WIDTH - 1; x += 1) {
      if (near(x, left)) rows[y][x] = '/';
      if (near(x, right)) rows[y][x] = '\\';
    }
  }

  const signalX = 9 + Math.floor(((Math.sin(phase * 0.72) + 1) / 2) * (WIDTH - 19));
  const signalY = Math.max(5, Math.min(HEIGHT - 6, Math.round(HEIGHT / 2 + Math.sin(phase) * 2)));
  rows[signalY][signalX] = 'o';
  rows[signalY][signalX + 1] = '.';
  rows[signalY][signalX + 2] = '.';

  return rows.map((row) => row.join('').replace(/\s+$/u, '')).join('\n');
}
