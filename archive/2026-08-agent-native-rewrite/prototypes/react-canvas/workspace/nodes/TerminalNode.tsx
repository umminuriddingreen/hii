'use client';

import { useEffect, useRef } from 'react';
import type { WorkspaceNode } from '../../../lib/workspace/types';
import { ptySend, ptySubscribe, type PtyServerMessage } from '../usePtySocket';

type TerminalNodeProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

export default function TerminalNode({ node, onPayload }: TerminalNodeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string>(
    typeof node.payload.sessionId === 'string' && node.payload.sessionId ? node.payload.sessionId : crypto.randomUUID()
  );
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sessionId = sessionIdRef.current;
    if (node.payload.sessionId !== sessionId) onPayloadRef.current({ sessionId });

    let disposed = false;
    let term: import('@xterm/xterm').Terminal | null = null;
    let unsubscribe: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let created = false;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links')
      ]);
      if (disposed) return;

      term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: {
          background: '#ffffff',
          foreground: '#171717',
          cursor: '#176bff',
          cursorAccent: '#ffffff',
          selectionBackground: 'rgba(23,107,255,0.18)',
          black: '#171717',
          brightBlack: '#6b7280',
          blue: '#176bff',
          brightBlue: '#4d8dff'
        }
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(el);
      fit.fit();

      const dims = () => ({ cols: term!.cols, rows: term!.rows });
      let exited = false;

      const create = () => {
        created = true;
        exited = false;
        ptySend({ t: 'create', sessionId, cwd: String(node.payload.cwd ?? '') || undefined, ...dims() });
      };

      const onMessage = (msg: PtyServerMessage) => {
        if (!term) return;
        if (msg.t === 'scrollback') {
          term.clear();
          if (msg.data) term.write(msg.data);
        } else if (msg.t === 'data') {
          if (msg.data) term.write(msg.data);
        } else if (msg.t === 'exit') {
          term.write(`\r\n\x1b[90m[session exited (${msg.exitCode ?? '?'}) — press enter to restart]\x1b[0m\r\n`);
          created = false;
          exited = true;
        } else if (msg.t === 'attached') {
          if (msg.alive === false) exited = true;
        } else if (msg.t === 'error') {
          if (msg.message === 'unknown session' && !created) {
            create();
          } else if (msg.message === 'socket closed') {
            setTimeout(() => ptySend({ t: 'attach', sessionId, ...dims() }), 1000);
          } else if (msg.message) {
            term.write(`\r\n\x1b[31m[${msg.message}]\x1b[0m\r\n`);
          }
        }
      };

      unsubscribe = ptySubscribe(sessionId, onMessage);
      ptySend({ t: 'attach', sessionId, ...dims() });

      term.onData((data) => {
        if (exited && data === '\r') {
          ptySend({ t: 'kill', sessionId });
          term?.reset();
          create();
          return;
        }
        ptySend({ t: 'input', sessionId, data });
      });

      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!term) return;
          fit.fit();
          ptySend({ t: 'resize', sessionId, ...dims() });
        }, 100);
      });
      resizeObserver.observe(el);
    })();

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      unsubscribe?.();
      term?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="xterm-host h-full w-full bg-white pl-2 pt-1" />;
}
