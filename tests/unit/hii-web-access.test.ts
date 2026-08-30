import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HII web access gate', () => {
  it('opens loopback as the bounded local owner without pretending to run a passkey ceremony', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain("normalized === '127.0.0.1'");
    expect(source).toContain("normalized === 'localhost'");
    expect(source).toContain("handle: 'local owner'");
    expect(source).toContain('const localSession = localOwnerSession(window.location.hostname)');
    expect(source).toContain('if (localSession)');
  });

  it('starts with the HII wordmark and two account actions before the below-fold support board', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain('<span className={styles.wordmark}>hii</span>');
    expect(source).toContain("chooseMode('login')");
    expect(source).toContain("chooseMode('signup')");
    expect(source).not.toContain('ShellTerminal');
    expect(source).not.toContain('startTerminalSession');
    expect(source).toContain('brand the Mac that builds HII.');
    expect(source).toContain('no bid or payment is taken here');
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

  it('accepts an identity-bound HII Network session before the hosted account adapter', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain("fetch('/hii/network/session'");
    expect(source).toContain("credentials: 'same-origin'");
    expect(source).toContain('networkSession ?? api<Session>');
    expect(source).not.toContain("normalized.endsWith('.local')");
  });

  it('opens the canonical HII canvas immediately after authentication', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
    const css = readFileSync('components/auth/HiiWebAccess.module.css', 'utf8');
    const globalCss = readFileSync('app/globals.css', 'utf8');

    expect(source).toContain('surface="account"');
    expect(source).toContain('spaceId={`account:${canvasAccountId}`}');
    expect(source).toContain('creatorId={`account:${canvasAccountId}`}');
    expect(source).toContain('persistence={canvasPersistence}');
    expect(source).toContain('browserSpacePersistence(`account:${canvasAccountId}`');
    expect(source).toContain('hydrateBrowserCanvasAssets(canvasAccountId, document)');
    expect(source).toContain('fileSeeder={canvasFileSeeder}');
    expect(source).toContain("onRequestDevice={() => setPanel('models')}");
    expect(source).toContain('stored only in this browser');
    expect(source).toContain('allowPhoto');
    expect(source).toContain('/^[A-Za-z0-9_-]{43}$/.test(canvasAccountId)');
    expect(source).toContain("setDeviceMessage('could not log out. try again.')");
    expect(source).toContain('open on Mac');
    expect(source).toContain('href="/download#mac"');
    expect(source).toContain('open on Windows');
    expect(source).toContain('href="/download#windows"');
    expect(source).toContain('auto-synced local copies planned');
    expect(source).toContain('this browser account stays canonical');
    expect(source).toContain('sync is not enabled yet');
    expect(source).not.toContain('aria-label="HII canvas views"');
    expect(source).not.toContain('>chat</button>');
    expect(source).not.toContain('>feed</button>');
    expect(source).not.toContain('>models</button>');
    expect(source).not.toContain('href="hii://');
    expect(source).not.toContain('the terminal runs natively on your machine');
    expect(css).toContain('.canvasShell :global(.hii-canvas[data-surface="account"])');
    expect(css).toContain('min-height: 44px');

    const canvas = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
    expect(canvas).toContain('{(!isSpace || allowPhoto) && <input');
    expect(canvas).toContain('if (!files.length || (isSpace && !allowPhoto)) return;');
    expect(canvas).toContain('canvasTextSeed(value.slice(0, 100_000))');
    expect(canvas).toContain("surface?: 'workspace' | 'space' | 'account'");
    expect(canvas).toContain('{isTouchCanvas && <SpaceToolbar');
    expect(canvas).toContain('accountTools={isAccount}');
    const toolbar = readFileSync('components/spaces/SpaceToolbar.tsx', 'utf8');
    expect(toolbar).toContain('hii-canvas-command-trigger');
    expect(toolbar).toContain('hii-canvas-touch-tools');
    expect(toolbar).toContain('<span>commands</span><kbd>?</kbd>');
    expect(toolbar).toContain('<dt>space</dt><dd>device terminal</dd>');
    expect(toolbar).toContain('<dt>n</dt><dd>note</dd>');
    expect(toolbar).toContain('onAddNote');
    expect(canvas).toContain('isAccount && isTerminalShortcut(event)');
    expect(canvas).toContain("event.key.toLowerCase() === 'u'");
    expect(canvas).toContain("event.key.toLowerCase() === 't'");
    expect(canvas).toContain("event.key.toLowerCase() === 'd'");
    expect(canvas).toContain("event.key.toLowerCase() === 'n'");
    expect(canvas).toContain("event.key === '0'");
    expect(canvas).toContain("event.key === '?'");
    expect(canvas).toContain('commandsOpen={isAccount ? canvasCommandsOpen : undefined}');
    expect(canvas).toContain('fileSeeder ? fileSeeder(files) : seedsFromFiles(files)');
    expect(globalCss).toContain('.hii-space-toolbar[data-account-tools="true"] .hii-canvas-command-trigger');
    expect(globalCss).toContain('.hii-space-toolbar[data-account-tools="true"] .hii-canvas-touch-tools');
  });

  it('keeps imported canvas assets local to the authenticated browser device', () => {
    const source = readFileSync('lib/web/canvas-assets.ts', 'utf8');

    expect(source).toContain("const DATABASE = 'hii-web-canvas-assets-v1'");
    expect(source).toContain('file.size > MAX_FILE_BYTES');
    expect(source).toContain('files.length > MAX_BATCH_FILES');
    expect(source).toContain('MAX_BATCH_BYTES');
    expect(source).toContain("seedFromFile(file, { store: false })");
    expect(source).toContain('database.transaction(STORE, \'readwrite\')');
    expect(source).toContain('indexeddb:${asset.id}');
    expect(source).toContain("crypto.subtle.digest('SHA-256'");
    expect(source).not.toContain('fetch(');
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

  it('routes platform handoffs to a truthful planned Tauri download page', () => {
    const download = readFileSync('app/download/page.tsx', 'utf8');

    expect(download).toContain('Tauri desktop app for Mac and Windows');
    expect(download).toContain('browser account remains the canonical data source');
    expect(download).toContain('automatically synchronized local copy');
    expect(download).toContain('id="mac"');
    expect(download).toContain('id="windows"');
    expect(download).toContain('Windows Tauri build is planned');
  });
});
