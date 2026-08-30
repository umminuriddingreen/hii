'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acknowledgeApplicationLaunch,
  approveContextPack,
  captureInformation,
  compileContextPack,
  listApplicationLaunchRequests,
  listApplications,
  listenAgentEvents,
  startAgent,
  type AgentEventV1,
  type ContextPackV1,
  type HiiApplicationManifest,
  type InformationCaptureResult
} from '@/lib/client/hii-bridge';
import { browserNavigationTarget } from '@/lib/workspace/browser-target';
import { canvasTextSeed, canvasTextSize, clipboardFiles, directPasteSeeds, makeNode, nodeSeedFromResourceProjection, seedFor, seedFromFile, seedFromString, seedsFromDataTransfer, seedsFromFiles, type NodeSeed } from '@/lib/workspace/ingest';
import { HII_PROJECTION_MIME, type ProjectionIntent, type ResourceProjectionSeed } from '@/lib/ecosystem/contracts';
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
import {
  isDirectCanvasTyping,
  isTerminalShortcut,
  terminalSeedFromCommand
} from '@/lib/workspace/terminal-command';
import {
  appendObjectConversationTurn,
  finishObjectConversationTurn,
  objectConversationTurns,
  type ObjectConversationTurn
} from '@/lib/workspace/object-conversation';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { applicationSeed } from '@/lib/workspace/application-seed';
import { MusicPlaylistPanel } from './MusicPlaylistPanel';
import { UpdateBanner } from './UpdateBanner';
import { NativeDevBrowser } from './NativeDevBrowser';
import { HiiMarketplace } from './HiiMarketplace';
import { HiiLinkApp } from './HiiLinkApp';
import { NodeFrame } from './NodeFrame';
import { RegisteredApplication } from './RegisteredApplication';
import { ShellTerminal } from './ShellTerminal';
import { WaymarkApp } from './WaymarkApp';
import { packagePlacementSeed, WAYMARK_PACKAGE, type HiiMarketplacePackage } from '@/lib/marketplace/catalog';
import { useCamera } from './useCamera';
import { useWorkspace, type WorkspacePersistence } from './useWorkspace';
import { SpaceToolbar } from '@/components/spaces/SpaceToolbar';
import { InkBody } from '@/components/spaces/InkBody';
import { inkSeedFromPoints } from '@/components/spaces/ink-capture';
import { isAccountCanvasNode, isAccountCanvasNodeType, isSpaceCanvasNode, isSpaceCanvasNodeType } from '@/components/spaces/space-surface';
import { trackPointerGesture } from '@/lib/workspace/gestures';
import { updateTerminalActivity } from '@/lib/workspace/terminal-activity';
import { fitWorkspaceViewport } from '@/lib/workspace/viewport';

type Point = { x: number; y: number };
export type WorkspaceProjectionRequest = {
  id: string;
  projection: ResourceProjectionSeed;
  intent: ProjectionIntent;
};

export type CanvasImportRequest = {
  id: string;
  seed: NodeSeed;
};
type PromptState = {
  anchor: Point;
  initialValue: string;
  response: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  objectId?: string;
  conversationId?: string;
  contextPack?: ContextPackV1;
};
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

function accountLinkSeed(url: string): NodeSeed {
  const host = hostFor(url);
  return seedFor('link', { url, host, name: host || 'link' });
}

function accountSeedsFromDataTransfer(transfer: DataTransfer): NodeSeed[] {
  const uriValues = transfer.getData('text/uri-list').split('\n').map((value) => value.trim()).filter((value) => value && !value.startsWith('#'));
  if (uriValues.length) {
    const links = uriValues.flatMap((value) => {
      try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) ? [accountLinkSeed(parsed.href)] : [];
      } catch {
        return [];
      }
    });
    if (links.length) return links;
  }
  const value = transfer.getData('text/plain');
  if (!value) return [];
  const trimmed = value.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return [accountLinkSeed(trimmed)];
  return [canvasTextSeed(value.slice(0, 100_000))];
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

function TerminalBody({
  node,
  onPayload,
  onAgentSubmit
}: {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
  onAgentSubmit: (intent: string) => void;
}) {
  const job = text(node.payload.job) || 'visual artifact';
  const cwd = text(node.payload.cwd) || '~/hii';
  const artifact = text(node.payload.artifact) || 'artifact pending';
  const status = text(node.payload.status) || 'ready';
  const operatorTerminal = node.payload.role === 'operator-terminal';
  const agentTerminal = node.payload.role === 'agent-terminal';
  const footerLabel = operatorTerminal || agentTerminal ? 'scope' : 'artifact';
  const footerValue = operatorTerminal || agentTerminal ? text(node.payload.scope) || 'local session' : artifact;
  const lines = Array.isArray(node.payload.lines) ? node.payload.lines.map(text).filter(Boolean) : [];
  const activityLines = Array.isArray(node.payload.activityLines) ? node.payload.activityLines.map(text).filter(Boolean) : [];
  const resultLines = Array.isArray(node.payload.resultLines) ? node.payload.resultLines.map(text).filter(Boolean) : [];
  const draft = text(node.payload.draft);
  const running = status === 'running' || status === 'queued';
  const shellTerminal = operatorTerminal && node.payload.terminalMode === 'shell';
  return (
    <article className="hii-job-terminal" data-status={status}>
      <header>
        <span className="hii-terminal-lamp" aria-hidden="true" />
        <strong>{job}</strong>
        <small>{status}</small>
      </header>
      {shellTerminal ? (
        <ShellTerminal
          sessionId={text(node.payload.sessionId)}
          cwd={cwd}
          onState={(state) => onPayload({
            status: state.status,
            cwd: state.cwd || cwd,
            error: state.error || undefined
          })}
        />
      ) : <pre aria-label={`${job} terminal`}>
        <span className="hii-terminal-path">{cwd}</span>
        {lines.map((line, index) => <span key={`${line}:${index}`}>{line}</span>)}
        {agentTerminal && activityLines.length > 0 && (
          node.payload.activityCollapsed === true
            ? <details className="hii-terminal-activity"><summary>{activityLines.length} activity update{activityLines.length === 1 ? '' : 's'}</summary>{activityLines.map((line, index) => <span key={`${line}:${index}`}>{line}</span>)}</details>
            : <span className="hii-terminal-activity-live">{activityLines.at(-1)}</span>
        )}
        {agentTerminal && resultLines.map((line, index) => <span className="hii-terminal-result" key={`${line}:${index}`}>{line}</span>)}
        {agentTerminal ? (
          <span className="hii-terminal-command-line">
            <b>›</b>
            <input
              autoFocus={status === 'ready'}
              aria-label="Agent terminal intent"
              value={draft}
              disabled={running}
              placeholder={running ? 'agent running…' : 'type an intent…'}
              onChange={(event) => onPayload({ draft: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || running || !draft.trim()) return;
                event.preventDefault();
                onAgentSubmit(draft.trim());
              }}
            />
            {running && <i aria-hidden="true" />}
          </span>
        ) : <span className="hii-terminal-prompt"><b>›</b> <i aria-hidden="true" /></span>}
      </pre>}
      <footer><span>{footerLabel}</span><code>{footerValue}</code></footer>
    </article>
  );
}

/**
 * The text editor used by `note` and `canvas-text` objects. It takes focus when the
 * object was just created by typing or double-clicking, and grows to fit what is written
 * so text is never truncated behind a manual resize.
 */
function CanvasEditor({
  node,
  label,
  value,
  autoFocus,
  onAutoFocused,
  onPayload,
  onResize
}: {
  node: WorkspaceNode;
  label: string;
  value: string;
  autoFocus?: boolean;
  onAutoFocused?: () => void;
  onPayload: (patch: Record<string, unknown>) => void;
  onResize?: (size: { w: number; h: number }) => void;
}) {
  const field = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    onAutoFocused?.();
  }, [autoFocus, onAutoFocused]);

  return (
    <textarea
      ref={field}
      className="hii-node-editor"
      aria-label={label}
      value={value}
      onPointerDown={(event) => event.stopPropagation()}
      onChange={(event) => {
        const next = event.target.value;
        onPayload(node.type === 'canvas-text' ? { text: next } : { content: next });
        if (node.type !== 'canvas-text') return;
        const grown = canvasTextSize(next);
        if (grown.h > node.h) onResize?.({ w: node.w, h: grown.h });
      }}
    />
  );
}

/**
 * A stored document on the canvas. PDFs render in the webview's own viewer,
 * which scrolls page to page inside the node instead of showing a metadata card.
 */
function DocumentBody({ url, name, kind }: { url: string; name: string; kind: string }) {
  const [failed, setFailed] = useState(false);
  const isPdf = kind === 'pdf' || /\.pdf(\?|#|$)/i.test(url);

  if (isPdf && !failed) {
    return (
      <object className="hii-node-document" data={url} type="application/pdf" aria-label={name}>
        {/* Rendered only when the webview declines to embed the PDF itself. */}
        <iframe className="hii-node-document" src={url} title={name} onError={() => setFailed(true)} />
      </object>
    );
  }
  return (
    <div className="hii-node-document-fallback">
      <strong>{name}</strong>
      <a href={url} target="_blank" rel="noreferrer">Open document</a>
    </div>
  );
}

function NodeBody({
  node,
  autoFocus,
  onAutoFocused,
  onPayload,
  onResize,
  onAgentSubmit,
  onInstallPackage,
  onCurationRequest,
  onBrowserAgent,
  onBrowserCapture
}: {
  node: WorkspaceNode;
  autoFocus?: boolean;
  onAutoFocused?: () => void;
  onPayload: (patch: Record<string, unknown>) => void;
  onResize?: (size: { w: number; h: number }) => void;
  onAgentSubmit: (intent: string) => void;
  onInstallPackage: (pkg: HiiMarketplacePackage, destination: string) => void;
  onCurationRequest: (request: string, payload: MusicPanelPayload) => void;
  onBrowserAgent: (request: string) => void;
  onBrowserCapture: (result: InformationCaptureResult) => void;
}) {
  const payload = node.payload;
  const content = text(payload.content) || text(payload.text) || text(payload.output) || text(payload.summary);
  const url = text(payload.url);
  const name = text(payload.name) || text(payload.title) || node.type;

  if (node.type === 'browser' && payload.surface === 'native-dev-browser') {
    return <NativeDevBrowser nodeId={node.id} initialUrl={url} onUrl={(nextUrl) => onPayload({ url: nextUrl, title: hostFor(nextUrl) })} onAgent={onBrowserAgent} onCapture={onBrowserCapture} />;
  }
  if (node.type === 'browser' || node.type === 'link') return <SourceBody node={node} />;
  if (node.type === 'terminal') return <TerminalBody node={node} onPayload={onPayload} onAgentSubmit={onAgentSubmit} />;
  if (node.type === 'intent') return <RequestBody node={node} />;
  if (node.type === 'surface' && payload.surface === 'profile-music') {
    return <MusicPlaylistPanel payload={payload} onPayload={onPayload} onRequestCuration={onCurationRequest} />;
  }
  if (node.type === 'surface' && payload.surface === 'hii-marketplace') return <HiiMarketplace onInstall={onInstallPackage} />;
  if (node.type === 'app' && payload.surface === 'waymark-location') return <WaymarkApp destination={text(payload.destination) || 'this canvas'} onPayload={onPayload} />;
  if (node.type === 'app' && payload.surface === 'hii-link') return <HiiLinkApp />;
  if (node.type === 'app') return <RegisteredApplication name={name} summary={content || 'Registered HII application'} entryUrl={text(payload.entryUrl) || undefined} />;
  if (node.type === 'html') return <iframe className="hii-html" srcDoc={text(payload.srcdoc)} title={name} sandbox="allow-forms allow-scripts" />;
  if (node.type === 'ink') return <InkBody node={node} />;
  if (node.type === 'image' && payload.sticker === true) return <div className="hii-sticker" role="img" aria-label={name}>{text(payload.emoji) || '✦'}</div>;
  if (node.type === 'image' && url) return <img className="hii-node-image" src={url} alt={name} draggable={false} />;
  if (node.type === 'document' && url) return <DocumentBody url={url} name={name} kind={text(payload.kind)} />;
  if (node.type === 'media' && url) {
    return payload.kind === 'audio'
      ? <audio className="hii-node-video" src={url} controls />
      : <video className="hii-node-video" src={url} controls />;
  }
  if (node.type === 'note' || node.type === 'canvas-text') {
    return (
      <CanvasEditor
        node={node}
        label={name}
        value={content}
        autoFocus={autoFocus}
        onAutoFocused={onAutoFocused}
        onPayload={onPayload}
        onResize={onResize}
      />
    );
  }
  return <pre className="hii-node-copy" data-mono={node.type === 'run'}>{content || name}</pre>;
}

function Prompt({
  anchor,
  initialValue,
  mode,
  objectTitle,
  response,
  status,
  timeline,
  contextPack,
  onDismiss,
  onMode,
  onApproveContext,
  onSubmit
}: {
  anchor: Point;
  initialValue: string;
  mode: CanvasModeId;
  objectTitle?: string;
  response: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  timeline: ObjectConversationTurn[];
  contextPack?: ContextPackV1;
  onDismiss: () => void;
  onMode: (mode: CanvasModeId) => void;
  onApproveContext: () => void;
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
        ['/browser [url]', 'open the native development browser'],
        ['/search <query>', 'search inside the native webview'],
        ['/music', 'open profile playlists'],
        ['/marketplace', 'install apps, experiences, skills, and runtimes']
      ].filter(([command]) => command.startsWith(value.trim().toLowerCase()) || value.trim() === '/')
    : [];
  const submit = () => {
    if (value.trim() && status !== 'running' && !contextPack) onSubmit(value.trim());
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
        {objectTitle && (
          <div className="hii-prompt-context">
            <span>Conversation with</span>
            <strong>{objectTitle}</strong>
            <small>{timeline.length} turn{timeline.length === 1 ? '' : 's'}</small>
          </div>
        )}
        {timeline.length > 0 && (
          <ol className="hii-conversation-timeline" aria-label={`Conversation timeline for ${objectTitle || 'canvas'}`}>
            {timeline.slice(-8).map((turn) => (
              <li key={turn.id} data-role={turn.role} data-status={turn.status}>
                <span>{turn.role === 'human' ? 'You' : 'HII'}</span>
                <p>{turn.text}</p>
                <time dateTime={turn.at}>{new Date(turn.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
              </li>
            ))}
          </ol>
        )}
        <div className="hii-prompt-line">
          <input
            ref={input}
            disabled={Boolean(contextPack)}
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
        {contextPack && (
          <section className="hii-context-preflight" aria-label="Context review">
            <header>
              <strong>{contextPack.items.length} context items</strong>
              <span>{contextPack.budget.usedTokens.toLocaleString()} / {contextPack.budget.maximumTokens.toLocaleString()} tokens</span>
            </header>
            <p>{contextPack.risk.reasons.join(' · ')}</p>
            <ul>{contextPack.items.slice(0, 8).map((item) => (
              <li key={`${item.ref.kind}:${item.ref.id}`}><b>{item.title}</b><span>{item.itemType}{item.selected ? ' · selected' : ''}</span></li>
            ))}</ul>
            {contextPack.excluded.length > 0 && <small>{contextPack.excluded.length} item{contextPack.excluded.length === 1 ? '' : 's'} excluded by scope, safety, or budget.</small>}
            <button type="button" onClick={onApproveContext}>Approve this exact context and continue</button>
            <code>{contextPack.fingerprint.slice(0, 18)}…</code>
          </section>
        )}
        {commands.length > 0 && <div className="hii-prompt-commands" aria-label="HII commands">{commands.map(([command, description]) => <span key={command}><b>{command}</b>{description}</span>)}</div>}
        <div className="hii-mode-strip" aria-label="Canvas interaction mode">
          <div>{canvasModes.map((item) => (
            <button key={item.id} type="button" disabled={Boolean(contextPack)} aria-pressed={item.id === mode} onClick={() => onMode(item.id)}>{item.label}</button>
          ))}</div>
          <small>{canvasMode(mode).description}</small>
          <kbd>⇧ Tab</kbd>
        </div>
      </form>
    </div>
  );
}

export function HiiRoot({
  surface = 'workspace',
  spaceId = '',
  creatorId = 'guest:pending',
  persistence,
  allowPhoto = true,
  onShareNode,
  onRequestDevice,
  fileSeeder,
  canvasImportRequest = null,
  projectionRequest = null
}: {
  surface?: 'workspace' | 'space' | 'account';
  spaceId?: string;
  creatorId?: string;
  persistence?: WorkspacePersistence;
  allowPhoto?: boolean;
  onShareNode?: (node: WorkspaceNode) => void;
  onRequestDevice?: () => void;
  fileSeeder?: (files: File[]) => Promise<NodeSeed[]>;
  canvasImportRequest?: CanvasImportRequest | null;
  projectionRequest?: WorkspaceProjectionRequest | null;
} = {}) {
  const isSpace = surface === 'space';
  const isAccount = surface === 'account';
  const isTouchCanvas = isSpace || isAccount;
  const runtimeEnabled = !isTouchCanvas;
  const save = useRef<() => void>(() => {});
  const settleCamera = useCallback(() => save.current(), []);
  const camera = useCamera(settleCamera);
  const workspace = useWorkspace(camera.getViewport, undefined, persistence);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<CanvasModeId>(() => {
    if (typeof window === 'undefined') return defaultCanvasMode;
    const stored = window.localStorage.getItem('hii.canvas.mode.v1');
    return isCanvasMode(stored) ? stored : defaultCanvasMode;
  });
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptVisible, setPromptVisible] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [canvasCommandsOpen, setCanvasCommandsOpen] = useState(false);
  const [toolMessage, setToolMessage] = useState('');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [devFixtureState, setDevFixtureState] = useState<'normal' | 'minimized' | 'maximized'>('normal');
  const mouse = useRef<Point>({ x: 400, y: 280 });
  const activeRun = useRef<string | null>(null);
  const activeAgentTerminals = useRef(new Map<string, string>());
  const pendingContextStart = useRef<null | {
    pack: ContextPackV1;
    start: (approved: ContextPackV1) => Promise<void>;
  }>(null);
  const activeConversation = useRef<{
    runId: string;
    nodeId: string;
    conversationId: string;
    humanTurnId: string;
    assistantText: string;
  } | null>(null);

  const startWithContext = useCallback(async (
    request: { intent: string; mode: CanvasModeId; contextNodeIds: string[] },
    onStarted: (result: { runId: string }) => void | Promise<void>,
    reviewAnchor: Point = mouse.current
  ) => {
    const authority = ['plan', 'browse', 'see'].includes(request.mode) ? 'read-only' : 'workspace';
    const pack = await compileContextPack({
      intent: request.intent,
      mode: request.mode,
      authority,
      selectedObjectIds: request.contextNodeIds,
      spaceId: spaceId || 'default'
    });
    if (pack.risk.action === 'blocked') {
      throw new Error(pack.risk.reasons.join(' ') || 'HII blocked unsafe or missing context.');
    }
    const start = async (approved: ContextPackV1) => {
      const result = await startAgent({
        version: 1,
        intent: request.intent,
        mode: request.mode,
        spaceId: spaceId || 'default',
        contextNodeIds: request.contextNodeIds,
        contextPackId: approved.id,
        contextFingerprint: approved.fingerprint
      });
      await onStarted(result);
    };
    if (pack.risk.action === 'review') {
      pendingContextStart.current = { pack, start };
      setPrompt((current) => ({
        anchor: current?.anchor || reviewAnchor,
        initialValue: current?.initialValue || request.intent,
        response: 'Review the bounded context HII will use before this run starts.',
        status: 'idle',
        objectId: current?.objectId,
        conversationId: current?.conversationId,
        contextPack: pack
      }));
      setPromptVisible(true);
      return false;
    }
    await start(await approveContextPack(pack, true));
    return true;
  }, [spaceId]);

  const approvePendingContext = useCallback(async () => {
    const pending = pendingContextStart.current;
    if (!pending) return;
    setPrompt((current) => current ? { ...current, contextPack: undefined, response: 'Starting with the approved context…', status: 'running' } : current);
    try {
      const approved = await approveContextPack(pending.pack);
      pendingContextStart.current = null;
      await pending.start(approved);
    } catch (error) {
      setPrompt((current) => current ? { ...current, response: error instanceof Error ? error.message : 'HII could not approve this context.', status: 'failed' } : current);
    }
  }, []);
  const curationRun = useRef<{ runId: string; nodeId: string; request: string; text: string } | null>(null);
  const workspaceRef = useRef(workspace);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const applicationCatalog = useRef(new Map<string, HiiApplicationManifest>());
  const applicationPollActive = useRef(false);
  const handledProjectionRequest = useRef<string | null>(null);
  const handledCanvasImportRequest = useRef<string | null>(null);
  workspaceRef.current = workspace;
  save.current = workspace.scheduleSave;
  const devFixtureNode = useMemo(() => {
    const seed = packagePlacementSeed(WAYMARK_PACKAGE, 'HII development board');
    const node = makeNode(seed, 96, 84, 2_147_480_000);
    node.id = 'hii-dev-board-waymark';
    const viewport = typeof window === 'undefined' ? { width: 1440, height: 960 } : { width: window.innerWidth, height: window.innerHeight };
    node.w = devFixtureState === 'maximized' ? Math.max(900, viewport.width - 192) : 1080;
    node.h = devFixtureState === 'maximized' ? Math.max(620, viewport.height - 168) : 720;
    node.payload = { ...node.payload, windowState: devFixtureState };
    return node;
  }, [devFixtureState]);

  useEffect(() => { window.localStorage.setItem('hii.canvas.mode.v1', mode); }, [mode]);

  useEffect(() => {
    if (workspace.initialViewport) camera.setViewport(workspace.initialViewport);
  }, [camera.setViewport, workspace.initialViewport]);

  const spawnSeeds = useCallback((seeds: NodeSeed[], at: Point) => {
    const ids: string[] = [];
    const acceptedSeeds = isSpace
      ? seeds.filter((seed) => isSpaceCanvasNodeType(seed.type))
      : isAccount
        ? seeds.filter((seed) => isAccountCanvasNodeType(seed.type))
        : seeds;
    acceptedSeeds.forEach((seed, index) => {
      const node = makeNode(seed, at.x + index * 24, at.y + index * 24, workspace.takeZ());
      if (isTouchCanvas) {
        node.spaceId = spaceId;
        node.creatorId = creatorId;
        node.permissions = { inheritance: 'space-policy' };
      }
      ids.push(node.id);
      workspace.addNode(node);
    });
    setSelected(ids);
    return ids;
  }, [creatorId, isAccount, isSpace, isTouchCanvas, spaceId, workspace]);

  const spawnCenteredSeed = useCallback((seed: NodeSeed) => {
    const center = camera.centerWorld();
    return spawnSeeds([seed], { x: center.x - seed.w / 2, y: center.y - seed.h / 2 });
  }, [camera, spawnSeeds]);

  const importFiles = useCallback(async (files: File[], at: Point, direct = false) => {
    try {
      const seeds = await (fileSeeder ? fileSeeder(files) : seedsFromFiles(files));
      spawnSeeds(direct ? directPasteSeeds(seeds) : seeds, at);
      setToolMessage(`Added ${seeds.length} file${seeds.length === 1 ? '' : 's'}.`);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setToolMessage(code === 'canvas_asset_batch_too_many'
        ? 'import up to 12 files at once.'
        : code === 'canvas_asset_batch_too_large'
          ? 'each import must be 128 MB or smaller.'
          : error instanceof RangeError
            ? 'each file must be 64 MB or smaller.'
            : 'could not store that file on this device.');
    }
  }, [fileSeeder, spawnSeeds]);

  useEffect(() => {
    if (!workspace.ready || !projectionRequest || handledProjectionRequest.current === projectionRequest.id) return;
    handledProjectionRequest.current = projectionRequest.id;
    const seed = nodeSeedFromResourceProjection(projectionRequest.projection);
    const intent = projectionRequest.intent;
    const anchor = typeof intent.clientX === 'number' && typeof intent.clientY === 'number'
      ? camera.toWorld(intent.clientX, intent.clientY)
      : camera.centerWorld();
    spawnSeeds([seed], { x: anchor.x - seed.w / 2, y: anchor.y - seed.h / 2 });
  }, [camera, projectionRequest, spawnSeeds, workspace.ready]);

  useEffect(() => {
    if (!workspace.ready || !canvasImportRequest || handledCanvasImportRequest.current === canvasImportRequest.id) return;
    handledCanvasImportRequest.current = canvasImportRequest.id;
    const anchor = camera.centerWorld();
    spawnSeeds([canvasImportRequest.seed], {
      x: anchor.x - canvasImportRequest.seed.w / 2,
      y: anchor.y - canvasImportRequest.seed.h / 2,
    });
  }, [camera, canvasImportRequest, spawnSeeds, workspace.ready]);

  useEffect(() => {
    if (!runtimeEnabled || !workspace.ready) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || applicationPollActive.current) return;
      applicationPollActive.current = true;
      try {
        if (!applicationCatalog.current.size) {
          const applications = await listApplications();
          applicationCatalog.current = new Map(applications.map((application) => [application.id, application]));
        }
        const requests = await listApplicationLaunchRequests();
        for (const request of requests) {
          if (cancelled || request.surface !== 'canvas') continue;
          const application = applicationCatalog.current.get(request.applicationId);
          if (!application) continue;
          const existing = workspaceRef.current.nodes.find((node) =>
            node.type === 'app' && (node.payload.applicationId === application.id || node.payload.packageId === application.id)
          );
          if (existing) {
            workspaceRef.current.patchNode(existing.id, {
              payload: {
                ...existing.payload,
                applicationId: application.id,
                windowState: 'normal',
                launchSource: request.source,
                launchReceiptPath: request.receiptPath
              }
            });
            setSelected([existing.id]);
            workspaceRef.current.bringToFront(existing.id);
          } else {
            const seed = applicationSeed(application, request.source, request.receiptPath);
            if (seed) {
              const center = camera.toWorld(window.innerWidth / 2, window.innerHeight / 2);
              spawnSeeds([seed], { x: center.x - seed.w / 2, y: center.y - seed.h / 2 });
            }
          }
          await acknowledgeApplicationLaunch(request.id);
        }
      } catch {
        // Web previews have no packaged CLI. Installed HII retries quietly.
      } finally {
        applicationPollActive.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [camera, runtimeEnabled, spawnSeeds, workspace.ready]);

  const visibleNodes = useMemo(
    () => isSpace
      ? workspace.nodes.filter((node) => isSpaceCanvasNode(node, spaceId))
      : isAccount
        ? workspace.nodes.filter((node) => isAccountCanvasNode(node, spaceId))
        : workspace.nodes,
    [isAccount, isSpace, spaceId, workspace.nodes]
  );

  const fitCanvas = useCallback(() => {
    const viewport = camera.viewportRef.current;
    const fitted = fitWorkspaceViewport(visibleNodes, {
      width: viewport?.clientWidth || window.innerWidth,
      height: viewport?.clientHeight || window.innerHeight
    });
    if (fitted) {
      camera.setViewport(fitted);
      setToolMessage(`Fit ${visibleNodes.length} object${visibleNodes.length === 1 ? '' : 's'} to the canvas.`);
    } else {
      camera.reset();
      setToolMessage('Canvas view reset.');
    }
  }, [camera, visibleNodes]);

  const toggleDrawing = useCallback(() => {
    setDrawing((current) => {
      const next = !current;
      setToolMessage(next ? 'Drawing on · drag anywhere · Esc to stop.' : 'Drawing off.');
      return next;
    });
  }, []);

  const deleteSelection = useCallback(() => {
    if (!selected.length) return;
    selected.forEach(workspace.removeNode);
    setToolMessage(`Deleted ${selected.length} object${selected.length === 1 ? '' : 's'}.`);
    setSelected([]);
  }, [selected, workspace]);

  const shareSelection = useCallback(() => {
    if (!onShareNode || selected.length !== 1) return;
    const node = workspace.nodes.find((entry) => entry.id === selected[0]);
    if (!node) return;
    onShareNode(node);
    setCanvasCommandsOpen(false);
    setToolMessage('Opened sharing for the selected object.');
  }, [onShareNode, selected, workspace.nodes]);

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

  const startTerminalAgent = useCallback(async (nodeId: string, intent: string) => {
    const node = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
    if (!node || node.payload.role !== 'agent-terminal' || !intent.trim()) return;
    const runMode = isCanvasMode(node.payload.mode) ? node.payload.mode : mode;
    const contextNodeIds = Array.isArray(node.payload.contextNodeIds)
      ? node.payload.contextNodeIds.filter((id): id is string => typeof id === 'string' && id !== nodeId).slice(0, 100)
      : [];
    const priorLines = Array.isArray(node.payload.lines) ? node.payload.lines.map(text).filter(Boolean) : [];
    const startedAt = new Date().toISOString();
    workspaceRef.current.patchNode(nodeId, {
      payload: {
        ...node.payload,
        draft: '',
        status: 'running',
        job: `agent · ${runMode}`,
        lines: [...priorLines, `› ${intent}`].slice(-80),
        activityLines: [`Preparing ${canvasMode(runMode).label.toLowerCase()} work…`],
        resultLines: [],
        activityCollapsed: false
      },
      object: {
        ...(node.object || { kind: 'terminal' as const }),
        owner: 'hii',
        status: 'running',
        capabilityId: 'hii.agent.workspace_run',
        audit: [
          ...(node.object?.audit || []),
          { ts: startedAt, actor: 'human' as const, action: 'bound terminal to governed agent run' }
        ].slice(-20)
      }
    });
    try {
      const started = await startWithContext({
        intent: modeIntent(runMode, intent),
        mode: runMode,
        contextNodeIds
      }, async (result) => {
        activeAgentTerminals.current.set(result.runId, nodeId);
        const current = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
        if (current) {
          workspaceRef.current.patchNode(nodeId, {
            payload: { ...current.payload, runId: result.runId, status: 'running' },
            object: { ...(current.object || { kind: 'terminal' as const }), runId: result.runId }
          });
        }
      });
      if (!started) {
        const current = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
        if (current) {
          workspaceRef.current.patchNode(nodeId, {
            payload: { ...current.payload, status: 'waiting_approval', job: `agent · ${runMode} · review` },
            object: { ...(current.object || { kind: 'terminal' as const }), status: 'waiting_approval' }
          });
        }
      }
    } catch (error) {
      const current = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
      if (!current) return;
      const message = error instanceof Error ? error.message : 'HII could not start the agent.';
      const lines = Array.isArray(current.payload.lines) ? current.payload.lines.map(text).filter(Boolean) : [];
      workspaceRef.current.patchNode(nodeId, {
        payload: { ...current.payload, status: 'failed', lines: [...lines, message].slice(-200) },
        object: { ...(current.object || { kind: 'terminal' as const }), status: 'failed' }
      });
    }
  }, [mode, startWithContext]);

  const openObjectConversation = useCallback((node: WorkspaceNode) => {
    const conversationId = text(node.payload.conversationId) || crypto.randomUUID();
    if (!text(node.payload.conversationId)) {
      workspace.patchNode(node.id, {
        payload: { ...node.payload, conversationId, conversationTimeline: [] },
        object: {
          ...(node.object || { kind: 'event' as const }),
          audit: [
            ...(node.object?.audit || []),
            { ts: new Date().toISOString(), actor: 'human' as const, action: 'opened linked object conversation' }
          ].slice(-20)
        }
      });
    }
    const viewport = camera.cam.current;
    const anchor = {
      x: viewport.x + node.x * viewport.z,
      y: viewport.y + (node.y + node.h) * viewport.z
    };
    const timeline = objectConversationTurns(node.payload, conversationId);
    const previous = [...timeline].reverse().find((turn) => turn.role === 'assistant');
    setSelected([node.id]);
    workspace.bringToFront(node.id);
    setPrompt({
      anchor,
      initialValue: '',
      response: previous?.text || '',
      status: 'idle',
      objectId: node.id,
      conversationId
    });
    setPromptVisible(true);
  }, [camera, workspace]);

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

  const openMarketplace = useCallback((at: Point) => {
    const existing = workspace.nodes.find((node) => node.type === 'surface' && node.payload.surface === 'hii-marketplace');
    if (existing) {
      setSelected([existing.id]);
      workspace.bringToFront(existing.id);
      return existing.id;
    }
    return spawnSeeds([{
      type: 'surface',
      w: 980,
      h: 690,
      object: {
        kind: 'interface', owner: 'hii', status: 'ready', source: 'HII community marketplace',
        capabilityId: 'hii.marketplace.browse',
        audit: [{ ts: new Date().toISOString(), actor: 'human', action: 'opened the HII community marketplace' }]
      },
      payload: { surface: 'hii-marketplace', title: 'HII community market' }
    }], at)[0];
  }, [spawnSeeds, workspace]);

  const installPackage = useCallback((pkg: HiiMarketplacePackage, destination: string) => {
    const placement = packagePlacementSeed(pkg, destination);
    const at = camera.toWorld(window.innerWidth / 2, window.innerHeight / 2);
    return spawnSeeds([placement], { x: at.x - 540, y: at.y - 360 })[0];
  }, [camera, spawnSeeds]);

  const appWindowAction = useCallback((node: WorkspaceNode, action: 'minimize' | 'maximize' | 'restore') => {
    if (node.type !== 'app') return;
    const prior = node.payload.restoreBounds && typeof node.payload.restoreBounds === 'object'
      ? node.payload.restoreBounds as { x?: number; y?: number; w?: number; h?: number }
      : null;
    if (action === 'minimize') {
      workspace.patchNode(node.id, { payload: { ...node.payload, windowState: 'minimized' } });
      return;
    }
    if (action === 'maximize') {
      const topLeft = camera.toWorld(16, 54);
      const bottomRight = camera.toWorld(window.innerWidth - 16, window.innerHeight - 16);
      workspace.patchNode(node.id, {
        x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y,
        payload: { ...node.payload, windowState: 'maximized', restoreBounds: { x: node.x, y: node.y, w: node.w, h: node.h } }
      });
      workspace.bringToFront(node.id);
      return;
    }
    workspace.patchNode(node.id, {
      x: prior?.x ?? node.x, y: prior?.y ?? node.y, w: prior?.w ?? 1080, h: prior?.h ?? 720,
      payload: { ...node.payload, windowState: 'normal', restoreBounds: undefined }
    });
  }, [camera, workspace]);

  const tileApps = useCallback(() => {
    const apps = workspace.nodes.filter((node) => node.type === 'app' && node.payload.windowState !== 'minimized');
    if (!apps.length) return;
    const columns = Math.ceil(Math.sqrt(apps.length));
    const rows = Math.ceil(apps.length / columns);
    const topLeft = camera.toWorld(18, 58);
    const bottomRight = camera.toWorld(window.innerWidth - 18, window.innerHeight - 18);
    const gap = 16 / camera.cam.current.z;
    const width = (bottomRight.x - topLeft.x - gap * (columns - 1)) / columns;
    const height = (bottomRight.y - topLeft.y - gap * (rows - 1)) / rows;
    apps.forEach((node, index) => workspace.patchNode(node.id, {
      x: topLeft.x + (index % columns) * (width + gap),
      y: topLeft.y + Math.floor(index / columns) * (height + gap), w: width, h: height,
      payload: { ...node.payload, windowState: 'tiled', restoreBounds: { x: node.x, y: node.y, w: node.w, h: node.h } }
    }));
  }, [camera, workspace]);

  const openDevBrowser = useCallback((at: Point, requestedUrl?: string) => {
    const url = browserNavigationTarget(requestedUrl || '') || 'https://developer.mozilla.org';
    const seed: NodeSeed = {
      type: 'browser',
      w: 1120,
      h: 720,
      object: {
        kind: 'browser',
        owner: 'human',
        status: 'ready',
        source: url,
        capabilityId: 'hii.browser.retrieval',
        audit: [{ ts: new Date().toISOString(), actor: 'human', action: 'opened native development browser' }]
      },
      payload: { surface: 'native-dev-browser', title: hostFor(url), url }
    };
    return spawnSeeds([seed], at)[0];
  }, [spawnSeeds]);

  const requestBrowserAgent = useCallback(async (node: WorkspaceNode, request: string) => {
    const url = text(node.payload.url);
    setSelected([node.id]);
    setPrompt({ anchor: mouse.current, initialValue: '', response: 'Reading the active page context…', status: 'running' });
    setPromptVisible(true);
    try {
      await startWithContext({
        intent: modeIntent(mode, `${request}\n\nActive browser page: ${url}`),
        mode,
        contextNodeIds: [node.id]
      }, (result) => { activeRun.current = result.runId; });
    } catch (error) {
      setPrompt((current) => current ? { ...current, response: error instanceof Error ? error.message : 'HII could not start the browser agent.', status: 'failed' } : current);
    }
  }, [mode, startWithContext]);

  const requestCuration = useCallback(async (nodeId: string, request: string, payload: MusicPanelPayload) => {
    setPrompt({ anchor: mouse.current, initialValue: '', response: 'Preparing a curation proposal…', status: 'running' });
    setPromptVisible(true);
    try {
      await startWithContext({
        intent: buildCurationAgentPrompt(request, payload),
        mode: 'plan',
        contextNodeIds: [nodeId]
      }, (result) => {
        activeRun.current = result.runId;
        curationRun.current = { runId: result.runId, nodeId, request, text: '' };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'HII could not start the curation agent.';
      workspaceRef.current.patchNode(nodeId, { payload: { ...payload, curationError: `${message} Nothing changed.` } });
      setPrompt((current) => current ? { ...current, response: message, status: 'failed' } : current);
    }
  }, [startWithContext]);

  const submit = useCallback(async (intent: string, anchor: Point, objectId?: string, conversationId?: string) => {
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
      if (canMutateCanvas(mode) && /^(?:\/marketplace|\/market|marketplace|open (?:the )?market(?:place)?)$/i.test(intent)) {
        openMarketplace(at);
        setPromptVisible(false);
        return;
      }
      const browserCommand = intent.match(/^\/?(?:browser|search)(?:\s+(.+))?$/i);
      if (canMutateCanvas(mode) && browserCommand) {
        openDevBrowser(at, browserCommand[1]);
        setPrompt(null);
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
        openDevBrowser(at, discovery[1]);
        setPrompt(null);
        setPromptVisible(false);
        return;
      }
      await startWithContext({
        intent: modeIntent(mode, intent),
        mode,
        contextNodeIds: selected
      }, (result) => {
        activeRun.current = result.runId;
        if (objectId && conversationId) {
          const node = workspaceRef.current.nodes.find((entry) => entry.id === objectId);
          if (node) {
            const humanTurnId = crypto.randomUUID();
            const turn: ObjectConversationTurn = {
              id: humanTurnId,
              conversationId,
              at: new Date().toISOString(),
              role: 'human',
              text: intent,
              status: 'running',
              runId: result.runId
            };
            workspaceRef.current.patchNode(objectId, {
              payload: {
                ...node.payload,
                conversationId,
                conversationTimeline: appendObjectConversationTurn(node.payload, turn)
              }
            });
            activeConversation.current = {
              runId: result.runId,
              nodeId: objectId,
              conversationId,
              humanTurnId,
              assistantText: ''
            };
          }
        }
      }, anchor);
    } catch (error) {
      setPrompt((current) => current ? { ...current, response: error instanceof Error ? error.message : 'HII could not start the model.', status: 'failed' } : current);
    }
  }, [camera, mode, openDevBrowser, openMarketplace, openMusicPanel, selected, spawnInformation, spawnSeeds, startWithContext]);

  useEffect(() => {
    if (!runtimeEnabled) return;
    let unlisten = () => {};
    let disposed = false;
    listenAgentEvents((event: AgentEventV1) => {
      const terminalNodeId = activeAgentTerminals.current.get(event.runId);
      if (activeRun.current !== event.runId && !terminalNodeId) return;
      if (terminalNodeId) {
        const node = workspaceRef.current.nodes.find((entry) => entry.id === terminalNodeId);
        if (node) {
          const terminalStatus = event.status === 'completed'
            ? 'completed'
            : event.status === 'failed'
              ? 'failed'
              : event.status === 'cancelled'
                ? 'cancelled'
                : 'running';
          const activity = updateTerminalActivity(node.payload, event);
          const proofRefs = event.receiptPath
            ? [...new Set([...(node.object?.proofRefs || []), event.receiptPath])]
            : node.object?.proofRefs;
          const finished = ['completed', 'failed', 'cancelled'].includes(event.status);
          workspaceRef.current.patchNode(terminalNodeId, {
            payload: {
              ...node.payload,
              status: terminalStatus,
              ...activity,
              receiptPath: event.receiptPath || node.payload.receiptPath
            },
            object: {
              ...(node.object || { kind: 'terminal' as const }),
              status: terminalStatus,
              runId: event.runId,
              proofRefs,
              audit: finished
                ? [
                    ...(node.object?.audit || []),
                    { ts: new Date().toISOString(), actor: 'agent' as const, action: `agent run ${terminalStatus}` }
                  ].slice(-20)
                : node.object?.audit
            }
          });
        }
        if (['completed', 'failed', 'cancelled'].includes(event.status)) activeAgentTerminals.current.delete(event.runId);
        return;
      }
      const curation = curationRun.current?.runId === event.runId ? curationRun.current : null;
      const conversation = activeConversation.current?.runId === event.runId ? activeConversation.current : null;
      if (conversation && event.text) {
        conversation.assistantText += `${conversation.assistantText ? '\n' : ''}${event.text}`;
      }
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
      if (conversation && (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')) {
        const node = workspaceRef.current.nodes.find((entry) => entry.id === conversation.nodeId);
        if (node) {
          const terminalStatus = event.status === 'completed' ? 'completed' : event.status === 'cancelled' ? 'cancelled' : 'failed';
          let timeline = finishObjectConversationTurn(node.payload, conversation.humanTurnId, terminalStatus);
          const assistantText = conversation.assistantText.trim();
          if (assistantText) {
            timeline = appendObjectConversationTurn(
              { ...node.payload, conversationTimeline: timeline },
              {
                id: crypto.randomUUID(),
                conversationId: conversation.conversationId,
                at: new Date().toISOString(),
                role: 'assistant',
                text: assistantText,
                status: terminalStatus,
                runId: event.runId,
                receiptPath: event.receiptPath
              }
            );
          }
          workspaceRef.current.patchNode(node.id, {
            payload: { ...node.payload, conversationId: conversation.conversationId, conversationTimeline: timeline }
          });
        }
        activeConversation.current = null;
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
  }, [runtimeEnabled]);

  useEffect(() => {
    const inField = (target: EventTarget | null) => (target as Element | null)?.closest?.('input,textarea,[contenteditable]');
    const keydown = (event: KeyboardEvent) => {
      if (isAccount && canvasCommandsOpen && event.key === 'Escape') {
        event.preventDefault();
        setCanvasCommandsOpen(false);
        setToolMessage('Commands closed.');
        return;
      }
      if (inField(event.target)) return;
      if (isAccount && isTerminalShortcut(event)) {
        event.preventDefault();
        onRequestDevice?.();
        setToolMessage('Opened devices & models.');
        return;
      }
      if (isAccount && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') {
        event.preventDefault();
        fileInput.current?.click();
        setToolMessage('Choose a file to add.');
        return;
      }
      if (isAccount && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.key.toLowerCase() === 't') {
        event.preventDefault();
        const [id] = spawnCenteredSeed(canvasTextSeed());
        setFocusNodeId(id ?? null);
        setToolMessage('Text added.');
        return;
      }
      if (isAccount && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        const [id] = spawnCenteredSeed(seedFor('note', { content: '', name: 'Note' }));
        setFocusNodeId(id ?? null);
        setToolMessage('Note added.');
        return;
      }
      if (isAccount && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        toggleDrawing();
        return;
      }
      if (isAccount && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.key === '0') {
        event.preventDefault();
        fitCanvas();
        return;
      }
      if (isAccount && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.key === '?') {
        event.preventDefault();
        setCanvasCommandsOpen((open) => !open);
        return;
      }
      if (isAccount && event.key === 'Escape') {
        setDrawing(false);
        setCanvasCommandsOpen(false);
        setSelected([]);
        setToolMessage('Selection and active tool cleared.');
        return;
      }
      if (!runtimeEnabled) {
        if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) {
          event.preventDefault();
          deleteSelection();
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          event.shiftKey ? workspace.redo() : workspace.undo();
        }
        if (selected.length && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          for (const id of selected) {
            const node = workspace.nodes.find((entry) => entry.id === id);
            if (!node) continue;
            workspace.patchNode(node.id, { x: node.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: node.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) });
          }
          setToolMessage(`Moved ${selected.length} object${selected.length === 1 ? '' : 's'} ${step} point${step === 1 ? '' : 's'}.`);
        }
        return;
      }
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
      if (isTerminalShortcut(event)) {
        event.preventDefault();
        const terminalSeed = terminalSeedFromCommand('/terminal');
        if (terminalSeed) spawnSeeds([terminalSeed], camera.toWorld(mouse.current.x, mouse.current.y));
        setPromptVisible(false);
        return;
      }
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
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        openDevBrowser(camera.toWorld(mouse.current.x, mouse.current.y));
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
      if (isDirectCanvasTyping(event)) {
        event.preventDefault();
        const at = camera.toWorld(mouse.current.x, mouse.current.y);
        const [id] = spawnSeeds([canvasTextSeed(event.key)], at);
        setFocusNodeId(id ?? null);
        setPromptVisible(false);
      }
    };
    const pointermove = (event: PointerEvent) => { mouse.current = { x: event.clientX, y: event.clientY }; };
    const paste = (event: ClipboardEvent) => {
      if (inField(event.target)) return;
      const transfer = event.clipboardData;
      if (!transfer) return;
      const at = camera.toWorld(mouse.current.x, mouse.current.y);
      const files = clipboardFiles(transfer);
      if (files.length) {
        if (isSpace && !allowPhoto) return;
        event.preventDefault();
        void importFiles(files, at, true);
        return;
      }
      const value = transfer.getData('text/plain');
      if (!value) return;
      event.preventDefault();
      if (isTouchCanvas) {
        if (isAccount && /^https?:\/\/\S+$/i.test(value.trim())) {
          spawnSeeds([accountLinkSeed(value.trim())], at);
          return;
        }
        spawnSeeds([canvasTextSeed(value.slice(0, 100_000))], at);
        return;
      }
      if (/^https?:\/\/\S+$/i.test(value.trim())) {
        void captureInformation(value.trim())
          .then((result) => spawnInformation(directPasteSeeds(capturedInformationSeeds(result)), { x: at.x, y: at.y - 190 }))
          .catch(() => spawnSeeds(directPasteSeeds([seedFromString(value)]), at));
      } else {
        spawnSeeds(directPasteSeeds([seedFromString(value)]), at);
      }
    };
    addEventListener('keydown', keydown);
    addEventListener('pointermove', pointermove);
    addEventListener('paste', paste);
    return () => { removeEventListener('keydown', keydown); removeEventListener('pointermove', pointermove); removeEventListener('paste', paste); };
  }, [allowPhoto, camera, canvasCommandsOpen, deleteSelection, fitCanvas, importFiles, isAccount, isSpace, isTouchCanvas, onRequestDevice, openDevBrowser, runtimeEnabled, selected, spawnArtifactTerminals, spawnCenteredSeed, spawnInformation, spawnSeeds, toggleDrawing, workspace]);

  const canvasFeedback = toolMessage || (drawing
    ? 'Drawing on · drag anywhere · Esc to stop.'
    : selected.length
      ? `${selected.length} selected · drag to move · option-drag to resize · Delete to remove.`
      : '');

  return (
    <main
      ref={camera.viewportRef}
      className="hii-canvas"
      data-surface={surface}
      data-drop-active={dropActive || undefined}
      tabIndex={-1}
      aria-label="HII canvas"
      onDoubleClick={(event) => {
        if ((event.target as Element).closest('[data-node-id],input,textarea,button,a,[data-workspace-ui]')) return;
        if (isTouchCanvas && drawing) return;
        event.preventDefault();
        const [id] = spawnSeeds([canvasTextSeed()], camera.toWorld(event.clientX, event.clientY));
        setFocusNodeId(id ?? null);
      }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('[data-node-id],input,textarea,audio,video,a')) return;
        setSelected([]);
        setToolMessage('');
        setPromptVisible(false);
        if (isTouchCanvas && drawing) {
          event.preventDefault();
          const start = camera.toWorld(event.clientX, event.clientY);
          const points = [start.x, start.y];
          trackPointerGesture(event.nativeEvent, {
            onMove: (_delta, current) => {
              const point = camera.toWorld(current.clientX, current.clientY);
              points.push(point.x, point.y);
            },
            onEnd: () => {
              const captured = inkSeedFromPoints(points);
              if (captured) spawnSeeds([captured.seed], captured.at);
            }
          });
          return;
        }
        if (camera.touchStart(event)) return;
        camera.panStart(event);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        if (!Array.from(event.dataTransfer.types).includes(HII_PROJECTION_MIME)) setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
        if (isSpace && !allowPhoto) return;
        if (Array.from(event.dataTransfer.types).includes(HII_PROJECTION_MIME)) return;
        const at = camera.toWorld(event.clientX, event.clientY);
        const droppedFiles = [...event.dataTransfer.files];
        if (droppedFiles.length) {
          void importFiles(droppedFiles, at);
        } else if (isAccount) {
          const seeds = accountSeedsFromDataTransfer(event.dataTransfer);
          if (seeds.length) spawnSeeds(seeds, at);
        } else {
          void seedsFromDataTransfer(event.dataTransfer).then((seeds) => { if (seeds.length) spawnSeeds(seeds, at); });
        }
      }}
    >
      {runtimeEnabled && <UpdateBanner />}
      {isTouchCanvas && <SpaceToolbar
        drawing={drawing}
        photo={allowPhoto}
        accountTools={isAccount}
        commandsOpen={isAccount ? canvasCommandsOpen : undefined}
        selectionCount={selected.length}
        onAddImage={() => { fileInput.current?.click(); setToolMessage('Choose a file to add.'); }}
        onAddText={() => {
          const [id] = spawnCenteredSeed(seedFor('canvas-text', { text: '', name: 'Text' }));
          setFocusNodeId(id ?? null);
          setToolMessage('Text added.');
        }}
        onAddNote={() => {
          const [id] = spawnCenteredSeed(seedFor('note', { content: '', name: 'Note' }));
          setFocusNodeId(id ?? null);
          setToolMessage('Note added.');
        }}
        onAddLink={(url) => {
          spawnCenteredSeed(accountLinkSeed(url));
          setToolMessage('Link added.');
        }}
        onAddSticker={() => spawnCenteredSeed({ ...seedFor('image', { sticker: true, emoji: '✦', name: 'Sticker' }), w: 120, h: 120 })}
        onOpenTerminal={() => { onRequestDevice?.(); setToolMessage('Opened devices & models.'); }}
        onUndo={() => { workspace.undo(); setToolMessage('Undid the last canvas change.'); }}
        onRedo={() => { workspace.redo(); setToolMessage('Redid the last canvas change.'); }}
        onFitView={fitCanvas}
        onDeleteSelection={deleteSelection}
        onShareSelection={onShareNode ? shareSelection : undefined}
        onCommandsOpenChange={setCanvasCommandsOpen}
        onToggleDrawing={toggleDrawing}
      />}
      {isAccount && canvasFeedback && <div className="hii-canvas-feedback" role="status" aria-live="polite">{canvasFeedback}</div>}
      {runtimeEnabled && workspace.nodes.some((node) => node.type === 'app') && <div className="hii-app-dock" onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={tileApps}>Tile apps</button>
        {workspace.nodes.filter((node) => node.type === 'app').map((node) => <button key={node.id} data-active={selected.includes(node.id) || undefined} onClick={() => {
          if (node.payload.windowState === 'minimized') workspace.patchNode(node.id, { payload: { ...node.payload, windowState: 'normal' } });
          setSelected([node.id]); workspace.bringToFront(node.id);
        }}>{titleFor(node)}</button>)}
      </div>}
      {runtimeEnabled && process.env.NEXT_PUBLIC_HII_DEV_BOARD === 'waymark' && (
        <section className="hii-dev-board-direct" data-window-state={devFixtureState} style={{ width: devFixtureNode.w, height: devFixtureNode.h }}>
          <div className="hii-app-window-controls" aria-label="Waymark window controls">
            <button aria-label="Minimize Waymark" onClick={() => setDevFixtureState('minimized')}>−</button>
            <button aria-label={devFixtureState === 'maximized' ? 'Restore Waymark' : 'Maximize Waymark'} onClick={() => setDevFixtureState(devFixtureState === 'maximized' ? 'normal' : 'maximized')}>{devFixtureState === 'maximized' ? '↙' : '↗'}</button>
          </div>
          {devFixtureState !== 'minimized' && <WaymarkApp destination="HII development board" onPayload={() => undefined} />}
        </section>
      )}
      <div ref={camera.worldRef} className="hii-world">
        {visibleNodes.filter((node) => node.type !== 'intent').map((node) => (
          <NodeFrame
            key={node.id}
            node={node}
            selected={selected.includes(node.id)}
            title={titleFor(node)}
            getZoom={() => camera.cam.current.z}
            onSelect={() => { setSelected([node.id]); setToolMessage(''); workspace.bringToFront(node.id); }}
            onOpenConversation={() => { if (runtimeEnabled) openObjectConversation(node); }}
            onCommit={(patch) => workspace.patchNode(node.id, patch)}
            onWindowAction={(action) => appWindowAction(node, action)}
            onErase={() => { workspace.removeNode(node.id); setSelected((ids) => ids.filter((id) => id !== node.id)); }}
            onShare={onShareNode && (isAccount || (isSpace && isSpaceCanvasNode(node, spaceId))) ? () => onShareNode(node) : undefined}
            touchControls={isTouchCanvas}
            chromeless={node.payload.canvasPresentation === 'direct-paste' || node.type === 'canvas-text' || node.type === 'ink' || node.type === 'image'}
          >
            <NodeBody
              node={node}
              autoFocus={focusNodeId === node.id}
              onAutoFocused={() => setFocusNodeId(null)}
              onPayload={(patch) => workspace.patchNode(node.id, { payload: { ...node.payload, ...patch } })}
              onResize={(size) => workspace.patchNode(node.id, size)}
              onAgentSubmit={(intent) => void startTerminalAgent(node.id, intent)}
              onInstallPackage={installPackage}
              onCurationRequest={(request, payload) => void requestCuration(node.id, request, payload)}
              onBrowserAgent={(request) => void requestBrowserAgent(node, request)}
              onBrowserCapture={(result) => spawnInformation(capturedInformationSeeds(result), { x: node.x + node.w + 40, y: node.y })}
            />
          </NodeFrame>
        ))}
      </div>
      {runtimeEnabled && promptVisible && prompt && (
        <Prompt
          key={`${prompt.anchor.x}:${prompt.anchor.y}:${prompt.initialValue}`}
          anchor={prompt.anchor}
          initialValue={prompt.initialValue}
          mode={mode}
          objectTitle={prompt.objectId ? titleFor(workspace.nodes.find((node) => node.id === prompt.objectId) || ({ type: 'context', payload: {} } as WorkspaceNode)) : undefined}
          response={prompt.response}
          status={prompt.status}
          contextPack={prompt.contextPack}
          timeline={prompt.objectId
            ? objectConversationTurns(workspace.nodes.find((node) => node.id === prompt.objectId)?.payload || {}, prompt.conversationId)
            : []}
          onDismiss={() => setPromptVisible(false)}
          onMode={setMode}
          onApproveContext={() => void approvePendingContext()}
          onSubmit={(value) => void submit(value, prompt.anchor, prompt.objectId, prompt.conversationId)}
        />
      )}
      {(!isSpace || allowPhoto) && <input
        ref={fileInput}
        className="hii-file-input"
        type="file"
        multiple={!isSpace}
        accept={isSpace ? 'image/*' : undefined}
        capture={isSpace ? 'environment' : undefined}
        aria-label={isSpace ? 'Take or choose a Space photo' : 'Import files to HII'}
        onChange={(event) => {
          const files = [...(event.currentTarget.files || [])];
          event.currentTarget.value = '';
          if (!files.length || (isSpace && !allowPhoto)) return;
          if (isSpace) {
            void Promise.all(files.map((file) => seedFromFile(file, { spaceId }))).then((seeds) => spawnSeeds(seeds, camera.centerWorld()));
          } else {
            void importFiles(files, camera.centerWorld());
          }
        }}
      />}
    </main>
  );
}
