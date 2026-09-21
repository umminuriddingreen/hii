import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtime = readFileSync('scripts/hii-web-dev-runtime.mjs', 'utf8');
const bridge = readFileSync('lib/client/hii-bridge.ts', 'utf8');
const root = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
const webAccess = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
const sessions = readFileSync('server/pty-sessions.mjs', 'utf8');

describe('shared HII web terminal', () => {
  it('mounts the existing local-only PTY gateway on the browser runtime', () => {
    expect(runtime).toContain("attachPtyGateway(terminalSockets)");
    expect(runtime).toContain("url.pathname !== '/terminal'");
    expect(runtime).toContain('!isLocalRequest(request)');
  });

  it('routes the browser terminal through the connected local HII executor', () => {
    expect(bridge).toContain("return startWebTerminalSession(request)");
    expect(bridge).toContain("ws://127.0.0.1:3043/terminal");
    expect(bridge).toContain("program: request.entry === 'shell' ? undefined : 'hii'");
    expect(bridge).toContain('No local HII executor answered the web terminal');
  });

  it('allows a terminal object only for the loopback-authorized account canvas', () => {
    expect(webAccess).toContain("allowLocalRuntime={session.source === 'local'}");
    expect(root).toContain("isAccountCanvasNodeType(seed.type) || (allowLocalRuntime && seed.type === 'terminal')");
  });

  it('expands home-relative terminal folders before spawning on Windows', () => {
    expect(sessions).toContain('function safeWorkingDirectory(requested)');
    expect(sessions).toContain("requested.startsWith('~')");
    expect(sessions).toContain('existsSync(resolved) ? resolved : ALLOWED_ROOT');
  });
});
