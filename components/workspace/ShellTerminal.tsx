'use client';

import { useEffect, useRef } from 'react';
import {
  listenTerminalEvents,
  resizeTerminalSession,
  startTerminalSession,
  writeTerminalSession
} from '@/lib/client/hii-bridge';

export function ShellTerminal({
  sessionId,
  cwd,
  onState
}: {
  sessionId: string;
  cwd: string;
  onState: (state: { status: 'running' | 'stopped' | 'failed'; cwd?: string; error?: string }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    const element = host.current;
    if (!element || !sessionId) return;
    let disposed = false;
    let cleanupEvents = () => {};
    let cleanupData = { dispose: () => {} };
    let observer: ResizeObserver | undefined;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    let fit: import('@xterm/addon-fit').FitAddon | undefined;

    const setup = async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links')
      ]);
      if (disposed) return;
      terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorInactiveStyle: 'outline',
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
        smoothScrollDuration: 80,
        fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", monospace',
        fontSize: 11,
        lineHeight: 1.35,
        scrollback: 5000,
        theme: {
          background: '#0b0c0f',
          foreground: '#d8dae0',
          cursor: '#f4f5f7',
          selectionBackground: '#343942',
          black: '#17191e',
          brightBlack: '#606570',
          green: '#73d69a',
          brightGreen: '#98eab4',
          red: '#ff746c',
          brightRed: '#ff958f',
          blue: '#86aefb',
          brightBlue: '#a9c5ff'
        }
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(element);
      fit.fit();

      cleanupEvents = await listenTerminalEvents({
        output(event) {
          if (event.sessionId === sessionId) terminal?.write(event.data);
        },
        exit(event) {
          if (event.sessionId !== sessionId) return;
          terminal?.writeln('\r\n\x1b[90msession ended\x1b[0m');
          onStateRef.current({ status: 'stopped' });
        }
      });
      cleanupData = terminal.onData((data) => {
        void writeTerminalSession(sessionId, data).catch((error) => {
          terminal?.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
        });
      });
      observer = new ResizeObserver(() => {
        if (!terminal || !fit) return;
        fit.fit();
        void resizeTerminalSession(sessionId, terminal.cols, terminal.rows);
      });
      observer.observe(element);

      try {
        const started = await startTerminalSession({
          sessionId,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows
        });
        if (disposed) return;
        if (started.replay) terminal.write(started.replay);
        terminal.focus();
        onStateRef.current({ status: 'running', cwd: started.cwd });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminal.writeln(`\x1b[31m${message}\x1b[0m`);
        onStateRef.current({ status: 'failed', error: message });
      }
    };

    void setup();
    return () => {
      disposed = true;
      observer?.disconnect();
      cleanupEvents();
      cleanupData.dispose();
      terminal?.dispose();
    };
  }, [cwd, sessionId]);

  return <div ref={host} className="hii-shell-terminal" aria-label={`Shell terminal in ${cwd}`} />;
}
