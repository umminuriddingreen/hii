import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HII web access gate', () => {
  it('shows only the HII wordmark and the two account links', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain('<span className={styles.wordmark}>hii</span>');
    expect(source).toContain('<a href="#log-in">Log in</a>');
    expect(source).toContain('<a href="#create-account">Create an account</a>');
    expect(source).not.toMatch(/terminal/i);
    expect(source).not.toMatch(/passkey/i);
  });

  it('keeps the website gate separate from the desktop canvas', () => {
    const page = readFileSync('app/page.tsx', 'utf8');

    expect(page).toContain("process.env.NEXT_PUBLIC_HII_TARGET === 'desktop'");
    expect(page).toContain("await import('@/components/workspace/HiiRoot')");
    expect(page).toContain('return <HiiWebAccess />');
  });
});
