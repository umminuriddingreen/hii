'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { WorkspaceNodeType } from '../../lib/workspace/types';
import type { CapabilityDefinition } from '../../lib/capabilities/types';
import { surfaceForCapability } from '../../lib/capabilities/surfaces';

type Surface = {
  id: string;
  enabled: boolean;
  home: boolean;
};

type Skill = {
  id: string;
  name: string;
  description: string;
  trustLevel: string;
  permissions: string[];
  sideEffects: string[];
  verification: string[];
  path: string;
};

type Command = {
  id: string;
  kind: 'capability' | 'create' | 'navigate' | 'surface' | 'skill' | 'view';
  label: string;
  hint: string;
  verb: string;
  detail?: string;
  surface?: Surface;
  skill?: Skill;
  capability?: CapabilityDefinition;
  run?: () => void;
  surfaceAction?: 'toggle' | 'home';
};

type CommandBarProps = {
  spawn: (type: WorkspaceNodeType, payload?: Record<string, unknown>) => void;
  resetView: () => void;
  getAnchor: () => { x: number; y: number };
  onOpenChange?: (open: boolean) => void;
};

function kindLabel(command: Command) {
  if (command.kind === 'capability') return 'HII capability';
  if (command.kind === 'skill') return 'registered skill';
  if (command.kind === 'surface') return 'surface control';
  if (command.kind === 'navigate') return 'HII surface';
  if (command.kind === 'view') return 'workspace view';
  return 'new context';
}

export function CommandBar({ spawn, resetView, getAnchor, onOpenChange }: CommandBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [anchorX, setAnchorX] = useState(0);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setPaletteOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    document.documentElement.toggleAttribute('data-hii-omnibar-open', next);
  }, [onOpenChange]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [configResponse, skillsResponse, capabilitiesResponse] = await Promise.all([
        fetch('/api/config', { cache: 'no-store' }),
        fetch('/api/skills', { cache: 'no-store' }),
        fetch('/api/capabilities', { cache: 'no-store' })
      ]);
      if (!configResponse.ok || !skillsResponse.ok || !capabilitiesResponse.ok) throw new Error('HII controls unavailable');
      const [{ config }, { skills: nextSkills }, { capabilities: nextCapabilities }] = await Promise.all([
        configResponse.json() as Promise<{ config: { defaults?: { homepage?: string }; surfaces?: Record<string, { enabled?: boolean }> } }>,
        skillsResponse.json() as Promise<{ skills: Skill[] }>,
        capabilitiesResponse.json() as Promise<{ capabilities: CapabilityDefinition[] }>
      ]);
      const home = config.defaults?.homepage || 'workspace';
      setSurfaces(
        Object.entries(config.surfaces || {}).map(([id, value]) => ({
          id,
          enabled: value.enabled !== false,
          home: id === home
        }))
      );
      setSkills(Array.isArray(nextSkills) ? nextSkills : []);
      setCapabilities(Array.isArray(nextCapabilities) ? nextCapabilities : []);
    } catch {
      setNotice('Live surface and skill controls could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (open) {
          setPaletteOpen(false);
          return;
        }
        const pointer = getAnchor();
        const panelHalf = Math.min(390, window.innerWidth * 0.46);
        setAnchorX(Math.max(panelHalf + 12, Math.min(window.innerWidth - panelHalf - 12, pointer.x)));
        setQuery('');
        setIndex(0);
        setNotice('');
        setPaletteOpen(true);
      } else if (event.key === 'Escape' && open) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [getAnchor, open, setPaletteOpen]);

  useEffect(() => {
    if (!open) return;
    refresh();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, refresh]);

  useEffect(() => () => document.documentElement.removeAttribute('data-hii-omnibar-open'), []);

  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: 'terminal', kind: 'create', label: 'New terminal', hint: 'zsh · run Claude or Codex', verb: 'create', run: () => spawn('terminal') },
      { id: 'browser', kind: 'create', label: 'New browser', hint: 'URL or web search', verb: 'create', run: () => spawn('browser') },
      { id: 'chat', kind: 'create', label: 'New HII chat', hint: 'local context object', verb: 'create', run: () => spawn('chat') },
      { id: 'note', kind: 'create', label: 'New note', hint: 'persistent workspace object', verb: 'create', run: () => spawn('note') },
      { id: 'context', kind: 'create', label: 'Pin live system context', hint: 'git · capabilities · next actions', verb: 'create', run: () => spawn('context') },
      { id: 'board', kind: 'create', label: 'Open board object', hint: '~/.hii board lanes', verb: 'create', run: () => spawn('board') },
      { id: 'sound-field', kind: 'create', label: 'Open South Berkeley sound field', hint: 'WebGL · modeled dBA', verb: 'create', run: () => spawn('sound-field') },
      { id: 'reset', kind: 'view', label: 'Reset workspace view', hint: '⌘0', verb: 'reset', run: resetView },
      { id: 'nav-boards', kind: 'navigate', label: 'Go to boards', hint: '/boards', verb: 'open', run: () => (location.href = '/boards') },
      { id: 'nav-console', kind: 'navigate', label: 'Go to console', hint: '/console · live system feed', verb: 'open', run: () => (location.href = '/console') },
      ...capabilities.flatMap<Command>((capability) => {
        const target = surfaceForCapability(capability.id);
        if (!target) return [];
        return [{
          id: `capability-${capability.id}`,
          kind: 'capability',
          label: capability.name,
          hint: `${capability.status} · ${target.label} · ${capability.id}`,
          verb: 'open',
          detail: capability.summary,
          capability,
          run: () => (location.href = target.href)
        }];
      }),
      ...surfaces.flatMap<Command>((surface) => [
        {
          id: `surface-toggle-${surface.id}`,
          kind: 'surface',
          label: `${surface.enabled ? 'Pause' : 'Enable'} ${surface.id}`,
          hint: `${surface.enabled ? 'active' : 'paused'}${surface.home ? ' · home' : ''}`,
          verb: surface.enabled ? 'pause' : 'enable',
          detail: 'AII owns this setting. The change is written through hiid and applies to the next surface load.',
          surface,
          surfaceAction: 'toggle'
        },
        {
          id: `surface-home-${surface.id}`,
          kind: 'surface',
          label: `Make ${surface.id} the home surface`,
          hint: surface.home ? 'current home' : 'homepage default',
          verb: surface.home ? 'home' : 'make home',
          detail: 'Sets the first HII surface opened from the desktop shell.',
          surface,
          surfaceAction: 'home'
        }
      ]),
      ...skills.map<Command>((skill) => ({
        id: `skill-${skill.id}`,
        kind: 'skill',
        label: skill.name,
        hint: `${skill.trustLevel} · ${skill.id}`,
        verb: 'start',
        detail: skill.description,
        skill
      }))
    ];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return base;
    return base.filter((command) =>
      [command.label, command.hint, command.detail, kindLabel(command)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalized)
    );
  }, [capabilities, query, resetView, skills, spawn, surfaces]);

  const activeIndex = Math.max(0, Math.min(index, commands.length - 1));
  const active = commands[activeIndex];

  const perform = useCallback(async (command: Command | undefined) => {
    if (!command || busyId) return;
    if (command.run) {
      command.run();
      setPaletteOpen(false);
      return;
    }
    setBusyId(command.id);
    setNotice('');
    try {
      if (command.kind === 'surface' && command.surface && command.surfaceAction) {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            command.surfaceAction === 'toggle'
              ? { action: 'toggle', surface: command.surface.id, enabled: !command.surface.enabled }
              : { action: 'home', surface: command.surface.id }
          )
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(data.error || 'Surface update failed.');
        setNotice(`${command.surface.id} configuration updated through hiid.`);
        await refresh();
      } else if (command.kind === 'skill' && command.skill) {
        const response = await fetch('/api/skills', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: command.skill.id })
        });
        const data = (await response.json()) as { error?: string; runId?: string | null };
        if (!response.ok) throw new Error(data.error || 'Skill launch failed.');
        setNotice(`${command.skill.name} queued${data.runId ? ` as ${data.runId}` : ''}.`);
        await new Promise((resolve) => setTimeout(resolve, 650));
        setPaletteOpen(false);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Command failed.');
    } finally {
      setBusyId(null);
    }
  }, [busyId, refresh, setPaletteOpen]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-workspace-ui
          data-testid="hii-omnibar-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="absolute inset-0 z-[80] bg-[#0a1220]/14 backdrop-blur-[3px]"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPaletteOpen(false);
          }}
        >
          <motion.div
            aria-hidden="true"
            initial={{ opacity: 0, scale: 0.35, x: '-50%', y: 28 }}
            animate={{ opacity: 0.72, scale: 1, x: '-50%', y: 0 }}
            exit={{ opacity: 0, scale: 0.4, x: '-50%', y: 24 }}
            transition={{ type: 'spring', stiffness: 290, damping: 24 }}
            className="hii-omni-flare"
            style={{ left: anchorX }}
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="HII omnibar"
            data-testid="hii-omnibar"
            initial={{ opacity: 0, scale: 0.94, x: '-50%', y: 48, borderRadius: 40 }}
            animate={{ opacity: 1, scale: 1, x: '-50%', y: 0, borderRadius: 22 }}
            exit={{ opacity: 0, scale: 0.96, x: '-50%', y: 34, borderRadius: 36 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30, mass: 0.86 }}
            className="hii-omni-shell"
            style={{ left: anchorX }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="hii-omni-input-row">
              <span className="hii-omni-mark" aria-hidden="true">⌘</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIndex(0);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setIndex((current) => Math.min(current + 1, commands.length - 1));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setIndex((current) => Math.max(current - 1, 0));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    perform(active);
                  } else if (event.key === 'Escape') {
                    setPaletteOpen(false);
                  }
                }}
                placeholder="Create, configure, or start a skill…"
                spellCheck={false}
                aria-label="Search HII commands"
              />
              <span className="hii-omni-live"><i /> HII paused</span>
            </header>

            <div className="hii-omni-body">
              <div className="hii-omni-results" role="listbox" aria-label="HII commands">
                {commands.map((command, commandIndex) => (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={commandIndex === activeIndex}
                    disabled={Boolean(busyId)}
                    onClick={() => perform(command)}
                    onPointerEnter={() => setIndex(commandIndex)}
                    className={commandIndex === activeIndex ? 'is-active' : ''}
                  >
                    <span className="hii-omni-glyph" data-kind={command.kind}>
                      {command.kind === 'skill' ? '✦' : command.kind === 'capability' ? '◆' : command.kind === 'surface' ? '◐' : command.kind === 'navigate' ? '↗' : command.kind === 'view' ? '◎' : '+'}
                    </span>
                    <span className="hii-omni-command-copy">
                      <strong>{command.label}</strong>
                      <small>{command.hint}</small>
                    </span>
                    <kbd>{busyId === command.id ? '···' : command.verb}</kbd>
                  </button>
                ))}
                {!loading && commands.length === 0 && <div className="hii-omni-empty">No HII command matches “{query}”.</div>}
                {loading && commands.length === 0 && <div className="hii-omni-empty">Reading live HII controls…</div>}
              </div>

              <aside className="hii-omni-inspector" aria-live="polite">
                {active ? (
                  <>
                    <span className="hii-omni-eyebrow">{kindLabel(active)}</span>
                    <h2>{active.label}</h2>
                    <p>{active.detail || active.hint}</p>
                    {active.skill && (
                      <div className="hii-omni-facts">
                        <span><b>{active.skill.permissions.length}</b> permissions</span>
                        <span><b>{active.skill.sideEffects.length}</b> side effects</span>
                        <span><b>{active.skill.verification.length}</b> proof checks</span>
                      </div>
                    )}
                    {active.surface && (
                      <div className="hii-omni-facts">
                        <span><b>{active.surface.enabled ? 'on' : 'off'}</b> availability</span>
                        <span><b>{active.surface.home ? 'yes' : 'no'}</b> home surface</span>
                      </div>
                    )}
                    {active.capability && (
                      <div className="hii-omni-facts">
                        <span><b>{active.capability.status}</b> availability</span>
                        <span><b>{active.capability.runtime}</b> runtime</span>
                        <span><b>{active.capability.trustLevel}</b> trust</span>
                      </div>
                    )}
                    <div className="hii-omni-enter"><span>↵</span> {active.verb}</div>
                  </>
                ) : (
                  <p>Type a surface, object, or registered skill.</p>
                )}
              </aside>
            </div>

            <footer className="hii-omni-footer">
              <span>{notice || `${commands.length} live actions`}</span>
              <span>↑↓ choose&nbsp;&nbsp; ↵ run&nbsp;&nbsp; esc resume HII</span>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
