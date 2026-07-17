import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');

describe('terminal style contract', () => {
  it('loads xterm structural styles before the application stylesheet', () => {
    const xtermStyles = appCss.indexOf("@import '@xterm/xterm/css/xterm.css';");
    const applicationStyles = appCss.indexOf("@import '../app/globals.css';");

    expect(xtermStyles).toBeGreaterThanOrEqual(0);
    expect(xtermStyles).toBeLessThan(applicationStyles);
  });
});
