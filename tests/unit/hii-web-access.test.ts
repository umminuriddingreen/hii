import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HII web access gate', () => {
  it('starts with only the HII wordmark and two account actions', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain('<span className={styles.wordmark}>hii</span>');
    expect(source).toContain("chooseMode('login')");
    expect(source).toContain("chooseMode('signup')");
    expect(source).not.toContain('ShellTerminal');
    expect(source).not.toContain('startTerminalSession');
  });

  it('uses HII passkey APIs and reveals the canvas only for an authenticated session', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain("api<Session>('/api/auth/session')");
    expect(source).toContain("'/api/auth/register/start'");
    expect(source).toContain("'/api/auth/login/start'");
    expect(source).toContain('navigator.credentials.create');
    expect(source).toContain('navigator.credentials.get');
    expect(source).toContain('if (ready && session.authenticated)');
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toContain('type="password"');
  });

  it('opens the canonical HII canvas immediately after authentication', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
    const css = readFileSync('components/auth/HiiWebAccess.module.css', 'utf8');

    expect(source).toContain('surface="space"');
    expect(source).toContain('spaceId={`account:${canvasAccountId}`}');
    expect(source).toContain('creatorId={`account:${canvasAccountId}`}');
    expect(source).toContain('persistence={canvasPersistence}');
    expect(source).toContain('browserSpacePersistence(`account:${canvasAccountId}`)');
    expect(source).toContain('stored only in this browser');
    expect(source).toContain('allowPhoto={false}');
    expect(source).toContain('/^[A-Za-z0-9_-]{43}$/.test(canvasAccountId)');
    expect(source).toContain("setDeviceMessage('could not log out. try again.')");
    expect(source).toContain('open on another device');
    expect(source).toContain('canvas sync is not enabled yet. browser storage may be cleared.');
    expect(source).not.toContain('href="hii://');
    expect(source).not.toContain('the terminal runs natively on your machine');
    expect(source).not.toContain('download for windows');
    expect(css).toContain('.canvasShell :global(.hii-canvas[data-surface="space"])');
    expect(css).toContain('min-height: 44px');

    const canvas = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
    expect(canvas).toContain('{(!isSpace || allowPhoto) && <input');
    expect(canvas).toContain('if (!files.length || (isSpace && !allowPhoto)) return;');
    expect(canvas).toContain('canvasTextSeed(value.slice(0, 100_000))');
  });

  it('receives an opaque account id for account-scoped browser storage', () => {
    const worker = readFileSync('workers/public-site/src/lib.rs', 'utf8');

    expect(worker).toContain('account_id: Option<&\'a str>');
    expect(worker).toContain('SELECT a.id AS account_id, a.handle, s.csrf_token');
    expect(worker).toContain('account_id: Some(&session.account_id)');
  });

  it('keeps the page minimal and scrollable', () => {
    const css = readFileSync('components/auth/HiiWebAccess.module.css', 'utf8');

    expect(css).toContain('--ink: #111');
    expect(css).not.toContain('#0066ff');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('justify-content: center');
    expect(css).not.toContain('#0066ff');
  });

  it('keeps the desktop entry target while using the authenticated web gate', () => {
    const page = readFileSync('app/page.tsx', 'utf8');

    expect(page).toContain("process.env.NEXT_PUBLIC_HII_TARGET === 'desktop'");
    expect(page).toContain("await import('@/components/workspace/HiiRoot')");
    expect(page).toContain('return <HiiWebAccess />');
  });
});
