import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

// Module-level singletons: the terminal survives dock tab switches and
// React StrictMode remounts without losing its buffer or PTY session.
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let sessionOpen = false;

async function ensureSession(cols: number, rows: number) {
  if (sessionOpen) return;
  sessionOpen = true;
  try {
    // Local shell for now. TODO(phase-5): attach to remote tmux/Zellij
    // sessions (`ssh -t <host> tmux attach -t aii__{project}__{task}`).
    await invoke("terminal_open", { cols, rows });
  } catch (e) {
    sessionOpen = false;
    term?.writeln(`\r\n[terminal error] ${e}`);
  }
}

export function TerminalPanel({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!term) {
      term = new Terminal({
        fontSize: 12,
        fontFamily:
          '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
        cursorBlink: true,
        theme: {
          background: "#10131a",
          foreground: "#d9dee8",
          cursor: "#5b9dff",
          selectionBackground: "#2a3550",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      term.onData((data) => invoke("terminal_write", { data }).catch(() => {}));
      term.onResize(({ cols, rows }) =>
        invoke("terminal_resize", { cols, rows }).catch(() => {}),
      );
      listen<string>("terminal:output", (e) => term?.write(e.payload));
      listen("terminal:exit", () => {
        sessionOpen = false;
        term?.writeln("\r\n\x1b[90m[session ended — reopen the tab to restart]\x1b[0m");
      });
    } else if (term.element && term.element.parentElement !== el) {
      el.appendChild(term.element);
    }
  }, []);

  // Fit + spawn lazily when the tab becomes visible (fit fails at 0×0).
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      if (!term || !fit) return;
      fit.fit();
      ensureSession(term.cols, term.rows);
      term.focus();
    });
    const ro = new ResizeObserver(() => fit?.fit());
    if (ref.current) ro.observe(ref.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active]);

  return <div ref={ref} className="h-full w-full bg-panel px-2 pt-1" />;
}
