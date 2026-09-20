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

  it('offers both account paths and a guest canvas from the product site', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    // The explicit product site remains available to signed-in visitors too.
    expect(source).toContain('<ProsumerLanding');
    expect(source).toContain("onLogin={() => session.authenticated ? setProductSite(false) : chooseMode('login')}");
    expect(source).toContain("onCreateAccount={() => session.authenticated ? setProductSite(false) : chooseMode('signup')}");
    expect(source).toContain('<a href="/">try the canvas</a>');
    expect(source).not.toContain('<HiiFirstRunTerminal');

    // A public, unauthenticated page must never reach a shell.
    expect(source).not.toContain('ShellTerminal');
    expect(source).not.toContain('startTerminalSession');
  });

  it('defines every style class the access surface references', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
    const css = readFileSync('components/auth/HiiWebAccess.module.css', 'utf8');

    // A CSS module hands back `undefined` for a class it does not define, so a
    // section can render completely unstyled while typechecking and rendering
    // without error. This caught the landing shipping with none of its own
    // styles; it is the only signal that failure produces.
    const referenced = [...source.matchAll(/\bstyles\.([A-Za-z][\w]*)/g)].map((match) => match[1]);
    const defined = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1]));

    expect(referenced.length).toBeGreaterThan(0);
    expect([...new Set(referenced)].filter((name) => !defined.has(name))).toEqual([]);
  });

  it('uses HII passkey APIs for the account canvas while preserving the product site', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain("api<Session>('/api/auth/session')");
    expect(source).toContain("'/api/auth/register/start'");
    expect(source).toContain("'/api/auth/login/start'");
    expect(source).toContain('navigator.credentials.create');
    expect(source).toContain('navigator.credentials.get');
    expect(source).toContain('if (ready && session.authenticated && !browserOnly && !productSite)');
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toContain('type="password"');
  });

  it('accepts an identity-bound HII Network session before the hosted account adapter', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');

    expect(source).toContain("fetch('/hii/network/session'");
    expect(source).toContain("credentials: 'same-origin'");
    expect(source).toContain("source: 'network' as const");
    expect(source).toContain("source: 'account' as const");
    expect(source).not.toContain("normalized.endsWith('.local')");
  });

  it('opens the canonical HII canvas immediately after authentication', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
    const css = readFileSync('components/auth/HiiWebAccess.module.css', 'utf8');
    const globalCss = readFileSync('app/globals.css', 'utf8');

    expect(source).toContain('surface="account"');
    expect(source).toContain('spaceId={canvasSpaceId}');
    expect(source).toContain('creatorId={`account:${canvasAccountId}`}');
    expect(source).toContain('persistence={canvasPersistence}');
    expect(source).toContain(': browserSpacePersistence(');
    expect(source).toContain('`account:${canvasAccountId}`');
    expect(source).toContain('hydrateBrowserCanvasAssets(canvasAccountId, document)');
    expect(source).toContain('fileSeeder={canvasFileSeeder}');
    expect(source).toContain('persistentChrome={false}');
    expect(source).toContain("event.code !== 'Digit1'");
    expect(source).toContain("onRequestDevice={() => setPanel('models')}");
    // The panel must distinguish synchronized from device-local storage. The
    // wording is editorial; the distinction is the contract.
    expect(source).toMatch(/accountSync \? '[^']+' : 'stored on this device'/);
    expect(source).toContain('allowPhoto');
    expect(source).toContain('/^[A-Za-z0-9_-]{43}$/.test(canvasAccountId)');
    expect(source).toContain("setDeviceMessage('could not log out. try again.')");
    expect(source).toContain('HII for Mac');
    expect(source).toContain('href="/download#mac"');
    expect(source).toContain('HII for Windows');
    expect(source).toContain('href="/download#windows"');
    // The panel must state the computer's connection posture; the wording is editorial.
    expect(source).toMatch(/<dt>computer<\/dt><dd>[^<]+<\/dd>/);
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
    expect(toolbar).toContain('aria-label="Canvas commands"');
    expect(toolbar).toContain('<span aria-hidden="true">?</span>');
    expect(toolbar).not.toContain("accountTools ? 'hii canvas' : 'hii space'");
    expect(toolbar).toContain("label: 'HII Remote', shortcut: ''");
    expect(toolbar).toContain("label: 'Add note', shortcut: 'N'");
    expect(toolbar).toContain('aria-label="Search canvas commands"');
    expect(toolbar).toContain('hii-canvas-command-list');
    expect(toolbar).toContain('hii-canvas-touch-link');
    expect(toolbar).not.toContain('device terminal');
    expect(toolbar).not.toContain('double-click for text');
    expect(toolbar).toContain('onAddNote');
    expect(canvas).toContain('isAccount && isAssistantShortcut(event)');
    expect(canvas).toContain("event.key.toLowerCase() === 'u'");
    expect(canvas).toContain("event.key.toLowerCase() === 't'");
    expect(canvas).toContain("event.key.toLowerCase() === 'd'");
    expect(canvas).toContain("event.key.toLowerCase() === 'n'");
    expect(canvas).toContain("event.key === '0'");
    expect(canvas).toContain("event.key === '?'");
    expect(canvas).toContain('commandsOpen={isAccount ? canvasCommandsOpen : undefined}');
    expect(canvas).toContain('fitWorkspaceViewport');
    expect(canvas).toContain('hii-canvas-feedback');
    expect(canvas).toContain("setToolMessage('Opened HII Remote.')");
    expect(source).toContain('>HII Remote</button>');
    expect(source).not.toContain('>ask HII</button>');
    expect(source).not.toContain('>social</button>');
    expect(canvas).toContain('onAddLink={(url) =>');
    expect(canvas).toContain('fileSeeder ? fileSeeder(files) : seedsFromFiles(files)');
    expect(globalCss).toContain('.hii-space-toolbar[data-account-tools="true"] .hii-canvas-command-trigger');
    expect(globalCss).toContain('.hii-space-toolbar[data-account-tools="true"] .hii-canvas-touch-tools');
    expect(globalCss).toContain('@media (min-width: 561px) and (hover: hover) and (pointer: fine)');
    expect(globalCss).toContain('[data-chrome="adaptive"] > .hii-space-toolbar { display: none; }');
    expect(globalCss).toContain('[data-chrome="adaptive"][data-commands-open] > .hii-space-toolbar { display: flex; }');
    // The browser canvas now carries the installed app's floating pill at every
    // size, the way DesktopHiiAccess does, instead of hiding it on desktop.
    expect(css).not.toContain('.canvasHeader { display: none; }');
    expect(css).toContain('backdrop-filter: blur(24px) saturate(1.4);');
    expect(globalCss).toContain('.hii-node[data-node-type="note"]');
    expect(globalCss).toContain('background: rgba(248,249,249,.76)');
    expect(css).toContain('@media (max-width: 560px)');
  });

  it('synchronizes account-owned business workspaces and supports bounded studio access', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
    const adapter = readFileSync('lib/web/account-workspace.ts', 'utf8');
    const worker = readFileSync('workers/public-site/src/workspace.rs', 'utf8');

    expect(source).toContain('new AccountWorkspacePersistence(');
    expect(source).toContain('createWorkspaceShareCode(activeWorkspace.id');
    expect(source).toContain('redeemWorkspaceShareCode(redeemCode');
    expect(source).toContain("setSession({ ...next, source: 'account' })");
    expect(adapter).toContain('rebaseWorkspaceDoc(document, first.document, base)');
    expect(adapter).toContain("'X-HII-CSRF': this.csrfToken");
    expect(worker).toContain('let code_hash = hash_token(code);');
    expect(worker).toContain('current_access.role != "owner"');
    expect(worker).toContain("'workspace.member.revoked'");
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

  it('presents HII as the same light, spatial surface users enter', () => {
    const source = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
    const css = readFileSync('components/auth/HiiWebAccess.module.css', 'utf8');

    expect(source).toContain("Everything you&apos;ve made.");
    expect(source).toContain("Ready to make what&apos;s next.");
    expect(source).toContain('src="/marketing/hii-workspace-live.png"');
    expect(source).toContain('src="/marketing/hii-command-palette-live.png"');
    expect(source).toContain('src="/marketing/hii-run-receipt-live.png"');
    expect(source).toContain('alt="A live HII canvas');
    expect(source).not.toContain('<AsciiWave');
    expect(source).toContain("const params = new URLSearchParams(window.location.search)");
    expect(source).toContain("params.get('link') === 'cli'");
    expect(source).toContain("if (requestedLink) setMode('login')");
    expect(source).toContain('create a computer code');
    expect(css).toContain('--field: #f6f7f4');
    expect(css).toContain('--blue: #1759ff');
    expect(css).toContain('--signal: #008c69');
    expect(css).toContain('background: rgba(249, 250, 248, .88)');
    expect(css).not.toContain("url('/marketing/hii-prosumer-field-wide.png')");
    expect(css).not.toContain("url('/marketing/hii-prosumer-field-portrait.png')");
    expect(css).not.toContain('.asciiWave');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('place-items: center');
  });

  it('keeps the desktop entry target while using the authenticated web gate', () => {
    const page = readFileSync('app/page.tsx', 'utf8');
    const panels = readFileSync('components/auth/HiiWebPanels.tsx', 'utf8');
    const remote = readFileSync('components/remote/PairedMachines.tsx', 'utf8');

    expect(page).toContain("process.env.NEXT_PUBLIC_HII_TARGET === 'desktop'");
    expect(page).toContain("await import('@/components/desktop/DesktopHiiAccess')");
    const desktop = readFileSync('components/desktop/DesktopHiiAccess.tsx', 'utf8');
    expect(desktop).toContain('<HiiRoot');
    expect(desktop).toContain('persistentChrome={false}');
    expect(desktop).not.toContain('<header className={styles.header}');
    const canvas = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
    expect(desktop).toContain('openTerminalOnReady={ready && !onboardingComplete}');
    expect(canvas).toContain("node.payload.terminalPresentation !== 'hidden'");
    expect(desktop).toContain('new NativeAccountWorkspacePersistence(active)');
    expect(page).toContain('return <HiiWebAccess />');
    expect(panels).toContain('authenticatedSession={{ authenticated: true, csrfToken }}');
    expect(remote).toContain('if (authenticatedSession)');
    expect(remote).toContain('HII Remote is unavailable in this preview.');
  });

  it('offers both platforms as real gated downloads and says what is not signed', () => {
    const download = readFileSync('app/download/page.tsx', 'utf8');
    const release = readFileSync('components/public/DesktopRelease.tsx', 'utf8');

    expect(download).toContain('Tauri desktop app for Mac and Windows');
    expect(download).toContain('id="mac"');
    expect(download).toContain('id="windows"');
    expect(download).toContain('<DesktopRelease platform="macos"');
    expect(download).toContain('<DesktopRelease platform="windows"');
    // The old page claimed the browser was canonical and that every install
    // mirrored it. The desktop default is the local ~/.hii document and only a
    // chosen account workspace syncs, so that claim must not come back.
    expect(download).not.toContain('canonical data source');
    expect(download).not.toContain('automatically synchronized local copy');
    expect(download).toContain('opens on the local Runtime document');
    // Unsigned builds are shipping; the page has to say so rather than let the
    // OS be the one to break the news.
    expect(download).toContain('not code-signed yet');
    expect(download).toContain('SmartScreen');

    // The facts come from the gated manifest at read time, never hardcoded.
    expect(release).toContain('`/download/${platform}.json`');
    expect(release).toContain("credentials: 'include'");
    expect(release).toContain('response.status === 401');
  });

  it('documents the product that exists rather than a gesture the canvas dropped', () => {
    const docs = readFileSync('app/docs/page.tsx', 'utf8');

    expect(docs).not.toContain('Fn + Shift');
    expect(docs).toContain('id="canvas"');
    expect(docs).toContain('id="terminals"');
    expect(docs).toContain('id="workspaces"');
    expect(docs).toContain('id="devices"');
    expect(docs).toContain('id="cli"');
    expect(docs).toContain('hii login');
  });
});
