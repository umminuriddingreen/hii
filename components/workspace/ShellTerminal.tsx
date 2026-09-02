'use client';

import { useEffect, useRef, useState } from 'react';
import {
  listenTerminalEvents,
  resizeTerminalSession,
  startTerminalSession,
  writeTerminalSession
} from '@/lib/client/hii-bridge';

export function ShellTerminal({
  sessionId,
  cwd,
  entry = 'hii',
  preface = '',
  initialInput = '',
  onState
}: {
  sessionId: string;
  cwd: string;
  entry?: 'hii' | 'shell';
  preface?: string;
  initialInput?: string;
  onState: (state: { status: 'running' | 'stopped' | 'failed'; cwd?: string; error?: string }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
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
        fontFamily: '"Berkeley Mono", "SFMono-Regular", "Cascadia Code", "Roboto Mono", monospace',
        fontSize: 12,
        lineHeight: 1.38,
        scrollback: 5000,
        theme: {
          background: '#050505',
          foreground: '#e8e8e8',
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
      terminalRef.current = terminal;
      if (preface) terminal.write(`${preface.replace(/\r?\n/g, '\r\n')}\r\n\r\n`);
      const fitVisibleTerminal = () => {
        if (!terminal || !fit || element.clientWidth < 120 || element.clientHeight < 60) return false;
        fit.fit();
        return true;
      };
      fitVisibleTerminal();

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
        if (!terminal || !fit || !fitVisibleTerminal()) return;
        void resizeTerminalSession(sessionId, terminal.cols, terminal.rows);
      });
      observer.observe(element);

      try {
        const started = await startTerminalSession({
          sessionId,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
          entry
        });
        if (disposed) return;
        if (started.replay) terminal.write(started.replay);
        if (initialInput && started.created) await writeTerminalSession(sessionId, initialInput);
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
      terminalRef.current = null;
    };
  }, [cwd, entry, initialInput, preface, sessionId]);

  const find = (direction: 1 | -1 = 1) => {
    const terminal = terminalRef.current;
    if (!terminal || !query) return;
    const lines = Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) || '');
    const start = Math.max(0, terminal.buffer.active.viewportY + (direction > 0 ? 0 : terminal.rows));
    const order = direction > 0
      ? [...lines.keys()].slice(start).concat([...lines.keys()].slice(0, start))
      : [...lines.keys()].reverse().filter((index) => index <= start).concat([...lines.keys()].reverse().filter((index) => index > start));
    const row = order.find((index) => lines[index].toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (row === undefined) return;
    const column = lines[row].toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    terminal.select(column, row, query.length);
    terminal.scrollToLine(row);
  };

  return <div className="hii-shell-terminal-shell" onKeyDown={(event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); }
    if (event.key.toLowerCase() === 'c' && terminalRef.current?.hasSelection()) { event.preventDefault(); void navigator.clipboard.writeText(terminalRef.current.getSelection()); }
    if (event.key.toLowerCase() === 'v') { event.preventDefault(); void navigator.clipboard.readText().then((value) => writeTerminalSession(sessionId, value)); }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); const terminal = terminalRef.current; if (terminal) terminal.options.fontSize = Math.min(24, Number(terminal.options.fontSize || 12) + 1); }
    if (event.key === '-') { event.preventDefault(); const terminal = terminalRef.current; if (terminal) terminal.options.fontSize = Math.max(9, Number(terminal.options.fontSize || 12) - 1); }
  }}>
    {searchOpen && <form className="hii-terminal-find" onSubmit={(event) => { event.preventDefault(); find(1); }}>
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setSearchOpen(false); }} placeholder="Find" aria-label="Find terminal text" />
      <button type="button" aria-label="Previous match" onClick={() => find(-1)}>↑</button>
      <button type="submit" aria-label="Next match">↓</button>
      <button type="button" aria-label="Close find" onClick={() => setSearchOpen(false)}>×</button>
    </form>}
    <div ref={host} className="hii-shell-terminal" aria-label={`HII terminal in ${cwd}`} />
  </div>;
}
