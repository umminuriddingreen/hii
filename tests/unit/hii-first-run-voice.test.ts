import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HII first-run and voice input', () => {
  it('uses the visual gate on web and a real persistent PTY terminal on desktop', () => {
    const firstRun = readFileSync('components/auth/HiiFirstRunTerminal.tsx', 'utf8');
    const desktop = readFileSync('components/desktop/DesktopHiiAccess.tsx', 'utf8');
    const web = readFileSync('components/auth/HiiWebAccess.tsx', 'utf8');
    const canvas = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
    const terminal = readFileSync('components/workspace/ShellTerminal.tsx', 'utf8');

    expect(firstRun).toContain('Welcome to <strong>HII</strong>');
    expect(firstRun).toContain('HII_ASCII');
    expect(firstRun).toContain("event.key === 'ArrowDown'");
    expect(firstRun).toContain("event.key === 'Enter'");
    expect(web).not.toContain('<HiiFirstRunTerminal');
    expect(web).not.toContain('openTerminalOnReady={ready && !firstRunDismissed}');
    expect(web).toContain('<HiiCanvasFrame');
    expect(web).toContain("params.get('first-run') === '1'");
    expect(desktop).not.toContain('<HiiFirstRunTerminal');
    expect(desktop).toContain('openTerminalOnReady={ready && !onboardingComplete}');
    expect(canvas).toContain("terminalInitialInput: '/providers\\r'");
    expect(canvas).toContain('/login codex');
    expect(canvas).toContain('initialInput={text(node.payload.terminalInitialInput)}');
    expect(terminal).toContain('startTerminalSession({');
    expect(terminal).toContain('initialInput && started.created');
    expect(terminal).toContain('writeTerminalSession(sessionId, initialInput)');
  });

  it('adds the same speech-to-text control to native canvas intent and web HII chat', () => {
    const voice = readFileSync('components/workspace/VoiceInputButton.tsx', 'utf8');
    const canvas = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
    const webChat = readFileSync('components/remote/LocalHiiChat.tsx', 'utf8');

    expect(voice).toContain('webkitSpeechRecognition');
    expect(voice).toContain('.filter((result) => result.isFinal)');
    expect(voice).toContain('Microphone permission is required');
    expect(canvas).toContain('<VoiceInputButton');
    expect(canvas).toContain('onTranscript={(transcript) => setValue');
    expect(webChat).toContain('<VoiceInputButton');
    expect(webChat).toContain('onTranscript={(transcript) => setDraft');
    const plist = readFileSync('src-tauri/Info.plist', 'utf8');
    expect(plist).toContain('NSMicrophoneUsageDescription');
    expect(plist).toContain('NSSpeechRecognitionUsageDescription');
  });
});
