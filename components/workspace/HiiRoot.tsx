'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  captureInformation,
  findInformation,
  listenAgentEvents,
  startAgent,
  type AgentEventV1,
  type InformationCaptureResult,
  type InformationSearchResult
} from '@/lib/client/hii-bridge';
import { makeNode, seedFor, seedFromString, seedsFromDataTransfer, seedsFromFiles, type NodeSeed } from '@/lib/workspace/ingest';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { NodeFrame } from './NodeFrame';
import { useCamera } from './useCamera';
import { useWorkspace } from './useWorkspace';

type Point = { x: number; y: number };

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function titleFor(node: WorkspaceNode) {
  return text(node.payload.title) || text(node.payload.name) || node.object?.kind || node.type;
}

function hostFor(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function capturedInformationSeeds(result: InformationCaptureResult): NodeSeed[] {
  const source = result.source;
  const sourceSeed: NodeSeed = {
    type: 'link',
    w: 480,
    h: 260,
    object: {
      kind: 'source',
      owner: 'hii',
      status: 'ready',
      source: source.url,
      capabilityId: 'hii.information.capture',
      proofRefs: [result.receiptPath, `sha256:${source.contentHash}`],
      audit: [{ ts: source.capturedAt, actor: 'hii', action: 'captured source as durable information' }]
    },
    payload: {
      infoId: source.id,
      title: source.title,
      url: source.url,
      excerpt: source.excerpt,
      author: source.author,
      siteName: source.siteName,
      capturedAt: source.capturedAt,
      contentHash: source.contentHash,
      changed: result.changed,
      receiptId: result.receiptId
    }
  };
  const imageSeeds = result.images.slice(0, 8).map<NodeSeed>((image) => ({
    type: 'image',
    w: 360,
    h: 280,
    object: {
      kind: 'source',
      owner: 'hii',
      status: 'ready',
      source: image.url,
      capabilityId: 'hii.information.capture',
      parentId: source.id,
      proofRefs: [result.receiptPath],
      audit: [{ ts: source.capturedAt, actor: 'hii', action: 'linked image to captured source' }]
    },
    payload: {
      infoId: image.id,
      sourceId: source.id,
      title: image.alt || source.title,
      name: image.alt || 'source image',
      url: image.url,
      context: image.context,
      capturedAt: source.capturedAt
    }
  }));
  return [sourceSeed, ...imageSeeds];
}

function discoveredInformationSeed(result: InformationSearchResult): NodeSeed {
  return {
    type: 'link',
    w: 420,
    h: 220,
    object: {
      kind: 'source',
      owner: 'hii',
      status: result.id ? 'ready' : 'proposed',
      source: result.url,
      capabilityId: 'hii.information.find',
      proofRefs: result.contentHash ? [`sha256:${result.contentHash}`] : undefined,
      audit: [{ ts: result.capturedAt || new Date().toISOString(), actor: 'hii', action: result.id ? 'retrieved captured information' : 'discovered source candidate' }]
    },
    payload: {
      infoId: result.id,
      title: result.title,
      url: result.url,
      excerpt: result.excerpt,
      siteName: result.siteName,
      capturedAt: result.capturedAt,
      contentHash: result.contentHash
    }
  };
}

/**
 * Browser nodes existed before HII moved to information-first interaction.
 * Keep their source data intact, but project them as durable information
 * objects instead of asking the user to operate an embedded browser.
 */
function SourceBody({ node }: { node: WorkspaceNode }) {
  const payload = node.payload;
  const url = text(payload.url);
  const title = text(payload.title) || text(payload.name) || hostFor(url) || 'Web source';
  const excerpt = text(payload.excerpt) || text(payload.summary) || text(payload.content) || text(payload.selection);
  const capturedAt = text(payload.capturedAt) || text(payload.captured_at);
  const provenance = text(payload.source) || text(node.object?.source) || hostFor(url) || 'saved web source';
  const legacy = node.type === 'browser';
  return (
    <article className="hii-source" data-legacy={legacy || undefined}>
      <header>
        <span>{legacy ? 'saved web source' : 'source'}</span>
        <small>{capturedAt ? `captured ${capturedAt}` : 'provenance preserved'}</small>
      </header>
      <div>
        <strong>{title}</strong>
        {excerpt && <p>{excerpt}</p>}
      </div>
      <footer>
        <span>{provenance}</span>
        {/^https?:\/\//i.test(url) && <a href={url} target="_blank" rel="noreferrer">Open source ↗</a>}
      </footer>
    </article>
  );
}

function RequestBody({ node }: { node: WorkspaceNode }) {
  const prompt = text(node.payload.text) || text(node.payload.title);
  const output = text(node.payload.output);
  const status = text(node.payload.status);
  const contextCount = Number(node.payload.contextCount) || 0;
  const state = output.length > 360 ? `…${output.slice(-359)}` : output;
  return (
    <article className="hii-intent-object" data-status={status || 'ready'}>
      <header>
        <span>intent</span>
        <small>{status || 'active'}</small>
      </header>
      <p>{prompt}</p>
      {(state || status === 'running') && <div className="hii-intent-state">{state || 'Observing and acting…'}</div>}
      <footer>
        <span>{contextCount ? `${contextCount} world object${contextCount === 1 ? '' : 's'} in scope` : 'world scope open'}</span>
        <code>{text(node.payload.receiptPath) || (status === 'running' ? 'proof pending' : 'persistent')}</code>
      </footer>
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

  if (node.type === 'browser' || node.type === 'link') return <SourceBody node={node} />;
  if (node.type === 'terminal') return <TerminalBody node={node} />;
  if (node.type === 'intent') return <RequestBody node={node} />;
  if (node.type === 'html') return <iframe className="hii-html" srcDoc={text(payload.srcdoc)} title={name} sandbox="allow-forms allow-scripts" />;
  if (node.type === 'image' && url) return <img className="hii-node-image" src={url} alt={name} draggable={false} />;
  if (node.type === 'media' && url) {
    return payload.kind === 'audio'
      ? <audio className="hii-node-video" src={url} controls />
      : <video className="hii-node-video" src={url} controls />;
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
  response,
  status,
  onDismiss,
  onSubmit
}: {
  anchor: Point;
  initialValue: string;
  response: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  onDismiss: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement | null>(null);
  const commands = value.startsWith('/')
    ? [
        ['/codex <task>', 'run with Codex'],
        ['/claude <task>', 'run with Claude'],
        ['/model [name]', 'choose a local model'],
        ['/proof', 'inspect the latest receipt'],
        ['/status', 'show HII state']
      ].filter(([command]) => command.startsWith(value.trim().toLowerCase()) || value.trim() === '/')
    : [];
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <div
      className="hii-prompt-shell"
      style={{ left: Math.min(anchor.x, window.innerWidth - 24), top: Math.min(anchor.y, window.innerHeight - 90) }}
    >
      <form className="hii-prompt" data-status={status} onSubmit={(event) => { event.preventDefault(); if (value.trim() && status !== 'running') onSubmit(value.trim()); }}>
        <div className="hii-prompt-line">
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setValue('');
                onDismiss();
              }
            }}
            placeholder={response ? 'Continue the conversation…' : 'Start with what you have…'}
            aria-label="Tell HII what should happen"
            autoComplete="off"
            spellCheck
          />
        </div>
        {response && <output className="hii-prompt-response" aria-live="polite">{response}</output>}
        {commands.length > 0 && <div className="hii-prompt-commands" aria-label="HII commands">{commands.map(([command, description]) => <span key={command}><b>{command}</b>{description}</span>)}</div>}
      </form>
    </div>
  );
}

export function HiiRoot() {
  const save = useRef<() => void>(() => {});
  const camera = useCamera(() => save.current());
  const workspace = useWorkspace(camera.getViewport);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<{ anchor: Point; initialValue: string; response: string; status: 'idle' | 'running' | 'completed' | 'failed' } | null>(null);
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

  const spawnInformation = useCallback((seeds: NodeSeed[], at: Point) => {
    const ids = seeds.map((seed, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const node = makeNode(seed, at.x - 210 + column * 430, at.y + 190 + row * 300, workspace.takeZ());
      workspace.addNode(node);
      return node.id;
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
    setPrompt((current) => current ? { ...current, initialValue: intent, response: 'Thinking…', status: 'running' } : current);
    const at = camera.toWorld(anchor.x, anchor.y);
    const [intentId] = spawnSeeds([seedFor('intent', {
      text: intent,
      title: intent,
      status: 'running',
      output: 'Starting…',
      contextCount: selectedNodes.length,
      contextIds: selected
    })], at);
    try {
      if (/^https?:\/\/\S+$/i.test(intent)) {
        const capture = await captureInformation(intent);
        spawnInformation(capturedInformationSeeds(capture), at);
        workspace.patchNode(intentId, {
          object: { kind: 'intent', owner: 'human', status: 'completed', proofRefs: [capture.receiptPath] },
          payload: { text: intent, title: intent, status: 'completed', output: `Captured ${capture.source.title} with ${capture.images.length} linked image${capture.images.length === 1 ? '' : 's'}.`, receiptPath: capture.receiptPath, contextCount: selectedNodes.length, contextIds: selected }
        });
        return;
      }
      const discovery = intent.match(/^(?:find|research|look up|search for)\s+(.+)$/i);
      if (discovery) {
        const results = await findInformation(discovery[1], { web: true, limit: 8 });
        spawnInformation(results.map(discoveredInformationSeed), at);
        workspace.patchNode(intentId, {
          object: { kind: 'intent', owner: 'human', status: 'completed' },
          payload: { text: intent, title: intent, status: 'completed', output: `Found ${results.length} source candidate${results.length === 1 ? '' : 's'}.`, contextCount: selectedNodes.length, contextIds: selected }
        });
        return;
      }
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
        object: { kind: 'intent', owner: 'human', status: 'running', runId: result.runId, memoryRefs: selected },
        payload: { text: intent, title: intent, status: 'running', output: 'Working…', contextCount: selectedNodes.length, contextIds: selected }
      });
    } catch (error) {
      setPrompt((current) => current ? { ...current, response: error instanceof Error ? error.message : 'HII could not start the model.', status: 'failed' } : current);
      workspace.patchNode(intentId, {
        object: { kind: 'intent', owner: 'human', status: 'failed' },
        payload: { text: intent, title: intent, status: 'failed', output: error instanceof Error ? error.message : 'HII could not start the agent.', contextCount: selectedNodes.length, contextIds: selected }
      });
    }
  }, [camera, selected, selectedNodes, spawnInformation, spawnSeeds, workspace]);

  useEffect(() => {
    let unlisten = () => {};
    listenAgentEvents((event: AgentEventV1) => {
      const nodeId = runs.current.get(event.runId);
      if (!nodeId) return;
      const node = workspace.nodes.find((entry) => entry.id === nodeId);
      const previous = text(node?.payload.output);
      const output = event.text ? `${previous}${previous ? '\n' : ''}${event.text}` : previous;
      setPrompt((current) => {
        if (!current || current.status !== 'running') return current;
        const prior = current.response === 'Thinking…' ? '' : current.response;
        const response = event.text ? `${prior}${prior ? '\n' : ''}${event.text}` : prior || 'Thinking…';
        return { ...current, response, status: event.status === 'failed' ? 'failed' : event.status === 'completed' ? 'completed' : 'running' };
      });
      setPrompt((current) => {
        if (!current || current.status !== 'running') return current;
        const prior = current.response === 'Thinking…' ? '' : current.response;
        const response = event.text ? `${prior}${prior ? '\n' : ''}${event.text}` : prior || 'Thinking…';
        return {
          ...current,
          response,
          status: event.status === 'failed' ? 'failed' : event.status === 'completed' ? 'completed' : 'running'
        };
      });
      workspace.patchNode(nodeId, {
        object: { ...node?.object, kind: 'intent', owner: 'human', status: event.status === 'progress' || event.status === 'started' ? 'running' : event.status, runId: event.runId, proofRefs: event.receiptPath ? [event.receiptPath] : node?.object?.proofRefs },
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPrompt({ anchor: mouse.current, initialValue: '', response: '', status: 'idle' }); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') { event.preventDefault(); fileInput.current?.click(); return; }
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
        setPrompt({ anchor: mouse.current, initialValue: event.key, response: '', status: 'idle' });
      }
    };
    const pointermove = (event: PointerEvent) => { mouse.current = { x: event.clientX, y: event.clientY }; };
    const paste = (event: ClipboardEvent) => {
      if (inField(event.target)) return;
      const value = event.clipboardData?.getData('text/plain');
      if (!value) return;
      event.preventDefault();
      const at = camera.toWorld(mouse.current.x, mouse.current.y);
      if (/^https?:\/\/\S+$/i.test(value.trim())) {
        void captureInformation(value.trim())
          .then((result) => spawnInformation(capturedInformationSeeds(result), { x: at.x, y: at.y - 190 }))
          .catch(() => spawnSeeds([seedFromString(value)], at));
      } else {
        spawnSeeds([seedFromString(value)], at);
      }
    };
    addEventListener('keydown', keydown);
    addEventListener('pointermove', pointermove);
    addEventListener('paste', paste);
    return () => { removeEventListener('keydown', keydown); removeEventListener('pointermove', pointermove); removeEventListener('paste', paste); };
  }, [camera, selected, spawnArtifactTerminals, spawnInformation, spawnSeeds, workspace]);

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
      {prompt && (
        <Prompt
          key={`${prompt.anchor.x}:${prompt.anchor.y}:${prompt.initialValue}`}
          anchor={prompt.anchor}
          initialValue={prompt.initialValue}
          response={prompt.response}
          status={prompt.status}
          onDismiss={() => setPrompt(null)}
          onSubmit={(value) => void submit(value, prompt.anchor)}
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
