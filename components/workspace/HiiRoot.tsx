'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listenAgentEvents, startAgent, type AgentEventV1 } from '@/lib/client/hii-bridge';
import { makeNode, seedFor, seedFromString, seedsFromDataTransfer, seedsFromFiles, type NodeSeed } from '@/lib/workspace/ingest';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { NodeFrame } from './NodeFrame';
import { SpatialActivityLayer } from './SpatialActivityLayer';
import { useCamera } from './useCamera';
import { useWorkspace } from './useWorkspace';

type Point = { x: number; y: number };

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function titleFor(node: WorkspaceNode) {
  return text(node.payload.title) || text(node.payload.name) || node.object?.kind || node.type;
}

function normalizeBrowserUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?igu=1&q=${encodeURIComponent(trimmed)}`;
}

function BrowserBody({ node, onPayload }: { node: WorkspaceNode; onPayload: (patch: Record<string, unknown>) => void }) {
  const url = text(node.payload.url) || 'https://www.google.com/webhp?igu=1';
  const [address, setAddress] = useState(url);
  return (
    <section className="hii-browser">
      <form onSubmit={(event) => {
        event.preventDefault();
        const next = normalizeBrowserUrl(address);
        setAddress(next);
        onPayload({ url: next, title: next });
      }}>
        <input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Browser address or search" autoFocus />
      </form>
      <iframe src={url} title={text(node.payload.title) || 'HII browser'} sandbox="allow-forms allow-scripts allow-same-origin allow-popups" />
    </section>
  );
}

function RequestBody({ node }: { node: WorkspaceNode }) {
  const prompt = text(node.payload.text) || text(node.payload.title);
  const output = text(node.payload.output);
  const status = text(node.payload.status);
  return (
    <article className="hii-request hii-job-terminal" data-status={status || 'ready'}>
      <header>
        <span className="hii-terminal-lamp" aria-hidden="true" />
        <strong>intent</strong>
        <small>{status || 'ready'}</small>
      </header>
      <pre>
        <span className="hii-terminal-path">hii://workspace/intent</span>
        <span><b className="hii-command-mark">›</b> {prompt}</span>
        {(output || status === 'running') && <span className="hii-request-output">{output || 'Working…'}</span>}
        {status === 'running' && <span className="hii-terminal-prompt"><b>›</b> <i aria-hidden="true" /></span>}
      </pre>
      <footer><span>proof</span><code>{text(node.payload.receiptPath) || 'pending verified result'}</code></footer>
    </article>
  );
}

function TerminalBody({ node }: { node: WorkspaceNode }) {
  const job = text(node.payload.job) || 'visual artifact';
  const cwd = text(node.payload.cwd) || '~/hii';
  const artifact = text(node.payload.artifact) || 'artifact pending';
  const status = text(node.payload.status) || 'ready';
  const lines = Array.isArray(node.payload.lines) ? node.payload.lines.map(text).filter(Boolean) : [];
  return (
    <article className="hii-job-terminal" data-status={status}>
      <header>
        <span className="hii-terminal-lamp" aria-hidden="true" />
        <strong>{job}</strong>
        <small>{status}</small>
      </header>
      <pre aria-label={`${job} terminal`}>
        <span className="hii-terminal-path">{cwd}</span>
        {lines.map((line, index) => <span key={`${line}:${index}`}>{line}</span>)}
        <span className="hii-terminal-prompt"><b>›</b> <i aria-hidden="true" /></span>
      </pre>
      <footer><span>artifact</span><code>{artifact}</code></footer>
    </article>
  );
}

function NodeBody({ node, onPayload }: { node: WorkspaceNode; onPayload: (patch: Record<string, unknown>) => void }) {
  const payload = node.payload;
  const content = text(payload.content) || text(payload.text) || text(payload.output) || text(payload.summary);
  const url = text(payload.url);
  const name = text(payload.name) || text(payload.title) || node.type;

  if (node.type === 'browser') return <BrowserBody node={node} onPayload={onPayload} />;
  if (node.type === 'terminal') return <TerminalBody node={node} />;
  if (node.type === 'intent') return <RequestBody node={node} />;
  if (node.type === 'html') return <iframe className="hii-html" srcDoc={text(payload.srcdoc)} title={name} sandbox="allow-forms allow-scripts" />;
  if (node.type === 'image' && url) return <img className="hii-node-image" src={url} alt={name} draggable={false} />;
  if (node.type === 'media' && url) {
    return payload.kind === 'audio'
      ? <audio className="hii-node-video" src={url} controls />
      : <video className="hii-node-video" src={url} controls />;
  }
  if (node.type === 'link' && url) {
    return <a className="hii-node-link" href={url} target="_blank" rel="noreferrer"><strong>{name}</strong><small>{url}</small></a>;
  }
  if (node.type === 'note' || node.type === 'canvas-text') {
    return (
      <textarea
        className="hii-node-editor"
        aria-label={name}
        value={content}
        onChange={(event) => onPayload(node.type === 'canvas-text' ? { text: event.target.value } : { content: event.target.value })}
      />
    );
  }
  return <pre className="hii-node-copy" data-mono={node.type === 'run'}>{content || name}</pre>;
}

function Prompt({
  anchor,
  initialValue,
  contextLabel,
  onDismiss,
  onSubmit
}: {
  anchor: Point;
  initialValue: string;
  contextLabel: string;
  onDismiss: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <div className="hii-prompt-shell" style={{ left: Math.min(anchor.x, window.innerWidth - 24), top: Math.min(anchor.y, window.innerHeight - 90) }}>
      <form className="hii-prompt" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
        <div className="hii-prompt-line">
          <span aria-hidden="true">›</span>
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onDismiss(); } }}
            placeholder="Run anything…"
            aria-label="Tell HII what should happen"
            autoComplete="off"
            spellCheck
          />
        </div>
        <div className="hii-prompt-context">{contextLabel || 'cursor context · local workspace'}</div>
      </form>
    </div>
  );
}

export function HiiRoot() {
  const save = useRef<() => void>(() => {});
  const camera = useCamera(() => save.current());
  const workspace = useWorkspace(camera.getViewport);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<{ anchor: Point; initialValue: string } | null>(null);
  const [presence, setPresence] = useState<Point>({ x: 0, y: 0 });
  const mouse = useRef<Point>({ x: 400, y: 280 });
  const runs = useRef(new Map<string, string>());
  const fileInput = useRef<HTMLInputElement | null>(null);
  save.current = workspace.scheduleSave;

  useEffect(() => {
    if (workspace.initialViewport) camera.setViewport(workspace.initialViewport);
  }, [camera, workspace.initialViewport]);

  const spawnSeeds = useCallback((seeds: NodeSeed[], at: Point) => {
    const ids: string[] = [];
    seeds.forEach((seed, index) => {
      const node = makeNode(seed, at.x + index * 24, at.y + index * 24, workspace.takeZ());
      ids.push(node.id);
      workspace.addNode(node);
    });
    setSelected(ids);
    return ids;
  }, [workspace]);

  const spawnArtifactTerminals = useCallback((at: Point) => {
    const origin = camera.toWorld(at.x, at.y);
    const groupId = crypto.randomUUID();
    const jobs = [
      { job: 'compose', artifact: 'artifacts/visual/concept.svg', status: 'ready', lines: ['$ hii artifact compose --visual', 'context staged · awaiting intent'] },
      { job: 'render', artifact: 'artifacts/visual/render.webp', status: 'queued', lines: ['$ hii artifact render --watch', 'linked to compose output'] },
      { job: 'verify', artifact: 'artifacts/visual/receipt.json', status: 'queued', lines: ['$ hii proof --artifact render.webp', 'verification follows render'] }
    ];
    const ids = jobs.map((job, index) => {
      const node = makeNode(seedFor('terminal', {
        ...job,
        title: `${job.job} · ${job.artifact.split('/').at(-1)}`,
        cwd: '~/hii',
        groupId,
        role: 'visual-artifact-job'
      }), origin.x + index * 46, origin.y + index * 150, workspace.takeZ());
      node.w = 620;
      node.h = 270;
      node.object = {
        kind: 'terminal',
        owner: 'hii',
        status: job.status === 'ready' ? 'ready' : 'queued',
        source: 'HII visual artifact terminal loom',
        parentId: groupId,
        proofRefs: [job.artifact],
        audit: [{ ts: new Date().toISOString(), actor: 'human', action: `created ${job.job} terminal for ${job.artifact}` }]
      };
      workspace.addNode(node);
      return node.id;
    });
    setSelected(ids);
  }, [camera, workspace]);

  const selectedNodes = useMemo(() => workspace.nodes.filter((node) => selected.includes(node.id)), [selected, workspace.nodes]);

  const submit = useCallback(async (intent: string, anchor: Point) => {
    setPrompt(null);
    const at = camera.toWorld(anchor.x, anchor.y);
    const [intentId] = spawnSeeds([seedFor('intent', {
      text: intent,
      title: intent,
      status: 'running',
      output: 'Starting…'
    })], at);
    try {
      const result = await startAgent({
        version: 1,
        intent,
        contextNodeIds: selected,
        context: {
          anchor,
          selected: selectedNodes.map((node) => ({
            id: node.id,
            type: node.type,
            title: titleFor(node),
            object: node.object,
            payload: node.payload
          }))
        }
      });
      runs.current.set(result.runId, intentId);
      workspace.patchNode(intentId, {
        object: { kind: 'intent', owner: 'human', status: 'running', runId: result.runId },
        payload: { text: intent, title: intent, status: 'running', output: 'Working…' }
      });
    } catch (error) {
      workspace.patchNode(intentId, {
        object: { kind: 'intent', owner: 'human', status: 'failed' },
        payload: { text: intent, title: intent, status: 'failed', output: error instanceof Error ? error.message : 'HII could not start the agent.' }
      });
    }
  }, [camera, selected, selectedNodes, spawnSeeds, workspace]);

  useEffect(() => {
    let unlisten = () => {};
    listenAgentEvents((event: AgentEventV1) => {
      const nodeId = runs.current.get(event.runId);
      if (!nodeId) return;
      const node = workspace.nodes.find((entry) => entry.id === nodeId);
      const previous = text(node?.payload.output);
      const output = event.text ? `${previous}${previous ? '\n' : ''}${event.text}` : previous;
      workspace.patchNode(nodeId, {
        object: { kind: 'intent', owner: 'human', status: event.status === 'progress' || event.status === 'started' ? 'running' : event.status, runId: event.runId, proofRefs: event.receiptPath ? [event.receiptPath] : undefined },
        payload: { ...(node?.payload || {}), status: event.status, output, receiptPath: event.receiptPath || '' }
      });
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') runs.current.delete(event.runId);
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten();
  }, [workspace]);

  useEffect(() => {
    const inField = (target: EventTarget | null) => (target as Element | null)?.closest?.('input,textarea,[contenteditable]');
    const keydown = (event: KeyboardEvent) => {
      if (inField(event.target)) return;
      if (event.key === 'Escape') { setPrompt(null); setSelected([]); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? workspace.redo() : workspace.undo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPrompt({ anchor: mouse.current, initialValue: '' }); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') { event.preventDefault(); fileInput.current?.click(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        spawnSeeds([seedFor('browser', { title: 'browser', url: 'https://www.google.com/webhp?igu=1' })], camera.toWorld(mouse.current.x, mouse.current.y));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        spawnArtifactTerminals(mouse.current);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) { event.preventDefault(); selected.forEach(workspace.removeNode); setSelected([]); return; }
      if (selected.length === 1 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const node = workspace.nodes.find((entry) => entry.id === selected[0]);
        if (!node) return;
        const step = event.shiftKey ? 10 : 1;
        workspace.patchNode(node.id, { x: node.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: node.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) });
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        setPrompt({ anchor: mouse.current, initialValue: event.key });
      }
    };
    const pointermove = (event: PointerEvent) => { mouse.current = { x: event.clientX, y: event.clientY }; setPresence(mouse.current); };
    const paste = (event: ClipboardEvent) => {
      if (inField(event.target)) return;
      const value = event.clipboardData?.getData('text/plain');
      if (!value) return;
      event.preventDefault();
      spawnSeeds([seedFromString(value)], camera.toWorld(mouse.current.x, mouse.current.y));
    };
    addEventListener('keydown', keydown);
    addEventListener('pointermove', pointermove);
    addEventListener('paste', paste);
    return () => { removeEventListener('keydown', keydown); removeEventListener('pointermove', pointermove); removeEventListener('paste', paste); };
  }, [camera, selected, spawnArtifactTerminals, spawnSeeds, workspace]);

  return (
    <main
      ref={camera.viewportRef}
      className="hii-canvas"
      tabIndex={-1}
      aria-label="HII canvas"
      onPointerDown={(event) => {
        if ((event.target as Element).closest('[data-node-id],input,textarea,audio,video,a')) return;
        setSelected([]);
        setPrompt(null);
        camera.panStart(event);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const at = camera.toWorld(event.clientX, event.clientY);
        seedsFromDataTransfer(event.dataTransfer).then((seeds) => spawnSeeds(seeds, at));
      }}
    >
      <SpatialActivityLayer nodes={workspace.nodes} selectedIds={selected} />
      <div className="hii-terminal-identity" aria-hidden="true">
        <strong>HII</strong><span>visual terminal</span>
      </div>
      <div ref={camera.worldRef} className="hii-world">
        {workspace.nodes.map((node) => (
          <NodeFrame
            key={node.id}
            node={node}
            selected={selected.includes(node.id)}
            title={titleFor(node)}
            getZoom={() => camera.cam.current.z}
            onSelect={() => { setSelected([node.id]); workspace.bringToFront(node.id); }}
            onCommit={(patch) => workspace.patchNode(node.id, patch)}
            chromeless={node.type === 'canvas-text' || node.type === 'ink' || node.type === 'image'}
          >
            <NodeBody node={node} onPayload={(patch) => workspace.patchNode(node.id, { payload: { ...node.payload, ...patch } })} />
          </NodeFrame>
        ))}
      </div>
      <span className="hii-agent-presence" style={{ left: presence.x, top: presence.y }} aria-hidden="true" />
      {workspace.ready && workspace.nodes.length === 0 && (
        <div className="hii-empty-invite">
          <strong>Everything starts at the prompt.</strong>
          <span>Type anywhere · drop context · ⌘⇧T for a visual job loom</span>
        </div>
      )}
      {prompt && (
        <Prompt
          key={`${prompt.anchor.x}:${prompt.anchor.y}:${prompt.initialValue}`}
          anchor={prompt.anchor}
          initialValue={prompt.initialValue}
          contextLabel={selectedNodes.length ? `${selectedNodes.length} selected · ${selectedNodes.map(titleFor).join(' · ')}` : 'cursor context · local workspace'}
          onDismiss={() => setPrompt(null)}
          onSubmit={(value) => submit(value, prompt.anchor)}
        />
      )}
      <input
        ref={fileInput}
        className="hii-file-input"
        type="file"
        multiple
        aria-label="Upload files to HII"
        onChange={(event) => {
          const files = [...(event.currentTarget.files || [])];
          event.currentTarget.value = '';
          if (!files.length) return;
          void seedsFromFiles(files).then((seeds) => spawnSeeds(seeds, camera.toWorld(mouse.current.x, mouse.current.y)));
        }}
      />
    </main>
  );
}
