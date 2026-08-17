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
import {
  canvasMode,
  canvasModes,
  canMutateCanvas,
  defaultCanvasMode,
  isCanvasMode,
  modeIntent,
  nextCanvasMode,
  type CanvasModeId
} from '@/lib/workspace/canvas-modes';
import {
  buildCurationAgentPrompt,
  createMusicPanelPayload,
  normalizeMusicPanelPayload,
  parseCurationProposal,
  type MusicPanelPayload
} from '@/lib/workspace/music-playlists';
import { terminalSeedFromCommand } from '@/lib/workspace/terminal-command';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { MusicPlaylistPanel } from './MusicPlaylistPanel';
import { NodeFrame } from './NodeFrame';
import { useCamera } from './useCamera';
import { useWorkspace } from './useWorkspace';

type Point = { x: number; y: number };
const RESPONSE_URL = /(https?:\/\/[^\s<>()]+)/g;

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

function PromptResponse({ value, running }: { value: string; running: boolean }) {
  const external = /external context|web_search|web_fetch|https?:\/\//i.test(value);
  return (
    <output className="hii-prompt-response" data-external={external || undefined} aria-live="polite">
      {external && <span className="hii-external-context-state"><i aria-hidden="true" />{running ? 'External context loading' : 'External context loaded'}</span>}
      {value.split('\n').map((line, lineIndex) => (
        <span className="hii-prompt-response-line" key={`${line}:${lineIndex}`}>
          {line.split(RESPONSE_URL).map((part, partIndex) => /^https?:\/\//i.test(part)
            ? <a href={part} target="_blank" rel="noreferrer" key={`${part}:${partIndex}`}>{part}</a>
            : <span key={`${part}:${partIndex}`}>{part}</span>)}
        </span>
      ))}
    </output>
  );
}

function isAgentPlaceholder(value: string) {
  return value === 'Thinking…'
    || value === 'Searching external context…'
    || /^(?:Build|Plan|Browse|See|Show) mode · .+…$/.test(value);
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
  const operatorTerminal = node.payload.role === 'operator-terminal';
  const footerLabel = operatorTerminal ? 'scope' : 'artifact';
  const footerValue = operatorTerminal ? text(node.payload.scope) || 'local session' : artifact;
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
      <footer><span>{footerLabel}</span><code>{footerValue}</code></footer>
    </article>
  );
}

function NodeBody({
  node,
  onPayload,
  onCurationRequest
}: {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
  onCurationRequest: (request: string, payload: MusicPanelPayload) => void;
}) {
  const payload = node.payload;
  const content = text(payload.content) || text(payload.text) || text(payload.output) || text(payload.summary);
  const url = text(payload.url);
  const name = text(payload.name) || text(payload.title) || node.type;

  if (node.type === 'browser' || node.type === 'link') return <SourceBody node={node} />;
  if (node.type === 'terminal') return <TerminalBody node={node} />;
  if (node.type === 'intent') return <RequestBody node={node} />;
  if (node.type === 'surface' && payload.surface === 'profile-music') {
    return <MusicPlaylistPanel payload={payload} onPayload={onPayload} onRequestCuration={onCurationRequest} />;
  }
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
  mode,
  response,
  status,
  onDismiss,
  onMode,
  onSubmit
}: {
  anchor: Point;
  initialValue: string;
  mode: CanvasModeId;
  response: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  onDismiss: () => void;
  onMode: (mode: CanvasModeId) => void;
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
        ['/status', 'show HII state'],
        ['/terminal [folder]', 'create a local terminal object'],
        ['/music', 'open profile playlists']
      ].filter(([command]) => command.startsWith(value.trim().toLowerCase()) || value.trim() === '/')
    : [];
  const submit = () => {
    if (value.trim() && status !== 'running') onSubmit(value.trim());
  };
  useEffect(() => { input.current?.focus(); }, []);
  const promptWidth = Math.min(640, window.innerWidth - 32);
  const promptLeft = Math.max(16, Math.min(anchor.x - 14, window.innerWidth - promptWidth - 16));
  const promptTop = Math.max(16, Math.min(anchor.y + 14, window.innerHeight - 90));
  return (
    <div
      className="hii-prompt-shell"
      style={{ left: promptLeft, top: promptTop }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form className="hii-prompt" data-mode={mode} data-status={status} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="hii-prompt-line">
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                onMode(nextCanvasMode(mode));
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setValue('');
                onDismiss();
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={response ? `Continue in ${canvasMode(mode).label} mode…` : `${canvasMode(mode).label}: ${canvasMode(mode).description}`}
            aria-label="Tell HII what should happen"
            autoComplete="off"
            spellCheck
          />
        </div>
        {response && <PromptResponse value={response} running={status === 'running'} />}
        {commands.length > 0 && <div className="hii-prompt-commands" aria-label="HII commands">{commands.map(([command, description]) => <span key={command}><b>{command}</b>{description}</span>)}</div>}
        <div className="hii-mode-strip" aria-label="Canvas interaction mode">
          <div>{canvasModes.map((item) => (
            <button key={item.id} type="button" aria-pressed={item.id === mode} onClick={() => onMode(item.id)}>{item.label}</button>
          ))}</div>
          <small>{canvasMode(mode).description}</small>
          <kbd>⇧ Tab</kbd>
        </div>
      </form>
    </div>
  );
}

export function HiiRoot() {
  const save = useRef<() => void>(() => {});
  const camera = useCamera(() => save.current());
  const workspace = useWorkspace(camera.getViewport);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<CanvasModeId>(() => {
    if (typeof window === 'undefined') return defaultCanvasMode;
    const stored = window.localStorage.getItem('hii.canvas.mode.v1');
    return isCanvasMode(stored) ? stored : defaultCanvasMode;
  });
  const [prompt, setPrompt] = useState<{ anchor: Point; initialValue: string; response: string; status: 'idle' | 'running' | 'completed' | 'failed' } | null>(null);
  const [promptVisible, setPromptVisible] = useState(false);
  const mouse = useRef<Point>({ x: 400, y: 280 });
  const activeRun = useRef<string | null>(null);
  const curationRun = useRef<{ runId: string; nodeId: string; request: string; text: string } | null>(null);
  const workspaceRef = useRef(workspace);
  const fileInput = useRef<HTMLInputElement | null>(null);
  workspaceRef.current = workspace;
  save.current = workspace.scheduleSave;

  useEffect(() => { window.localStorage.setItem('hii.canvas.mode.v1', mode); }, [mode]);

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

  const openMusicPanel = useCallback((at: Point) => {
    const existing = workspace.nodes.find((node) => node.type === 'surface' && node.payload.surface === 'profile-music');
    if (existing) {
      setSelected([existing.id]);
      workspace.bringToFront(existing.id);
      return existing.id;
    }
    const seed: NodeSeed = {
      type: 'surface',
      w: 800,
      h: 740,
      object: {
        kind: 'interface',
        owner: 'hii',
        status: 'ready',
        source: 'HII profile music v1',
        capabilityId: 'hii.profile.music-playlists',
        audit: [{ ts: new Date().toISOString(), actor: 'human', action: 'opened profile music surface' }]
      },
      payload: createMusicPanelPayload()
    };
    return spawnSeeds([seed], at)[0];
  }, [spawnSeeds, workspace]);

  const requestCuration = useCallback(async (nodeId: string, request: string, payload: MusicPanelPayload) => {
    setPrompt({ anchor: mouse.current, initialValue: '', response: 'Preparing a curation proposal…', status: 'running' });
    setPromptVisible(true);
    try {
      const result = await startAgent({
        version: 1,
        intent: buildCurationAgentPrompt(request, payload),
        contextNodeIds: [nodeId],
        context: { surface: 'profile-music', proposalOnly: true }
      });
      activeRun.current = result.runId;
      curationRun.current = { runId: result.runId, nodeId, request, text: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'HII could not start the curation agent.';
      workspaceRef.current.patchNode(nodeId, { payload: { ...payload, curationError: `${message} Nothing changed.` } });
      setPrompt((current) => current ? { ...current, response: message, status: 'failed' } : current);
    }
  }, []);

  const submit = useCallback(async (intent: string, anchor: Point) => {
    const activeMode = canvasMode(mode);
    setPrompt((current) => current ? {
      ...current,
      initialValue: intent,
      response: mode === 'browse' ? 'Searching external context…' : `${activeMode.label} mode · ${activeMode.verb}…`,
      status: 'running'
    } : current);
    const at = camera.toWorld(anchor.x, anchor.y);
    try {
      const terminalSeed = terminalSeedFromCommand(intent);
      if (terminalSeed) {
        if (mode !== 'build') {
          setPrompt((current) => current ? { ...current, response: 'Terminal objects are created in Build mode. Switch to Build, then run this command again.', status: 'failed' } : current);
          return;
        }
        spawnSeeds([terminalSeed], at);
        setPrompt(null);
        setPromptVisible(false);
        return;
      }
      if (canMutateCanvas(mode) && /^(?:\/music|\/playlist|music|open (?:music|playlists?))$/i.test(intent)) {
        openMusicPanel(at);
        setPromptVisible(false);
        return;
      }
      if (canMutateCanvas(mode) && /^https?:\/\/\S+$/i.test(intent)) {
        const capture = await captureInformation(intent);
        spawnInformation(capturedInformationSeeds(capture), at);
        setPrompt((current) => current ? { ...current, response: `Captured ${capture.source.title} with ${capture.images.length} linked image${capture.images.length === 1 ? '' : 's'}.`, status: 'completed' } : current);
        return;
      }
      const discovery = intent.match(/^(?:find|research|look up|search for)\s+(.+)$/i);
      if (canMutateCanvas(mode) && discovery) {
        const results = await findInformation(discovery[1], { web: true, limit: 8 });
        spawnInformation(results.map(discoveredInformationSeed), at);
        const links = results.map((result) => `${result.title}\n${result.url}`).join('\n');
        setPrompt((current) => current ? {
          ...current,
          response: `External context loaded · ${results.length} source candidate${results.length === 1 ? '' : 's'}.${links ? `\n${links}` : ''}`,
          status: 'completed'
        } : current);
        return;
      }
      const result = await startAgent({
        version: 1,
        intent: modeIntent(mode, intent),
        mode,
        contextNodeIds: selected,
        context: {
          anchor,
          mode,
          selected: selectedNodes.map((node) => ({
            id: node.id,
            type: node.type,
            title: titleFor(node),
            object: node.object,
            payload: node.payload
          }))
        }
      });
      activeRun.current = result.runId;
    } catch (error) {
      setPrompt((current) => current ? { ...current, response: error instanceof Error ? error.message : 'HII could not start the model.', status: 'failed' } : current);
    }
  }, [camera, mode, openMusicPanel, selected, selectedNodes, spawnInformation, spawnSeeds]);

  useEffect(() => {
    let unlisten = () => {};
    let disposed = false;
    listenAgentEvents((event: AgentEventV1) => {
      if (activeRun.current !== event.runId) return;
      const curation = curationRun.current?.runId === event.runId ? curationRun.current : null;
      if (curation && event.text) curation.text += `${curation.text ? '\n' : ''}${event.text}`;
      setPrompt((current) => {
        if (!current || current.status !== 'running') return current;
        if (curation) {
          return {
            ...current,
            response: event.status === 'failed'
              ? 'HII could not prepare the proposal. Nothing changed.'
              : event.status === 'completed'
                ? 'Curation proposal ready in the music panel.'
                : 'Preparing a curation proposal…',
            status: event.status === 'failed' ? 'failed' : event.status === 'completed' ? 'completed' : 'running'
          };
        }
        const prior = isAgentPlaceholder(current.response) ? '' : current.response;
        const response = event.text ? `${prior}${prior ? '\n' : ''}${event.text}` : prior || 'Thinking…';
        return {
          ...current,
          response,
          status: event.status === 'failed' ? 'failed' : event.status === 'completed' ? 'completed' : 'running'
        };
      });
      if (curation && (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')) {
        const node = workspaceRef.current.nodes.find((entry) => entry.id === curation.nodeId);
        if (node) {
          const panel = normalizeMusicPanelPayload(node.payload);
          if (event.status === 'completed') {
            try {
              const proposal = parseCurationProposal(curation.text, curation.request, panel);
              workspaceRef.current.patchNode(node.id, { payload: { ...panel, proposal, curationError: undefined } });
            } catch (error) {
              workspaceRef.current.patchNode(node.id, { payload: { ...panel, curationError: error instanceof Error ? error.message : 'Invalid proposal. Nothing changed.' } });
            }
          } else {
            workspaceRef.current.patchNode(node.id, { payload: { ...panel, curationError: 'The curation run did not complete. Nothing changed.' } });
          }
        }
        curationRun.current = null;
      }
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') activeRun.current = null;
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  useEffect(() => {
    const inField = (target: EventTarget | null) => (target as Element | null)?.closest?.('input,textarea,[contenteditable]');
    const keydown = (event: KeyboardEvent) => {
      if (inField(event.target)) return;
      if (event.key === 'Tab' && event.shiftKey) {
        event.preventDefault();
        setMode((current) => nextCanvasMode(current));
        setPrompt((current) => ({
          anchor: mouse.current,
          initialValue: current?.initialValue || '',
          response: current?.response || '',
          status: current?.status || 'idle'
        }));
        setPromptVisible(true);
        return;
      }
      if (event.key === 'Escape') { setPromptVisible(false); setSelected([]); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? workspace.redo() : workspace.undo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPrompt((current) => ({
          anchor: mouse.current,
          initialValue: '',
          response: current?.response || '',
          status: current?.status || 'idle'
        }));
        setPromptVisible(true);
        return;
      }
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
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1 && event.key.trim()) {
        event.preventDefault();
        setPrompt((current) => ({
          anchor: mouse.current,
          initialValue: event.key,
          response: current?.response || '',
          status: current?.status || 'idle'
        }));
        setPromptVisible(true);
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
        setPromptVisible(false);
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
        {workspace.nodes.filter((node) => node.type !== 'intent').map((node) => (
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
            <NodeBody
              node={node}
              onPayload={(patch) => workspace.patchNode(node.id, { payload: { ...node.payload, ...patch } })}
              onCurationRequest={(request, payload) => void requestCuration(node.id, request, payload)}
            />
          </NodeFrame>
        ))}
      </div>
      {promptVisible && prompt && (
        <Prompt
          key={`${prompt.anchor.x}:${prompt.anchor.y}:${prompt.initialValue}`}
          anchor={prompt.anchor}
          initialValue={prompt.initialValue}
          mode={mode}
          response={prompt.response}
          status={prompt.status}
          onDismiss={() => setPromptVisible(false)}
          onMode={setMode}
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
