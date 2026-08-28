import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HII web access gate', () => {
  it('starts with only the HII wordmark and two account actions', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain('<span className={styles.wordmark}>hii</span>');
    expect(source).toContain("chooseMode('login')");
    expect(source).toContain("chooseMode('signup')");
    expect(source).not.toContain('HiiRoot');
    expect(source).not.toContain('ShellTerminal');
    expect(source).not.toContain('startTerminalSession');
  });

  it('uses HII passkey APIs and reveals instructions only for an authenticated session', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain("api<Session>('/api/auth/session')");
    expect(source).toContain("'/api/auth/register/start'");
    expect(source).toContain("'/api/auth/login/start'");
    expect(source).toContain('navigator.credentials.create');
    expect(source).toContain('navigator.credentials.get');
    expect(source).toContain('ready && session.authenticated ?');
    expect(source).toContain('href="/download/windows"');
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toContain('type="password"');
  });

  it('keeps the page minimal and scrollable', () => {
    const css = readFileSync('components/auth/HiiWebAccess.module.css', 'utf8');

    expect(css).toContain('--ink: #111');
    expect(css).not.toContain('#0066ff');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('justify-content: center');
    expect(css).not.toContain('border-radius');
  });

  it('keeps the website gate separate from the desktop canvas', () => {
    const page = readFileSync('app/page.tsx', 'utf8');

    expect(page).toContain("process.env.NEXT_PUBLIC_HII_TARGET === 'desktop'");
    expect(page).toContain("await import('@/components/workspace/HiiRoot')");
    expect(page).toContain('return <HiiWebAccess />');
  });
});
