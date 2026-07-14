'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { WorkspaceNodeType } from '../../lib/workspace/types';

type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type CommandBarProps = {
  spawn: (type: WorkspaceNodeType, payload?: Record<string, unknown>) => void;
  resetView: () => void;
};

export function CommandBar({ spawn, resetView }: CommandBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((current) => !current);
        setQuery('');
        setIndex(0);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const close = () => setOpen(false);

  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: 'terminal', label: 'new terminal', hint: 'zsh · run claude / codex', run: () => spawn('terminal') },
      { id: 'browser', label: 'new browser', hint: 'url or web search', run: () => spawn('browser') },
      { id: 'note', label: 'new note', run: () => spawn('note') },
      { id: 'context', label: 'add system context', hint: 'git · capabilities · next actions', run: () => spawn('context') },
      { id: 'board', label: 'add board', hint: '~/.hii board lanes', run: () => spawn('board') },
      { id: 'reset', label: 'reset view', hint: '⌘0', run: resetView },
      { id: 'nav-boards', label: 'go to boards', run: () => (location.href = '/boards') },
      { id: 'nav-console', label: 'go to console', run: () => (location.href = '/console') },
      { id: 'nav-exchange', label: 'go to exchange', run: () => (location.href = '/upload') },
      { id: 'nav-dashboard', label: 'go to dashboard', run: () => (location.href = '/dashboard') }
    ];
    const q = query.trim();
    const filtered = q
      ? base.filter((cmd) => (cmd.label + ' ' + (cmd.hint ?? '')).toLowerCase().includes(q.toLowerCase()))
      : base;
    if (q) {
      filtered.push({
        id: 'search-web',
        label: `search the web for “${q}”`,
        hint: 'opens a browser node',
        run: () => spawn('browser', { query: q })
      });
    }
    return filtered;
  }, [query, spawn, resetView]);

  const activeIndex = Math.min(index, commands.length - 1);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-workspace-ui
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="absolute inset-0 z-50 bg-neutral-900/10"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -6 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className="mx-auto mt-[18vh] w-[560px] max-w-[92vw] overflow-hidden rounded-xl bg-white shadow-[0_0_0_1px_rgba(23,23,23,0.12),0_16px_48px_rgba(23,23,23,0.16)]"
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIndex((i) => Math.min(i + 1, commands.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter' && commands[activeIndex]) {
                  commands[activeIndex].run();
                  close();
                } else if (e.key === 'Escape') {
                  close();
                }
              }}
              placeholder="type a command or search…"
              spellCheck={false}
              className="w-full border-b border-neutral-900/10 bg-transparent px-4 py-3.5 text-[14px] text-[var(--hii-graphite)] outline-none placeholder:text-neutral-300"
            />
            <div className="max-h-[320px] overflow-auto py-1.5">
              {commands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  onClick={() => {
                    cmd.run();
                    close();
                  }}
                  onPointerEnter={() => setIndex(i)}
                  className={`flex w-full items-baseline justify-between px-4 py-2 text-left ${
                    i === activeIndex ? 'bg-[rgba(23,107,255,0.07)]' : ''
                  }`}
                >
                  <span className={`text-[13px] ${i === activeIndex ? 'text-[var(--hii-electric-blue)]' : 'text-[var(--hii-graphite)]'}`}>
                    {cmd.label}
                  </span>
                  {cmd.hint && <span className="ml-3 shrink-0 font-mono text-[10px] text-neutral-400">{cmd.hint}</span>}
                </button>
              ))}
              {commands.length === 0 && <div className="px-4 py-3 font-mono text-[11px] text-neutral-400">no matches</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
