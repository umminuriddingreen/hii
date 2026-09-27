'use client';

import { CanvasThemeToggle } from './CanvasThemeToggle';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle,
  CaretLeft,
  CaretRight,
  Command,
  CornersOut,
  DotsThree,
  GearSix,
  Globe,
  ListBullets,
  Minus,
  Note as NoteIcon,
  Paperclip,
  PencilSimple,
  Plus,
  PresentationChart,
  Shapes,
  SlidersHorizontal,
  Sparkle,
  TerminalWindow,
  TextT
} from '@phosphor-icons/react';
import { APPLICATION_POLL_INTERVAL_MS, shouldSkipApplicationPoll } from '@/lib/workspace/application-poll';
import {
  acknowledgeApplicationLaunch,
  agentRequestFromContextPack,
  approveContextPack,
  cancelAgent,
  captureInformation,
  compileContextPack,
  formatActiveState,
  listApplicationLaunchRequests,
  listApplications,
  findInformation,
  listenAgentEvents,
  readAgentHome,
  requestFeature,
  buildHiiFeature,
  runtimeSpaceId,
  startAgent,
  stopTerminalSession,
  writeTerminalSession,
  type AgentEventV1,
  type ContextPackV1,
  type HiiApplicationManifest,
  type InformationSearchResult,
  type InformationCaptureResult
} from '@/lib/client/hii-bridge';
import { RunBody } from '@/components/workspace/RunBody';
import { handleCompletions, resolveHandles } from '@/lib/workspace/handles';
import { workspaceNodeTitle } from '@/lib/workspace/search';
import { seedsFromRunOutput } from '@/lib/workspace/stdout-types';
import { TypedOutput } from '@/components/workspace/TypedOutput';
import { renderedBrowserSeed } from '@/lib/workspace/browser-seed';
import { canvasTextSeed, canvasTextSize, clipboardFiles, directPasteSeeds, makeNode, nodeSeedFromResourceProjection, seedFor, seedFromFile, seedFromString, seedFromUrl, seedsFromDataTransfer, seedsFromFiles, type NodeSeed } from '@/lib/workspace/ingest';
import { flowSeedPlacements } from '@/lib/workspace/placement';
import { HII_PROJECTION_MIME, type ProjectionIntent, type ResourceProjectionSeed } from '@/lib/ecosystem/contracts';
import {
  canvasMode,
  canvasModes,
  canMutateCanvas,
  defaultCanvasMode,
  isCanvasMode,
  modeIntent,
  nextCanvasMode,
  presentationRequest,
  type CanvasModeId
} from '@/lib/workspace/canvas-modes';
import {
  isAssistantShortcut,
  isDirectCanvasTyping,
  isTerminalShortcut,
  objectiveSeedFromText,
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
import { UpdateBanner, UpdateStatusProvider } from './UpdateBanner';
import { NodeFrame } from './NodeFrame';
import { ShellTerminal } from './ShellTerminal';
import { KEY_ZOOM_STEP, cameraKeyIntent, useCamera } from './useCamera';
import { useWorkspace, type WorkspacePersistence } from './useWorkspace';
import { InkBody } from '@/components/spaces/InkBody';
import { inkSeedFromPoints } from '@/components/spaces/ink-capture';
import { isAccountCanvasNode, isAccountCanvasNodeType, isSpaceCanvasNode, isSpaceCanvasNodeType } from '@/components/spaces/space-surface';
import { trackPointerGesture } from '@/lib/workspace/gestures';
import { fitWorkspaceViewport, visibleWorkspaceNodeIds } from '@/lib/workspace/viewport';
import { canvasManagerFocusNodes, type CanvasManagerBoard } from '@/lib/workspace/canvas-manager';
import { CanvasManager } from './CanvasManager';
import type { SearchableWorkspace } from '@/lib/workspace/cross-workspace-search';
import { nodesInMarquee, type MarqueeRect } from '@/lib/workspace/selection';
import { historyShortcut } from '@/lib/workspace/history-shortcut';
import { mergeAgentResponse } from '@/lib/workspace/agent-stream';
import { browserCanvasAssetUrl } from '@/lib/web/canvas-assets';
import { VoiceInputButton } from './VoiceInputButton';
import { downloadWorkspaceOutput, ExportOutputPanel } from './ExportOutputPanel';
import { CanvasToolbar, type CanvasTool } from './CanvasToolbar';
import { CanvasOasis } from './CanvasOasis';
import { DEFAULT_WEB_COMMAND_SHORTCUT, commandShortcutLabel, matchesCommandShortcut, readCommandShortcut, saveCommandShortcut } from '@/lib/workspace/command-shortcut';
import { CanvasSelectionBar, type CanvasSelectionAction } from './CanvasSelectionBar';
import { CanvasObjectInspector } from './CanvasObjectInspector';
import { useUpdateStatusAccess } from './UpdateBanner';
import { canvasObjectPayload, canvasObjectState, type CanvasShapeKind } from '@/lib/workspace/canvas-objects';
import { duplicateWorkspaceNodes, linkWorkspaceNodes } from '@/lib/workspace/selection';
import { alignWorkspaceNodes, distributeWorkspaceNodes, snapWorkspaceRect } from '@/lib/workspace/snap';
import type { NodeTransformDetail } from './nodeTransform';

const NativeDevBrowser = lazy(() => import('./NativeDevBrowser').then((module) => ({ default: module.NativeDevBrowser })));

const FIRST_RUN_TERMINAL_PREFACE = [
  '\x1b[1;97m ██╗  ██╗██╗██╗',
  ' ██║  ██║██║██║',
  ' ███████║██║██║',
  ' ██╔══██║██║██║',
  ' ██║  ██║██║██║',
  ' ╚═╝  ╚═╝╚═╝╚═╝\x1b[0m',
  '',
  '\x1b[1mWelcome to HII, your Human Information Interface.\x1b[0m',
  '',
  '  \x1b[32m/login codex\x1b[0m   sign in with your ChatGPT plan',
  '  \x1b[32m/providers\x1b[0m     inspect available accounts and runtimes',
  '  \x1b[32m/help\x1b[0m          see everything this terminal can do',
  '',
  '\x1b[90mThis is a real HII terminal. Local shell and file authority stay on this computer.\x1b[0m'
].join('\n');
const RegisteredApplication = lazy(() => import('./RegisteredApplication').then((module) => ({ default: module.RegisteredApplication })));

type Point = { x: number; y: number };

function DeferredSurface({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="hii-deferred-surface" aria-label="Opening HII surface" />}>{children}</Suspense>;
}

function CanvasChrome({
  drawing,
  selectionCount,
  onAddNote,
  onAddText,
  onAddFrame,
  onAddFile,
  onDraw,
  onPresentation,
  onSearch,
  onTerminal,
  onAsk,
  onActivity,
  onArrangeImages,
  onZoomOut,
  onZoomIn,
  onFit
}: {
  drawing: boolean;
  selectionCount: number;
  onAddNote: () => void;
  onAddText: () => void;
  onAddFrame: () => void;
  onAddFile: () => void;
  onDraw: () => void;
  onPresentation: () => void;
  onSearch: () => void;
  onTerminal: () => void;
  onAsk: () => void;
  onActivity: () => void;
  onArrangeImages: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const tool = (label: string, shortcut: string, icon: React.ReactNode, action: () => void, pressed?: boolean) => (
    <button type="button" data-tooltip={`${label}${shortcut ? ` · ${shortcut}` : ''}`} aria-label={`${label}${shortcut ? ` · ${shortcut}` : ''}`} aria-pressed={pressed} onClick={action}>
      {icon}
    </button>
  );
  return <div className="hii-freeform-chrome" data-workspace-ui onPointerDown={(event) => event.stopPropagation()}>
    <nav className="hii-freeform-tools" aria-label="Canvas tools">
      {tool(toolsOpen ? 'Hide tools' : 'Show tools', '', <Plus size={20} />, () => { setToolsOpen((value) => !value); setMoreOpen(false); }, toolsOpen)}
      {toolsOpen && <>
        {tool('Add note', 'N', <NoteIcon size={20} />, onAddNote)}
        {tool('Add text', 'T', <TextT size={20} />, onAddText)}
        {tool('Add frame', 'F', <Shapes size={20} />, onAddFrame)}
        {tool('Add file', '⌘U', <Paperclip size={20} />, onAddFile)}
        {tool(drawing ? 'Stop drawing' : 'Draw', 'D', <PencilSimple size={20} />, onDraw, drawing)}
        {tool('More', '', <DotsThree size={22} weight="bold" />, () => setMoreOpen((value) => !value), moreOpen)}
      </>}
      {moreOpen && <menu className="hii-freeform-more" aria-label="More canvas actions">
        <button type="button" onClick={onTerminal}><TerminalWindow size={17} />Terminal <kbd>⌘ Space</kbd></button>
        <button type="button" onClick={onSearch}><Globe size={17} />Web search <kbd>⌘ T</kbd></button>
        <button type="button" onClick={onPresentation}><PresentationChart size={17} />Presentation</button>
        <button type="button" onClick={onAsk}><Sparkle size={17} />Information terminal <kbd>⌘ K</kbd></button>
        <button type="button" onClick={onActivity}><ListBullets size={17} />Activity & proof <kbd>⌘ 2</kbd></button>
        <button type="button" onClick={onArrangeImages}><SlidersHorizontal size={17} />Arrange images</button>
        <hr />
        <button type="button" onClick={onZoomOut}><Minus size={17} />Zoom out <kbd>⌘ −</kbd></button>
        <button type="button" onClick={onZoomIn}><Plus size={17} />Zoom in <kbd>⌘ +</kbd></button>
        <button type="button" onClick={onFit}><CornersOut size={17} />Fit canvas <kbd>0</kbd></button>
        {selectionCount > 0 && <output><CheckCircle size={16} weight="fill" />{selectionCount} selected</output>}
      </menu>}
    </nav>
  </div>;
}
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
  menu?: 'commands' | 'settings';
};

const promptSlashCommands = [
  ['/codex <task>', 'Run with Codex'],
  ['/claude <task>', 'Run with Claude'],
  ['/model [name]', 'Choose a local model'],
  ['/proof', 'Inspect the latest receipt'],
  ['/presentation [direction]', 'Make an editable presentation'],
  ['/status', 'Show HII state'],
  ['/terminal [folder]', 'Create a local terminal'],
  ['/browser [url]', 'Open the native browser'],
  ['/search <query>', 'Search inside the native browser'],
  ['/feature <request>', 'Save a feature request to your HII board']
] as const;

const promptKeyboardCommands = [
  ['⌘ K', 'Information terminal'],
  ['⌘ T', 'Search Google on the canvas'],
  ['⌘ Space / ⌥ Space', 'Open or hide the HII terminal'],
  ['⌘ ⇧ T', 'Move the terminal between dock and canvas'],
  ['⌘ ⇧ B', 'Open the native browser'],
  ['⌘ U', 'Import files'],
  ['⌘ Z / ⇧ ⌘ Z', 'Undo / redo'],
  ['⇧ Tab', 'Cycle Build, Plan, Browse, See, Present'],
  ['?', 'Information terminal'],
  ['0', 'Fit the canvas'],
  ['Arrow keys', 'Pan, or move selected objects'],
  ['Delete', 'Remove selected objects'],
  ['Esc', 'Dismiss, clear, or open canvas manager']
] as const;

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

function accountSeedsFromDataTransfer(transfer: DataTransfer): NodeSeed[] {
  const uriValues = transfer.getData('text/uri-list').split('\n').map((value) => value.trim()).filter((value) => value && !value.startsWith('#'));
  if (uriValues.length) {
    const links = uriValues.flatMap((value) => {
      try {
        const parsed = new URL(value);
        const seed = ['http:', 'https:'].includes(parsed.protocol) ? renderedBrowserSeed(parsed.href) : null;
        return seed ? [seed] : [];
      } catch {
        return [];
      }
    });
    if (links.length) return links;
  }
  const value = transfer.getData('text/plain');
  if (!value) return [];
  const trimmed = value.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    const seed = renderedBrowserSeed(trimmed);
    return seed ? [seed] : [];
  }
  return [canvasTextSeed(value.slice(0, 100_000))];
}

function PromptResponse({
  value,
  running,
  onPlaceArtifacts
}: {
  value: string;
  running: boolean;
  onPlaceArtifacts?: (output: string) => void;
}) {
  const external = /external context|web_search|web_fetch|https?:\/\//i.test(value);
  return (
    <output className="hii-prompt-response" data-external={external || undefined} aria-live="polite">
      {external && <span className="hii-external-context-state"><i aria-hidden="true" />{running ? 'External context loading' : 'External context loaded'}</span>}
      {/* A run that saved three files says so in prose; typing the output is
          what turns those three lines into three objects one click away. */}
      <TypedOutput value={value} onPlace={running ? undefined : onPlaceArtifacts} />
    </output>
  );
}

export function QuickWebSearch({
  onDismiss,
  onSearch,
  onOpen
}: {
  onDismiss: () => void;
  onSearch: (query: string) => void;
  onOpen: (url: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InformationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void findInformation(value, { web: false, limit: 8 })
        .then((matches) => { if (!cancelled) setResults(matches.filter((item) => /^https?:\/\//i.test(item.url))); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);
  return (
    <div className="hii-canvas-search-text" data-workspace-ui onPointerDown={(event) => event.stopPropagation()}>
      <form onSubmit={(event) => { event.preventDefault(); if (query.trim()) onSearch(query.trim()); }}>
        <input
          autoFocus
          aria-label="Write a web search on the canvas"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search HII and the web"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
          }}
        />
      </form>
      {query.trim().length >= 2 && <section className="hii-canvas-search-results" aria-label="Saved pages and sources">
        <header><strong>Saved pages and sources</strong><small>{searching ? 'Searching…' : `${results.length} found`}</small></header>
        {results.map((result) => <article key={result.versionId || result.id || result.url}>
          <button type="button" onClick={() => onOpen(result.url)}>
            <strong>{result.title || result.url}</strong>
            <small>{result.browserName || result.siteName || 'Saved source'}{result.capturedAt ? ` · ${new Date(result.capturedAt).toLocaleDateString()}` : ''}{result.versionId ? ` · ${result.versionId.slice(-8)}` : ''}</small>
            {result.excerpt && <span>{result.excerpt}</span>}
          </button>
          {typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window) && <a href={`/remote/browser?url=${encodeURIComponent(result.url)}`}>Open live in HII ↗</a>}
        </article>)}
        {!searching && !results.length && <p>No saved page matches. Press Return to search the web.</p>}
      </section>}
    </div>
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
function SourceBody({ node, onOpen }: { node: WorkspaceNode; onOpen: (url: string) => void }) {
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
        {/^https?:\/\//i.test(url) && <button type="button" onClick={() => onOpen(url)}>Open</button>}
      </footer>
    </article>
  );
}

function RequestBody({
  node,
  onPayload,
  onAgentSubmit
}: {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
  onAgentSubmit: (intent: string) => void;
}) {
  const prompt = text(node.payload.text) || text(node.payload.title);
  const output = text(node.payload.output);
  const status = text(node.payload.status);
  const contextCount = Number(node.payload.contextCount) || 0;
  const state = output.length > 360 ? `…${output.slice(-359)}` : output;
  const objectiveDraft = node.payload.role === 'agent-objective';
  const draft = text(node.payload.draft);
  const running = status === 'running' || status === 'queued';
  return (
    <article className="hii-intent-object" data-status={status || 'ready'}>
      <header>
        <span>{objectiveDraft ? 'objective' : 'intent'}</span>
        <small>{status || 'active'}</small>
      </header>
      {objectiveDraft && status === 'ready' ? (
        <div className="hii-objective-compose">
          <input
            autoFocus
            aria-label="Persistent objective"
            value={draft}
            placeholder="What should HII move forward?"
            onChange={(event) => onPayload({ draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !draft.trim()) return;
              event.preventDefault();
              onAgentSubmit(draft.trim());
            }}
          />
          <small>Return to bind context and begin</small>
        </div>
      ) : <p>{prompt}</p>}
      {(state || status === 'running') && <div className="hii-intent-state">{state || 'Observing and acting…'}</div>}
      <footer>
        <span>{contextCount ? `${contextCount} world object${contextCount === 1 ? '' : 's'} in scope` : 'world scope open'}</span>
        <code>{text(node.payload.receiptPath) || (running ? 'proof pending' : text(node.payload.authority) || 'persistent')}</code>
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
  const title = text(node.payload.title) || job;
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
    <article className="hii-job-terminal" data-status={status} data-kind={shellTerminal ? 'shell' : agentTerminal ? 'agent' : 'job'}>
      <header>
        {shellTerminal
          ? <span className="hii-terminal-folder" aria-hidden="true" />
          : <span className="hii-terminal-lamp" aria-hidden="true" />}
        <strong>{shellTerminal ? title : job}</strong>
        <small>{status}</small>
      </header>
      {shellTerminal ? (
        <ShellTerminal
          sessionId={text(node.payload.sessionId)}
          cwd={cwd}
          entry={node.payload.terminalEntry === 'shell' ? 'shell' : 'hii'}
          preface={text(node.payload.terminalPreface)}
          initialInput={text(node.payload.terminalInitialInput)}
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
        {/* The agent's result is the one part of a terminal that is a result
            rather than a log, so it is the part worth typing. */}
        {agentTerminal && resultLines.length > 0 && (
          <span className="hii-terminal-result" data-typed>
            <TypedOutput value={resultLines.join('\n')} />
          </span>
        )}
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
      {!shellTerminal && <footer><span>{footerLabel}</span><code>{footerValue}</code></footer>}
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
function DocumentBody({ url, name, kind, onError }: { url: string; name: string; kind: string; onError: () => void }) {
  const isPdf = kind === 'pdf' || /\.pdf(\?|#|$)/i.test(url);

  if (isPdf) {
    return (
      <div className="hii-node-document-shell">
        <iframe className="hii-node-document" src={url} title={name} onError={onError} />
        <a className="hii-node-document-open" href={url} target="_blank" rel="noreferrer">open PDF ↗</a>
      </div>
    );
  }
  return (
    <div className="hii-node-document-fallback">
      <strong>{name}</strong>
      <a href={url} target="_blank" rel="noreferrer">Open document</a>
    </div>
  );
}

function AssetFailure({ name, state, onRetry }: { name: string; state: 'loading' | 'missing' | 'failed'; onRetry: () => void }) {
  return <div className="hii-node-asset-state" data-state={state}>
    <strong>{state === 'loading' ? 'opening' : 'could not open'} {name}</strong>
    {state !== 'loading' ? <button type="button" onClick={onRetry}>try again</button> : null}
  </div>;
}

/** Media URLs created by browsers do not survive a page reload. Resolve the
 * persisted account-owned bytes whenever a node has not already been hydrated
 * with a fresh URL. */
function AssetNodeBody({ node }: { node: WorkspaceNode }) {
  const initialUrl = text(node.payload.url);
  const assetId = text(node.payload.browserAssetId);
  const assetState = text(node.payload.assetState);
  const name = text(node.payload.name) || text(node.payload.title) || node.type;
  const [url, setUrl] = useState(initialUrl);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>(initialUrl ? 'ready' : 'loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Fresh imports already have the original File URL, and hydration has
    // already produced a new URL for ready records. Re-reading IndexedDB here
    // races that valid source on iOS Safari and can replace it with a URL the
    // image decoder refuses.
    if (initialUrl && (assetState === 'fresh' || assetState === 'ready')) {
      setUrl(initialUrl);
      setState('ready');
      return;
    }
    if (!assetId) {
      setUrl(initialUrl);
      setState(initialUrl ? 'ready' : 'missing');
      return;
    }
    let active = true;
    let ownedUrl = '';
    setState('loading');
    void browserCanvasAssetUrl(assetId).then((resolved) => {
      if (!active) {
        if (resolved) URL.revokeObjectURL(resolved);
        return;
      }
      if (!resolved) {
        setUrl('');
        setState('missing');
        return;
      }
      ownedUrl = resolved;
      setUrl(resolved);
      setState('ready');
    }).catch(() => {
      if (active) setState('failed');
    });
    return () => {
      active = false;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [assetId, assetState, attempt, initialUrl]);

  if (!url || state !== 'ready') {
    return <AssetFailure name={name} state={state === 'ready' ? 'missing' : state} onRetry={() => setAttempt((value) => value + 1)} />;
  }
  const fail = () => setState('failed');
  if (node.type === 'image') return <img className="hii-node-image" src={url} alt={name} draggable={false} onError={fail} />;
  if (node.type === 'document') return <DocumentBody url={url} name={name} kind={text(node.payload.kind)} onError={fail} />;
  if (node.type === 'media') {
    return node.payload.kind === 'audio'
      ? <audio className="hii-node-video" src={url} controls preload="metadata" onError={fail} />
      : <video className="hii-node-video" src={url} controls preload="metadata" playsInline onError={fail} />;
  }
  return <AssetFailure name={name} state="failed" onRetry={() => setAttempt((value) => value + 1)} />;
}

/**
 * The sentence a run object was created to carry out.
 *
 * A run seeded by an agent puts it in `prompt`; one typed by a person lands in
 * `text`; the title is the last resort so approval never fires on an empty
 * intent (`startObjectiveAgent` refuses a blank one).
 */
function runIntent(node: WorkspaceNode) {
  return text(node.payload.prompt) || text(node.payload.text) || text(node.payload.title);
}

function NodeBody({
  node,
  autoFocus,
  onAutoFocused,
  onPayload,
  onResize,
  onAgentSubmit,
  onBrowserCapture,
  onOpenBrowser,
  onApproveRun,
  onStopRun,
  onOpenProof
}: {
  node: WorkspaceNode;
  autoFocus?: boolean;
  onAutoFocused?: () => void;
  onPayload: (patch: Record<string, unknown>) => void;
  onResize?: (size: { w: number; h: number }) => void;
  onAgentSubmit: (intent: string) => void;
  onBrowserCapture: (result: InformationCaptureResult) => void;
  onOpenBrowser: (url: string) => void;
  onApproveRun: () => void;
  onStopRun: () => void;
  onOpenProof: (receiptPath: string) => void;
}) {
  const payload = node.payload;
  const content = text(payload.content) || text(payload.text) || text(payload.output) || text(payload.summary);
  const url = text(payload.url);
  const name = text(payload.name) || text(payload.title) || node.type;
  const canvasObject = canvasObjectPayload(node);

  if (canvasObject?.canvasKind === 'shape') {
    const appearance = canvasObject.appearance || {};
    return <div
      className="hii-canvas-shape"
      data-shape={canvasObject.shape}
      style={{
        '--shape-fill': appearance.fill || '#ffffff',
        '--shape-stroke': appearance.stroke || '#101010',
        '--shape-stroke-width': `${appearance.strokeWidth ?? 2}px`,
        '--shape-opacity': appearance.opacity ?? 1,
        color: appearance.foreground || '#101010',
        fontFamily: appearance.fontFamily,
        fontSize: appearance.fontSize,
        fontWeight: appearance.fontWeight,
        textAlign: appearance.textAlign
      } as React.CSSProperties}
    ><span>{canvasObject.content || 'Shape'}</span></div>;
  }
  if (canvasObject?.canvasKind === 'table') {
    return <div className="hii-canvas-table-wrap"><table className="hii-canvas-table"><tbody>{canvasObject.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => {
      const Cell = canvasObject.table.headerRow && rowIndex === 0 ? 'th' : 'td';
      return <Cell key={columnIndex} contentEditable suppressContentEditableWarning onBlur={(event) => {
        const rows = canvasObject.table.rows.map((entry) => [...entry]);
        rows[rowIndex][columnIndex] = event.currentTarget.textContent || '';
        onPayload({ table: { ...canvasObject.table, rows } });
      }}>{cell}</Cell>;
    })}</tr>)}</tbody></table></div>;
  }

  if (node.type === 'browser' && payload.surface === 'native-dev-browser') {
    return <DeferredSurface><NativeDevBrowser nodeId={node.id} initialUrl={url} onUrl={(nextUrl) => onPayload({ url: nextUrl, title: hostFor(nextUrl) })} onCapture={onBrowserCapture} onOpenObject={onOpenBrowser} /></DeferredSurface>;
  }
  if (node.type === 'browser' || node.type === 'link') return <SourceBody node={node} onOpen={onOpenBrowser} />;
  if (node.type === 'run') return <RunBody node={node} onApprove={onApproveRun} onStop={onStopRun} onOpenProof={onOpenProof} />;
  if (node.type === 'terminal') return <TerminalBody node={node} onPayload={onPayload} onAgentSubmit={onAgentSubmit} />;
  if (node.type === 'intent') return <RequestBody node={node} onPayload={onPayload} onAgentSubmit={onAgentSubmit} />;
  if (['profile-music', 'hii-marketplace', 'natirar-project', 'waymark-location', 'hii-link'].includes(text(payload.surface))) {
    return <article className="hii-file-reference" aria-label={`${name} archived object`}>
      <strong>{name}</strong>
      <small>Archived HII surface</small>
      <p>This object remains in your board and exports, but its unfinished interactive surface is no longer loaded.</p>
    </article>;
  }
  if (node.type === 'app') return <DeferredSurface><RegisteredApplication name={name} summary={content || 'Registered HII application'} entryUrl={text(payload.entryUrl) || undefined} /></DeferredSurface>;
  if (node.type === 'html') return <iframe className="hii-html" srcDoc={text(payload.srcdoc)} title={name} sandbox="allow-forms allow-scripts" />;
  if (node.type === 'ink') return <InkBody node={node} />;
  if (node.type === 'image' && payload.sticker === true) return <div className="hii-sticker" role="img" aria-label={name}>{text(payload.emoji) || '✦'}</div>;
  if (node.type === 'image' || node.type === 'document' || node.type === 'media') return <AssetNodeBody node={node} />;
  if (node.type === 'file') return <article className="hii-file-reference" aria-label={`${name} file reference`}>
    <strong>{name}</strong>
    <small>{text(payload.label) || 'File'} · {typeof payload.size === 'number' ? `${Math.round(payload.size / 1024)} KB` : 'size unknown'}</small>
    <p>{text(payload.description) || 'Select this file to include its reference when asking HII.'}</p>
    {typeof payload.path === 'string' && payload.path ? <button type="button" onClick={() => void navigator.clipboard.writeText(payload.path as string)}>Copy file path</button> : null}
  </article>;
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
  return <pre className="hii-node-copy">{content || name}</pre>;
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
  initialMenu,
  presentation = 'floating',
  workspaceLabel = 'HII workspace',
  selectedCount = 0,
  nodes,
  onDismiss,
  onMode,
  onApproveContext,
  onRejectContext,
  onDropContextItem,
  onPlaceArtifacts,
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
  initialMenu?: 'commands' | 'settings';
  onDismiss: () => void;
  onMode: (mode: CanvasModeId) => void;
  onApproveContext: () => void;
  onRejectContext: () => void;
  onDropContextItem: (objectId: string) => void;
  onPlaceArtifacts: (output: string) => void;
  onSubmit: (value: string) => void;
  presentation?: 'floating' | 'terminal';
  workspaceLabel?: string;
  selectedCount?: number;
  nodes: WorkspaceNode[];
}) {
  const [value, setValue] = useState(initialValue);
  const [menu, setMenu] = useState<'root' | 'commands' | 'settings' | null>(initialMenu || null);
  const [showAllContext, setShowAllContext] = useState(false);
  const visibleContextItems = showAllContext
    ? (contextPack?.items || [])
    : (contextPack?.items || []).slice(0, 8);
  const input = useRef<HTMLInputElement | null>(null);
  const commands = value.startsWith('/')
    ? promptSlashCommands.filter(([command]) => command.startsWith(value.trim().toLowerCase()) || value.trim() === '/')
    : [];
  // Typing `@name` is selecting without clicking: the sentence carries its own
  // context. Resolution runs on every keystroke so the objects a run will see
  // are visible while it is still being written, not after it starts.
  const handles = useMemo(() => resolveHandles(value, nodes), [value, nodes]);
  const handleDraft = /(?:^|\s)@([a-z0-9-]*)$/i.exec(value);
  const handleMatches = handleDraft ? handleCompletions(handleDraft[1], nodes) : [];
  const completeHandle = (handle: string) => {
    setValue((current) => current.replace(/(?:^|\s)@[a-z0-9-]*$/i, (match) => `${match.startsWith('@') ? '' : ' '}@${handle} `));
    input.current?.focus();
  };
  const submit = () => {
    // An unresolved handle is not a typo to route around. Running the rest of
    // the sentence would silently operate on the wrong objects.
    if (handles.unresolved.length) return;
    if (value.trim() && status !== 'running' && !contextPack) onSubmit(value.trim());
  };
  useEffect(() => { input.current?.focus(); }, []);
  const floating = presentation === 'floating';
  const running = status === 'running' && !contextPack;
  const visibleResponse = isAgentPlaceholder(response) ? '' : response;
  const promptWidth = Math.min(560, window.innerWidth - 24);
  const promptLeft = Math.max(16, Math.min(anchor.x - 14, window.innerWidth - promptWidth - 16));
  const promptTop = Math.max(12, Math.min(anchor.y + 14, window.innerHeight - 64));
  const shellStyle = floating ? { left: promptLeft, top: promptTop, width: promptWidth } : undefined;
  return (
    <div
      className={floating ? 'hii-prompt-shell' : 'hii-assistant-terminal-shell'}
      style={shellStyle}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form className="hii-prompt" data-mode={mode} data-status={status} data-presentation={presentation} onSubmit={(event) => { event.preventDefault(); submit(); }}>
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
          <button type="button" className="hii-prompt-options-toggle" aria-label="Commands and settings" aria-expanded={Boolean(menu)} onClick={() => setMenu((open) => open ? null : 'root')}><DotsThree size={18} weight="bold" /></button>
          <input
            ref={input}
            disabled={Boolean(contextPack) || running}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && !event.shiftKey && handleMatches.length) {
                event.preventDefault();
                completeHandle(handleMatches[0].handle);
                return;
              }
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
            placeholder="Describe what should happen…"
            aria-label="Tell HII what should happen"
            autoComplete="off"
            spellCheck
          />
          <VoiceInputButton
            className="hii-prompt-voice"
            disabled={Boolean(contextPack) || running}
            onTranscript={(transcript) => setValue((current) => `${current.trimEnd()}${current.trim() ? ' ' : ''}${transcript}`)}
          />
        </div>
        {menu === 'root' && <div className="hii-prompt-menu" aria-label="HII menu">
          <button type="button" onClick={() => setMenu('commands')}><Command size={16} /><span>Commands</span><kbd>?</kbd><CaretRight size={14} /></button>
          <button type="button" onClick={() => setMenu('settings')}><GearSix size={16} /><span>Settings</span><CaretRight size={14} /></button>
        </div>}
        {menu === 'commands' && <section className="hii-prompt-panel" aria-label="All HII commands">
          <header><button type="button" aria-label="Back" onClick={() => setMenu('root')}><CaretLeft size={15} /></button><strong>Commands</strong><kbd>?</kbd></header>
          <div className="hii-prompt-command-list">
            {promptKeyboardCommands.map(([shortcut, description]) => <span key={shortcut}><kbd>{shortcut}</kbd><b>{description}</b></span>)}
          </div>
          <div className="hii-prompt-command-list" data-slash-commands>
            {promptSlashCommands.map(([command, description]) => <span key={command}><kbd>{command}</kbd><b>{description}</b></span>)}
          </div>
        </section>}
        {menu === 'settings' && <section className="hii-prompt-panel" aria-label="HII prompt settings">
          <header><button type="button" aria-label="Back" onClick={() => setMenu('root')}><CaretLeft size={15} /></button><strong>Settings</strong></header>
          <div className="hii-prompt-setting"><span>Output</span><b>Direct model stream</b></div>
          <div className="hii-prompt-setting"><span>Context</span><b>{selectedCount ? `${selectedCount} selected` : workspaceLabel}</b></div>
          <div className="hii-prompt-modes" aria-label="Agent mode">{canvasModes.map((item) => (
            <button key={item.id} type="button" disabled={Boolean(contextPack)} aria-pressed={item.id === mode} onClick={() => onMode(item.id)}>{item.label}</button>
          ))}</div>
          <small>{canvasMode(mode).description} · ⇧ Tab cycles modes</small>
        </section>}
        {(running || visibleResponse) && <PromptResponse value={visibleResponse} running={running} onPlaceArtifacts={onPlaceArtifacts} />}
        {contextPack && (
          <section className="hii-context-preflight" aria-label="Context review">
            <header>
              <strong>{visibleContextItems.length} of {contextPack.items.length} context items</strong>
              <span>{contextPack.budget.usedTokens.toLocaleString()} / {contextPack.budget.maximumTokens.toLocaleString()} tokens</span>
            </header>
            {/* Authority and transmission scope are the two facts that decide
                what approving this actually permits, and the pack has carried
                both all along without ever showing them. */}
            <dl className="hii-context-authority">
              <div><dt>Authority</dt><dd>{contextPack.authority}</dd></div>
              <div><dt>Transmission</dt><dd>{contextPack.transmissionScope}</dd></div>
            </dl>
            <p>{contextPack.risk.reasons.join(' · ')}</p>
            {contextPack.changedSincePrevious && (
              <small data-tone="warn">This context differs from the last one you approved.</small>
            )}
            <ul>{visibleContextItems.map((item) => {
              const key = `${item.ref.kind}:${item.ref.id}`;
              return (
                <li key={key}>
                  <b>{item.title}</b>
                  <span>{item.itemType}{item.selected ? ' · selected' : ''}</span>
                  {/* Removing one item is the difference between reviewing a
                      context and merely acknowledging it. */}
                  {item.ref.kind === 'runtime-object' && <button
                    type="button"
                    className="hii-context-drop"
                    aria-label={`Remove ${item.title} from this context`}
                    onClick={() => onDropContextItem(item.ref.id)}
                  >−</button>}
                </li>
              );
            })}</ul>
            {contextPack.items.length > visibleContextItems.length && (
              <button type="button" className="hii-context-more" onClick={() => setShowAllContext(true)}>
                Show all {contextPack.items.length} items
              </button>
            )}
            {contextPack.excluded.length > 0 && <small>{contextPack.excluded.length} item{contextPack.excluded.length === 1 ? '' : 's'} excluded by scope, safety, or budget.</small>}
            {contextPack.sourceErrors.length > 0 && (
              // A source HII could not read is not an empty context item; it is
              // a hole in what the run will see, and it belongs in the review.
              <ul className="hii-context-errors" aria-label="Sources HII could not read">
                {contextPack.sourceErrors.map((error) => <li key={error}>{error}</li>)}
              </ul>
            )}
            <div className="hii-context-decision">
              <button type="button" onClick={onApproveContext}>Approve this exact context and continue</button>
              <button type="button" className="hii-context-reject" onClick={onRejectContext}>Reject</button>
            </div>
            <code>{contextPack.fingerprint.slice(0, 18)}…</code>
          </section>
        )}
        {handleMatches.length > 0 && (
          <div className="hii-prompt-command-list" data-handles aria-label="Matching canvas objects">
            {handleMatches.map((match) => (
              <button key={match.handle} type="button" onClick={() => completeHandle(match.handle)}>
                <kbd>@{match.handle}</kbd>
                <b>{match.title}</b>
                <small>{match.kind}</small>
              </button>
            ))}
          </div>
        )}
        {(handles.nodes.length > 0 || handles.unresolved.length > 0) && (
          <div className="hii-prompt-handles" aria-label="Objects named in this intent">
            {handles.nodes.map((node) => <span key={node.id}>{workspaceNodeTitle(node)}</span>)}
            {handles.unresolved.map((reference) => (
              <span key={`${reference.raw}-${reference.start}`} data-unresolved>
                {reference.raw}{reference.ambiguous ? ' · ambiguous' : ' · no such object'}
              </span>
            ))}
          </div>
        )}
        {commands.length > 0 && <div className="hii-prompt-commands" aria-label="Matching HII commands">{commands.map(([command, description]) => <span key={command}><b>{command}</b>{description}</span>)}</div>}
      </form>
    </div>
  );
}

type HiiRootProps = {
  surface?: 'workspace' | 'space' | 'account';
  spaceId?: string;
  creatorId?: string;
  persistence?: WorkspacePersistence;
  allowPhoto?: boolean;
  persistentChrome?: boolean;
  allowLocalRuntime?: boolean;
  openTerminalOnReady?: boolean;
  onTerminalReady?: () => void;
  onUnsavedChanges?: (unsaved: boolean) => void;
  onShareNode?: (node: WorkspaceNode) => void;
  onRequestDevice?: (selection: WorkspaceNode[]) => void;
  onSelectionChange?: (selection: WorkspaceNode[]) => void;
  fileSeeder?: (files: File[]) => Promise<NodeSeed[]>;
  canvasImportRequest?: CanvasImportRequest | null;
  projectionRequest?: WorkspaceProjectionRequest | null;
  searchWorkspaces?: () => Promise<SearchableWorkspace[]>;
  searchWorkspaceId?: string;
  onFocusExternalNode?: (workspaceId: string, nodeId: string) => void;
  searchFocusNodeId?: string | null;
  canvasManagerRequest?: number;
};

export function HiiRoot(props: HiiRootProps) {
  if (props.persistentChrome !== false || !props.surface || props.surface === 'workspace') {
    return <UpdateStatusProvider><HiiRootContent {...props} /></UpdateStatusProvider>;
  }
  return <HiiRootContent {...props} />;
}

function HiiRootContent({
  surface = 'workspace',
  spaceId = '',
  creatorId = 'guest:pending',
  persistence,
  allowPhoto = true,
  persistentChrome = true,
  allowLocalRuntime = false,
  openTerminalOnReady = false,
  onTerminalReady,
  onUnsavedChanges,
  onShareNode,
  onRequestDevice,
  onSelectionChange,
  fileSeeder,
  canvasImportRequest = null,
  projectionRequest = null,
  searchWorkspaces,
  searchWorkspaceId,
  onFocusExternalNode,
  searchFocusNodeId = null,
  canvasManagerRequest = 0
}: {
  surface?: 'workspace' | 'space' | 'account';
  spaceId?: string;
  creatorId?: string;
  persistence?: WorkspacePersistence;
  allowPhoto?: boolean;
  persistentChrome?: boolean;
  allowLocalRuntime?: boolean;
  openTerminalOnReady?: boolean;
  onTerminalReady?: () => void;
  onUnsavedChanges?: (unsaved: boolean) => void;
  onShareNode?: (node: WorkspaceNode) => void;
  onRequestDevice?: (selection: WorkspaceNode[]) => void;
  onSelectionChange?: (selection: WorkspaceNode[]) => void;
  fileSeeder?: (files: File[]) => Promise<NodeSeed[]>;
  canvasImportRequest?: CanvasImportRequest | null;
  projectionRequest?: WorkspaceProjectionRequest | null;
  searchWorkspaces?: () => Promise<SearchableWorkspace[]>;
  searchWorkspaceId?: string;
  onFocusExternalNode?: (workspaceId: string, nodeId: string) => void;
  searchFocusNodeId?: string | null;
  canvasManagerRequest?: number;
} = {}) {
  const isSpace = surface === 'space';
  const isAccount = surface === 'account';
  const isTouchCanvas = isSpace || isAccount;
  const updateStatusAccess = useUpdateStatusAccess();
  const runtimeEnabled = !isTouchCanvas || allowLocalRuntime;
  const [desktopRuntime, setDesktopRuntime] = useState(false);
  useEffect(() => { setDesktopRuntime('__TAURI_INTERNALS__' in window); }, []);
  const startupTerminalHandled = useRef(false);
  const save = useRef<() => void>(() => {});
  const [cameraRevision, setCameraRevision] = useState(0);
  const settleCamera = useCallback(() => {
    save.current();
    setCameraRevision((revision) => revision + 1);
  }, []);
  const camera = useCamera(settleCamera);
  const workspace = useWorkspace(camera.getViewport, undefined, persistence);
  useEffect(() => {
    onUnsavedChanges?.(workspace.hasUnsavedChanges);
  }, [onUnsavedChanges, workspace.hasUnsavedChanges]);
  const [selected, setSelected] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasModeId>(() => {
    if (typeof window === 'undefined') return defaultCanvasMode;
    const stored = window.localStorage.getItem('hii.canvas.mode.v1');
    return isCanvasMode(stored) ? stored : defaultCanvasMode;
  });
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptVisible, setPromptVisible] = useState(false);
  const [webSearchOpen, setWebSearchOpen] = useState(false);
  const [promptPresentation, setPromptPresentation] = useState<'floating' | 'terminal'>('floating');
  const [drawing, setDrawing] = useState(false);
  const [activeTool, setActiveTool] = useState<CanvasTool>('select');
  const [connectorStartId, setConnectorStartId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [canvasCommandsOpen, setCanvasCommandsOpen] = useState(false);
  const [commandShortcut, setCommandShortcut] = useState(DEFAULT_WEB_COMMAND_SHORTCUT);
  useEffect(() => setCommandShortcut(readCommandShortcut()), []);
  const [canvasManagerOpen, setCanvasManagerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toolMessage, setToolMessage] = useState('');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [fileAccept, setFileAccept] = useState('');
  const [uploadChooser, setUploadChooser] = useState(false);
  const touchTap = useRef<{ count: number; at: Point; time: number; pointerId: number | null; start: Point | null }>({ count: 0, at: { x: 0, y: 0 }, time: 0, pointerId: null, start: null });
  const activeTouchPointers = useRef(new Set<number>());
  const multiTouchSequence = useRef(false);
  const textTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTouchTap = useRef(0);
  const uploadAt = useRef<Point | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const photosInput = useRef<HTMLInputElement | null>(null);
  const notionInput = useRef<HTMLInputElement | null>(null);
  const miroInput = useRef<HTMLInputElement | null>(null);
  const freeformInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { if (textTapTimer.current) clearTimeout(textTapTimer.current); }, []);
  const mouse = useRef<Point>({ x: 400, y: 280 });
  const activeRun = useRef<string | null>(null);
  const activeObjectives = useRef(new Map<string, string>());
  const bufferedAgentEvents = useRef(new Map<string, AgentEventV1[]>());
  const pendingContextStart = useRef<null | {
    pack: ContextPackV1;
    /** Kept so removing an item can recompile rather than edit the pack locally. */
    request: { intent: string; mode: CanvasModeId; contextNodeIds: string[]; authority: string; excludedObjectIds?: string[] };
    start: (approved: ContextPackV1) => Promise<void>;
  }>(null);
  const activeConversation = useRef<{
    runId: string;
    nodeId: string;
    conversationId: string;
    humanTurnId: string;
    assistantText: string;
  } | null>(null);

  useEffect(() => {
    if (!runtimeEnabled || process.env.NEXT_PUBLIC_HII_INFERENCE_DEMO !== '1') return;
    setPrompt({
      anchor: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      initialValue: 'Design a small concrete house beside the ocean.',
      response: 'Thinking…',
      status: 'running'
    });
    setPromptPresentation('floating');
    setPromptVisible(true);
  }, [runtimeEnabled]);

  const startWithContext = useCallback(async (
    request: { intent: string; mode: CanvasModeId; contextNodeIds: string[] },
    onStarted: (result: { runId: string }) => void | Promise<void>,
    reviewAnchor: Point = mouse.current
  ) => {
    // Context is compiled from Runtime state, so first acknowledge every local
    // edit (including a just-created object named by an @handle).
    await workspace.flush();
    const authority = ['plan', 'browse', 'see'].includes(request.mode) ? 'read-only' : 'workspace';
    const pack = await compileContextPack({
      intent: request.intent,
      mode: request.mode,
      authority,
      selectedObjectIds: request.contextNodeIds,
      spaceId: spaceId || runtimeSpaceId() || 'default'
    });
    if (pack.risk.action === 'blocked') {
      throw new Error(pack.risk.reasons.join(' ') || 'HII blocked unsafe or missing context.');
    }
    const start = async (approved: ContextPackV1) => {
      const result = await startAgent(agentRequestFromContextPack(approved));
      await onStarted(result);
    };
    if (pack.risk.action === 'review') {
      pendingContextStart.current = { pack, request: { ...request, authority }, start };
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
  }, [spaceId, workspace.flush]);

  /**
   * Remove one object from the context under review.
   *
   * The pack cannot be edited here: the Runtime approves the pack it stored, by
   * id and fingerprint, and refuses one whose contents moved. So removal means
   * compiling a fresh pack from a smaller selection, which the person then
   * reviews - the approval always refers to something that actually exists.
   */
  const dropContextItem = useCallback(async (objectId: string) => {
    const pending = pendingContextStart.current;
    if (!pending) return;
    const nodeId = objectId.split(':').at(-1) || objectId;
    const contextNodeIds = pending.request.contextNodeIds.filter((id) => id !== objectId && id !== nodeId);
    const excludedObjectIds = [...new Set([...(pending.request.excludedObjectIds ?? []), objectId])];
    try {
      await workspace.flush();
      const pack = await compileContextPack({
        intent: pending.request.intent,
        mode: pending.request.mode,
        authority: pending.request.authority,
        selectedObjectIds: contextNodeIds,
        excludedObjectIds,
        spaceId: pending.pack.spaceId,
        workspaceRoot: pending.pack.workspaceRoot
      });
      if (pendingContextStart.current !== pending) return;
      pendingContextStart.current = { ...pending, pack, request: { ...pending.request, contextNodeIds, excludedObjectIds } };
      setPrompt((current) => current ? { ...current, contextPack: pack } : current);
    } catch (error) {
      setPrompt((current) => current ? {
        ...current,
        response: error instanceof Error ? error.message : 'HII could not recompile this context.',
        status: 'failed'
      } : current);
    }
  }, [workspace.flush]);

  const rejectPendingContext = useCallback(() => {
    pendingContextStart.current = null;
    setPrompt((current) => current ? {
      ...current,
      contextPack: undefined,
      response: 'Context rejected. Nothing ran.',
      status: 'idle'
    } : current);
  }, []);

  const approvePendingContext = useCallback(async () => {
    const pending = pendingContextStart.current;
    if (!pending) return;
    setPrompt((current) => current ? { ...current, contextPack: undefined, response: 'Starting with the approved context…', status: 'running' } : current);
    try {
      await workspace.flush();
      const approved = await approveContextPack(pending.pack);
      if (pendingContextStart.current !== pending) return;
      pendingContextStart.current = null;
      await pending.start(approved);
    } catch (error) {
      setPrompt((current) => current ? { ...current, response: error instanceof Error ? error.message : 'HII could not approve this context.', status: 'failed' } : current);
    }
  }, [workspace.flush]);
  const workspaceRef = useRef(workspace);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const applicationCatalog = useRef(new Map<string, HiiApplicationManifest>());
  const applicationPollActive = useRef(false);
  const handledProjectionRequest = useRef<string | null>(null);
  const handledCanvasImportRequest = useRef<string | null>(null);
  workspaceRef.current = workspace;
  save.current = workspace.scheduleSave;
  useEffect(() => { window.localStorage.setItem('hii.canvas.mode.v1', mode); }, [mode]);

  useEffect(() => {
    if (workspace.initialViewport) camera.setViewport(workspace.initialViewport);
  }, [camera.setViewport, workspace.initialViewport]);

  const spawnSeeds = useCallback((seeds: NodeSeed[], at: Point, layout: 'cascade' | 'flow' = 'cascade') => {
    const ids: string[] = [];
    const acceptedSeeds = isSpace
      ? seeds.filter((seed) => isSpaceCanvasNodeType(seed.type))
      : isAccount
        ? seeds.filter((seed) => isAccountCanvasNodeType(seed.type) || (allowLocalRuntime && seed.type === 'terminal'))
        : seeds;
    const flowWidth = Math.max(960, (camera.viewportRef.current?.clientWidth || window.innerWidth) / camera.cam.current.z - 120);
    const placements = layout === 'flow'
      ? flowSeedPlacements(acceptedSeeds, at, flowWidth)
      : acceptedSeeds.map((_seed, index) => ({ x: at.x + index * 24, y: at.y + index * 24 }));
    acceptedSeeds.forEach((seed, index) => {
      const node = makeNode(seed, placements[index].x, placements[index].y, workspace.takeZ());
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
  }, [allowLocalRuntime, camera, creatorId, isAccount, isSpace, isTouchCanvas, spaceId, workspace]);

  const spawnCenteredSeed = useCallback((seed: NodeSeed) => {
    const center = camera.centerWorld();
    return spawnSeeds([seed], { x: center.x - seed.w / 2, y: center.y - seed.h / 2 });
  }, [camera, spawnSeeds]);

  // The small native capture window sends its committed text here. Wait until
  // the active Space has loaded so a capture cannot land in a transient board.
  const pendingQuickCaptures = useRef<Array<{ text: string; captureId?: string }>>([]);
  const quickCaptureSink = useRef<(capture: { text: string; captureId?: string }) => void>(() => {});
  quickCaptureSink.current = (capture) => {
    if (!workspace.ready) { pendingQuickCaptures.current.push(capture); return; }
    const [nodeId] = spawnCenteredSeed(isSpace ? canvasTextSeed(capture.text) : seedFromString(capture.text));
    if (!capture.captureId || !nodeId) return;
    void workspace.flush().then(() => import('@tauri-apps/api/event').then(({ emit }) => emit('hii:quick-capture-saved', { captureId: capture.captureId, nodeId })))
      .catch((error) => void import('@tauri-apps/api/event').then(({ emit }) => emit('hii:quick-capture-failed', { captureId: capture.captureId, error: error instanceof Error ? error.message : String(error) })));
  };
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten = () => {};
    void import('@tauri-apps/api/event').then(({ listen }) => listen<{ text: string; captureId?: string }>('hii:quick-capture', (event) => {
      const value = event.payload?.text;
      if (typeof value !== 'string' || !value.trim()) return;
      quickCaptureSink.current({ text: value.slice(0, 100_000), captureId: event.payload.captureId });
    })).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; });
    return () => { disposed = true; unlisten(); };
  }, []);
  useEffect(() => {
    if (!workspace.ready || !pendingQuickCaptures.current.length) return;
    for (const capture of pendingQuickCaptures.current.splice(0)) quickCaptureSink.current(capture);
  }, [workspace.ready]);

  const importFiles = useCallback(async (files: File[], at: Point, direct = false, source?: 'Notion' | 'Miro' | 'Freeform') => {
    try {
      const imported = await (fileSeeder ? fileSeeder(files) : seedsFromFiles(files));
      const seeds = source ? imported.map((seed) => ({
        ...seed,
        object: seed.object ? {
          ...seed.object,
          source: `${source} export · imported locally`,
          audit: [...(seed.object.audit ?? []), { ts: new Date().toISOString(), actor: 'human' as const, action: `imported from ${source}` }]
        } : seed.object,
        payload: { ...seed.payload, importedFrom: source.toLowerCase() }
      })) : imported;
      spawnSeeds(direct ? directPasteSeeds(seeds) : seeds, at, 'flow');
      setToolMessage(`${source ? `Imported from ${source}: ` : 'Added '}${seeds.length} file${seeds.length === 1 ? '' : 's'}.`);
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

  const acceptSourceFiles = useCallback((source: 'Notion' | 'Miro' | 'Freeform', files: File[]) => {
    if (!files.length) { uploadAt.current = null; return; }
    const at = uploadAt.current ?? camera.centerWorld();
    uploadAt.current = null;
    void importFiles(files, at, false, source);
  }, [camera, importFiles]);

  const addTextAt = useCallback((at: Point) => {
    const [id] = spawnSeeds([canvasTextSeed()], camera.toWorld(at.x, at.y));
    setFocusNodeId(id ?? null);
    setActiveDocumentId(id ?? null);
  }, [camera, spawnSeeds]);
  const queueTextAt = useCallback((at: Point) => {
    if (textTapTimer.current) clearTimeout(textTapTimer.current);
    textTapTimer.current = setTimeout(() => { textTapTimer.current = null; addTextAt(at); }, 340);
  }, [addTextAt]);
  const showUploadAt = useCallback((at: Point) => {
    if (textTapTimer.current) clearTimeout(textTapTimer.current);
    textTapTimer.current = null;
    uploadAt.current = camera.toWorld(at.x, at.y);
    setUploadChooser(true);
  }, [camera]);
  const acceptChosenFiles = useCallback((files: File[]) => {
    if (!files.length) { uploadAt.current = null; return; }
    const at = uploadAt.current ?? camera.centerWorld();
    uploadAt.current = null;
    if (isSpace) {
      void Promise.all(files.map((file) => seedFromFile(file, { spaceId }))).then((seeds) => spawnSeeds(seeds, at));
    } else {
      void importFiles(files, at);
    }
  }, [camera, importFiles, isSpace, spaceId, spawnSeeds]);

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
      if (shouldSkipApplicationPoll({ cancelled, hidden: document.hidden, inFlight: applicationPollActive.current })) return;
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
    const timer = window.setInterval(() => void poll(), APPLICATION_POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [camera, runtimeEnabled, spawnSeeds, workspace.ready]);

  const visibleNodes = useMemo(
    () => (isSpace
      ? workspace.nodes.filter((node) => isSpaceCanvasNode(node, spaceId))
      : isAccount
        ? workspace.nodes.filter((node) => isAccountCanvasNode(node, spaceId))
        : workspace.nodes).filter((node) =>
          node.payload.terminalPresentation !== 'docked'
          && node.payload.terminalPresentation !== 'quick'
          && node.payload.terminalPresentation !== 'hidden'
        ),
    [isAccount, isSpace, spaceId, workspace.nodes]
  );
  const mountedNodes = useMemo(() => {
    const viewport = camera.viewportRef.current;
    const ids = visibleWorkspaceNodeIds(
      visibleNodes,
      camera.getViewport(),
      { width: viewport?.clientWidth || 0, height: viewport?.clientHeight || 0 },
      1
    );
    if (!ids) return visibleNodes;
    for (const id of selected) ids.add(id);
    return visibleNodes.filter((node) => ids.has(node.id));
  }, [cameraRevision, selected, visibleNodes]);
  const oasisSpaces = useMemo(() => visibleNodes.filter((node) => node.type === 'frame').map((node) => ({
    id: node.id,
    title: titleFor(node),
    count: visibleNodes.filter((item) => item.frameId === node.id).length
  })).slice(0, 6), [visibleNodes]);
  const oasisRecent = useMemo(() => [...visibleNodes]
    .filter((node) => node.type !== 'frame' && node.type !== 'terminal')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 4)
    .map((node) => ({ id: node.id, title: titleFor(node) })), [visibleNodes]);

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

  const focusNodes = useCallback((nodes: WorkspaceNode[], label: string) => {
    const viewport = camera.viewportRef.current;
    const fitted = fitWorkspaceViewport(nodes, {
      width: viewport?.clientWidth || window.innerWidth,
      height: viewport?.clientHeight || window.innerHeight
    }, { maxZoom: 1 });
    if (fitted) camera.setViewport(fitted);
    setToolMessage(label);
  }, [camera]);
  const focusOasisTarget = useCallback((id: string) => {
    const node = visibleNodes.find((item) => item.id === id);
    if (!node) return;
    const members = node.type === 'frame' ? visibleNodes.filter((item) => item.frameId === id) : [];
    focusNodes([node, ...members], `Focused ${titleFor(node)}.`);
  }, [focusNodes, visibleNodes]);

  const openCanvasManager = useCallback(() => {
    setDrawing(false);
    setCanvasCommandsOpen(false);
    setPromptVisible(false);
    setCanvasManagerOpen(true);
  }, []);

  const closeCanvasManager = useCallback(() => setCanvasManagerOpen(false), []);
  useEffect(() => {
    if (canvasManagerRequest > 0) openCanvasManager();
  }, [canvasManagerRequest, openCanvasManager]);

  const focusCanvasBoard = useCallback((board: CanvasManagerBoard) => {
    setCanvasManagerOpen(false);
    const nodes = canvasManagerFocusNodes(board);
    if (!nodes.length) {
      setToolMessage(`${board.title} is empty.`);
      return;
    }
    setSelected(board.scene ? [board.scene.id] : []);
    focusNodes(nodes, `Opened ${board.title}.`);
  }, [focusNodes]);

  const focusCanvasNode = useCallback((node: WorkspaceNode) => {
    setCanvasManagerOpen(false);
    setSelected([node.id]);
    setFocusNodeId(node.id);
    focusNodes([node], 'Jumped to the object.');
  }, [focusNodes]);

  const handledSearchFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace.ready || !searchFocusNodeId || handledSearchFocus.current === searchFocusNodeId) return;
    const node = workspace.nodes.find((entry) => entry.id === searchFocusNodeId);
    if (node) { handledSearchFocus.current = searchFocusNodeId; focusCanvasNode(node); }
  }, [workspace.ready, workspace.nodes, searchFocusNodeId, focusCanvasNode]);

  const toggleDrawing = useCallback(() => {
    setDrawing((current) => {
      const next = !current;
      setToolMessage(next ? 'Drawing on · drag anywhere · Esc to stop.' : 'Drawing off.');
      return next;
    });
  }, []);

  const chooseCanvasTool = useCallback((tool: CanvasTool) => {
    setActiveTool(tool);
    setDrawing(tool === 'draw');
    setConnectorStartId(null);
    if (tool === 'media') {
      uploadAt.current = camera.centerWorld();
      setUploadChooser(true);
      setActiveTool('select');
    }
    setToolMessage(tool === 'connector' ? 'Choose two objects to connect.' : '');
  }, [camera]);

  const createCanvasObject = useCallback((tool: CanvasTool, at: Point) => {
    let seed: NodeSeed | null = null;
    if (tool === 'text') seed = { ...canvasTextSeed(), payload: { ...canvasTextSeed().payload, canvasKind: 'text', content: '' } };
    if (tool === 'sticky') seed = { ...seedFor('note', { content: '', name: 'Sticky', canvasKind: 'sticky', appearance: { fill: '#fff2a8', foreground: '#101010' } }), w: 240, h: 220 };
    if (tool === 'shape') seed = { ...seedFor('canvas-text', { content: 'Shape', name: 'Shape', canvasKind: 'shape', shape: 'rounded-rectangle' satisfies CanvasShapeKind, appearance: { fill: '#ffffff', stroke: '#101010', strokeWidth: 2 } }), w: 260, h: 180 };
    if (tool === 'table') seed = { ...seedFor('note', { name: 'Table', canvasKind: 'table', table: { headerRow: true, rows: [['Heading', 'Heading'], ['Cell', 'Cell'], ['Cell', 'Cell']] } }), w: 420, h: 220 };
    if (!seed) return false;
    const [id] = spawnSeeds([seed], at);
    if (id) {
      setSelected([id]);
      const editImmediately = tool === 'text' || tool === 'sticky';
      setFocusNodeId(editImmediately ? id : null);
      setActiveDocumentId(editImmediately ? id : null);
    }
    setActiveTool('select');
    return true;
  }, [spawnSeeds]);

  const patchSelection = useCallback((patcher: (node: WorkspaceNode) => Partial<WorkspaceNode>) => {
    const ids = new Set(selected);
    workspace.mutateDocument((doc) => ({ ...doc, nodes: doc.nodes.map((node) => ids.has(node.id) ? { ...node, ...patcher(node), updatedAt: new Date().toISOString() } : node) }));
  }, [selected, workspace]);

  const transformPreview = useCallback((detail: NodeTransformDetail) => {
    if (detail.kind !== 'move') return;
    const snap = snapWorkspaceRect(detail.next, visibleNodes.filter((node) => node.id !== detail.nodeId && !selected.includes(node.id)), camera.cam.current.z);
    return { x: snap.x, y: snap.y };
  }, [camera.cam, selected, visibleNodes]);

  const transformCommit = useCallback((detail: NodeTransformDetail) => {
    const dx = detail.next.x - detail.origin.x;
    const dy = detail.next.y - detail.origin.y;
    const moving = selected.includes(detail.nodeId) ? new Set(selected) : new Set([detail.nodeId]);
    workspace.mutateDocument((doc) => ({ ...doc, nodes: doc.nodes.map((node) => {
      if (node.id === detail.nodeId) return { ...node, ...detail.next };
      if (detail.kind === 'move' && moving.has(node.id)) return { ...node, x: node.x + dx, y: node.y + dy };
      return node;
    }) }));
  }, [selected, workspace]);

  const removeWorkspaceNode = useCallback((node: WorkspaceNode) => {
    const sessionId = text(node.payload.sessionId);
    if (node.type === 'terminal' && node.payload.terminalMode === 'shell' && sessionId) {
      void stopTerminalSession(sessionId).catch(() => undefined);
    }
    workspace.removeNode(node.id);
  }, [workspace]);

  const deleteSelection = useCallback(() => {
    if (!selected.length) return;
    selected.forEach((id) => {
      const node = workspace.nodes.find((entry) => entry.id === id);
      if (node) removeWorkspaceNode(node);
    });
    setToolMessage(`Deleted ${selected.length} object${selected.length === 1 ? '' : 's'}.`);
    setSelected([]);
  }, [removeWorkspaceNode, selected, workspace.nodes]);

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

  const workspaceTerminal = useMemo(() => workspace.nodes.find((node) =>
    node.type === 'terminal'
    && node.payload.role === 'operator-terminal'
    && (node.payload.singletonKey === 'workspace-terminal' || node.payload.terminalMode === 'shell')
  ), [workspace.nodes]);

  const ensureWorkspaceTerminal = useCallback((presentation: 'canvas' | 'docked' | 'quick' = 'docked', requestedSeed?: NodeSeed) => {
    const existing = workspace.nodes.find((node) =>
      node.type === 'terminal'
      && node.payload.role === 'operator-terminal'
      && (node.payload.singletonKey === 'workspace-terminal' || node.payload.terminalMode === 'shell')
    );
    if (existing) {
      workspace.patchNode(existing.id, { payload: {
        ...existing.payload,
        singletonKey: 'workspace-terminal',
        terminalEntry: 'hii',
        terminalPresentation: presentation,
        windowState: 'normal'
      } });
      setSelected(presentation === 'canvas' ? [existing.id] : []);
      workspace.bringToFront(existing.id);
      return existing.id;
    }
    const seed = requestedSeed || terminalSeedFromCommand('/terminal');
    if (!seed) return null;
    seed.payload = { ...seed.payload, terminalPresentation: presentation, singletonKey: 'workspace-terminal', terminalEntry: 'hii' };
    const at = camera.toWorld(window.innerWidth / 2 - 430, window.innerHeight / 2 - 240);
    const [id] = spawnSeeds([seed], at);
    setSelected(presentation === 'canvas' && id ? [id] : []);
    return id || null;
  }, [camera, spawnSeeds, workspace]);

  useEffect(() => {
    if (!openTerminalOnReady || !runtimeEnabled || !workspace.ready || startupTerminalHandled.current) return;
    startupTerminalHandled.current = true;
    const seed = terminalSeedFromCommand('/terminal');
    if (!seed) return;
    seed.h = 600;
    seed.payload = {
      ...seed.payload,
      terminalPreface: FIRST_RUN_TERMINAL_PREFACE,
      terminalInitialInput: '/providers\r'
    };
    const id = ensureWorkspaceTerminal('canvas', seed);
    if (id) onTerminalReady?.();
  }, [ensureWorkspaceTerminal, onTerminalReady, openTerminalOnReady, runtimeEnabled, workspace.ready]);

  useEffect(() => {
    if (!workspace.ready || !workspaceTerminal) return;
    const operatorTerminals = workspace.nodes.filter((node) => node.type === 'terminal' && node.payload.role === 'operator-terminal' && node.payload.terminalMode === 'shell');
    workspace.patchNode(workspaceTerminal.id, { payload: {
      ...workspaceTerminal.payload,
      title: `HII · ${text(workspaceTerminal.payload.cwd).replace(/\/$/, '').split('/').filter(Boolean).at(-1) || 'workspace'}`,
      singletonKey: 'workspace-terminal',
      terminalEntry: 'hii',
      terminalPresentation: workspaceTerminal.payload.terminalPresentation || 'canvas'
    } });
    for (const legacy of operatorTerminals) {
      if (legacy.id === workspaceTerminal.id || legacy.payload.terminalPresentation === 'hidden') continue;
      workspace.patchNode(legacy.id, { payload: { ...legacy.payload, terminalPresentation: 'hidden', supersededBy: workspaceTerminal.id } });
    }
  // Normalize legacy terminal nodes once when a persisted workspace arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.ready, workspaceTerminal?.id]);

  const searchWeb = useCallback(async (query: string, at: Point) => {
    const results = await findInformation(query, { web: true, limit: 8 });
    const seeds = results.map<NodeSeed>((result) => ({
      type: 'link',
      w: 420,
      h: 250,
      object: {
        kind: 'source', owner: 'hii', status: 'ready', source: result.url,
        capabilityId: 'hii.information.find',
        audit: [{ ts: new Date().toISOString(), actor: 'hii', action: `found web source for ${query}` }]
      },
      payload: {
        infoId: result.id,
        title: result.title,
        url: result.url,
        excerpt: result.excerpt,
        siteName: result.siteName,
        contentHash: result.contentHash,
        capturedAt: result.capturedAt,
        query
      }
    }));
    if (seeds.length) spawnInformation(seeds, at);
    return results.length;
  }, [spawnInformation]);

  const selectedNodes = useMemo(() => workspace.nodes.filter((node) => selected.includes(node.id)), [selected, workspace.nodes]);
  useEffect(() => { onSelectionChange?.(selectedNodes); }, [onSelectionChange, selectedNodes]);

  const applyObjectiveAgentEvent = useCallback((nodeId: string, event: AgentEventV1) => {
    const node = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
    if (!node) return;
    const objectiveStatus = event.status === 'completed'
      ? 'completed'
      : event.status === 'failed'
        ? 'failed'
        : event.status === 'cancelled'
          ? 'cancelled'
          : 'running';
    const proofRefs = event.receiptPath
      ? [...new Set([...(node.object?.proofRefs || []), event.receiptPath])]
      : node.object?.proofRefs;
    const finished = ['completed', 'failed', 'cancelled'].includes(event.status);
    const priorOutput = text(node.payload.output);
    const nextOutput = event.text ? `${priorOutput}\n${event.text}`.trim() : priorOutput;
    workspaceRef.current.patchNode(nodeId, {
      payload: {
        ...node.payload,
        runId: event.runId,
        status: objectiveStatus,
        output: nextOutput,
        receiptPath: event.receiptPath || node.payload.receiptPath
      },
      object: {
        ...(node.object || { kind: 'intent' as const }),
        status: objectiveStatus,
        runId: event.runId,
        proofRefs,
        audit: finished
          ? [
              ...(node.object?.audit || []),
              { ts: new Date().toISOString(), actor: 'agent' as const, action: `objective run ${objectiveStatus}` }
            ].slice(-20)
          : node.object?.audit
      }
    });
    if (finished) activeObjectives.current.delete(event.runId);
  }, []);

  const startObjectiveAgent = useCallback(async (nodeId: string, intent: string) => {
    const node = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
    // A `run` object is the same governed thing as an agent-objective note: an
    // intent awaiting approval. It arrives here from the run pane's "Approve
    // bounded run" button rather than from a textarea submit.
    if (!node || (node.payload.role !== 'agent-objective' && node.type !== 'run') || !intent.trim()) return;
    const runMode = isCanvasMode(node.payload.mode) ? node.payload.mode : mode;
    const contextNodeIds = Array.isArray(node.payload.contextNodeIds)
      ? node.payload.contextNodeIds.filter((id): id is string => typeof id === 'string' && id !== nodeId).slice(0, 100)
      : [];
    const startedAt = new Date().toISOString();
    workspaceRef.current.patchNode(nodeId, {
      payload: {
        ...node.payload,
        draft: '',
        text: intent,
        status: 'running',
        output: `Preparing ${canvasMode(runMode).label.toLowerCase()} work…`
      },
      object: {
        ...(node.object || { kind: 'intent' as const }),
        owner: 'hii',
        status: 'running',
        capabilityId: 'hii.agent.workspace_run',
        audit: [
          ...(node.object?.audit || []),
          { ts: startedAt, actor: 'human' as const, action: 'bound objective to governed agent run' }
        ].slice(-20)
      }
    });
    try {
      const started = await startWithContext({
        intent: modeIntent(runMode, intent),
        mode: runMode,
        contextNodeIds
      }, async (result) => {
        activeObjectives.current.set(result.runId, nodeId);
        const current = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
        if (current) {
          workspaceRef.current.patchNode(nodeId, {
            payload: { ...current.payload, runId: result.runId, status: 'running' },
            object: { ...(current.object || { kind: 'intent' as const }), runId: result.runId }
          });
        }
        const buffered = bufferedAgentEvents.current.get(result.runId) || [];
        bufferedAgentEvents.current.delete(result.runId);
        for (const event of buffered) applyObjectiveAgentEvent(nodeId, event);
      });
      if (!started) {
        const current = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
        if (current) {
          workspaceRef.current.patchNode(nodeId, {
            payload: { ...current.payload, status: 'waiting_approval', output: 'Context review required before work begins.' },
            object: { ...(current.object || { kind: 'intent' as const }), status: 'waiting_approval' }
          });
        }
      }
    } catch (error) {
      const current = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
      if (!current) return;
      const message = error instanceof Error ? error.message : 'HII could not start the agent.';
      workspaceRef.current.patchNode(nodeId, {
        payload: { ...current.payload, status: 'failed', output: message },
        object: { ...(current.object || { kind: 'intent' as const }), status: 'failed' }
      });
    }
  }, [applyObjectiveAgentEvent, mode, startWithContext]);

  const queueAccountObjective = useCallback((intent: string) => {
    const value = intent.trim();
    if (!value || runtimeEnabled || !isAccount || !spaceId) return;
    const seed = objectiveSeedFromText(value, { mode, contextNodeIds: selected });
    const requestedAt = new Date().toISOString();
    seed.payload = {
      ...seed.payload,
      draft: '',
      text: value,
      status: 'queued',
      requestedAt,
      requestedBy: creatorId,
      output: 'Queued for your linked HII computer.'
    };
    seed.object = {
      ...(seed.object || { kind: 'intent' as const }),
      status: 'queued',
      audit: [
        ...(seed.object?.audit || []),
        { ts: requestedAt, actor: 'human', action: 'queued bounded work for a linked HII executor' }
      ]
    };
    spawnCenteredSeed(seed);
    setToolMessage('Queued for your linked HII computer. No browser shell access was granted.');
  }, [creatorId, isAccount, mode, runtimeEnabled, selected, spaceId, spawnCenteredSeed]);

  const queueExistingAccountObjective = useCallback((nodeId: string, intent: string) => {
    const value = intent.trim();
    const node = workspaceRef.current.nodes.find((entry) => entry.id === nodeId);
    if (!value || !node || runtimeEnabled || !isAccount || !spaceId) return;
    const requestedAt = new Date().toISOString();
    workspaceRef.current.patchNode(nodeId, {
      payload: {
        ...node.payload,
        draft: '',
        text: value,
        status: 'queued',
        requestedAt,
        requestedBy: creatorId,
        output: 'Queued for your linked HII computer.'
      },
      object: {
        ...(node.object || { kind: 'intent' as const }),
        status: 'queued',
        capabilityId: 'hii.agent.workspace_run',
        audit: [
          ...(node.object?.audit || []),
          { ts: requestedAt, actor: 'human' as const, action: 'queued bounded work for a linked HII executor' }
        ].slice(-20)
      }
    });
    setToolMessage('Queued for your linked HII computer. No browser shell access was granted.');
  }, [creatorId, isAccount, runtimeEnabled, spaceId]);

  const claimedAccountObjectives = useRef(new Set<string>());
  useEffect(() => {
    if (!runtimeEnabled || !workspace.ready) return;
    for (const node of workspace.nodes) {
      if (node.payload.role !== 'agent-objective' || node.payload.status !== 'queued') continue;
      if (!text(node.payload.requestedAt) || claimedAccountObjectives.current.has(node.id)) continue;
      claimedAccountObjectives.current.add(node.id);
      void startObjectiveAgent(node.id, text(node.payload.text) || text(node.payload.draft));
    }
  }, [runtimeEnabled, startObjectiveAgent, workspace.nodes, workspace.ready]);

  const stopWorkspaceRun = useCallback(async (node: WorkspaceNode) => {
    const runId = text(node.payload.runId);
    if (!runId) return;
    try {
      await cancelAgent(runId);
    } catch (error) {
      setToolMessage(error instanceof Error ? error.message : 'HII could not stop this run.');
      return;
    }
    // The cancelled AgentEventV1 writes the terminal status; this only records
    // that the stop was a human decision, so the receipt reads honestly.
    workspaceRef.current.patchNode(node.id, {
      object: {
        ...(node.object || { kind: 'run' as const }),
        audit: [
          ...(node.object?.audit || []),
          { ts: new Date().toISOString(), actor: 'human' as const, action: 'stopped bounded run' }
        ].slice(-20)
      }
    });
  }, []);

  const placeRunArtifacts = useCallback((output: string) => {
    const seeds = seedsFromRunOutput({ output, runId: activeRun.current || undefined });
    if (!seeds.length) return;
    const center = camera.toWorld(window.innerWidth / 2, window.innerHeight / 2);
    spawnSeeds(seeds, { x: center.x - 220, y: center.y - 140 });
    setToolMessage(`Placed ${seeds.length} run artifact${seeds.length === 1 ? '' : 's'} on the canvas.`);
  }, [camera, spawnSeeds]);

  const openProof = useCallback((receiptPath: string) => {
    void navigator.clipboard?.writeText(receiptPath).catch(() => {});
    setToolMessage(`Receipt path copied · ${receiptPath}`);
  }, []);

  const windowAction = useCallback((node: WorkspaceNode, action: 'minimize' | 'maximize' | 'restore') => {
    if (node.type !== 'app' && node.type !== 'terminal') return;
    const prior = node.payload.restoreBounds && typeof node.payload.restoreBounds === 'object'
      ? node.payload.restoreBounds as { x?: number; y?: number; w?: number; h?: number }
      : null;
    const restoreBounds = prior || { x: node.x, y: node.y, w: node.w, h: node.h };
    if (action === 'minimize') {
      workspace.patchNode(node.id, {
        ...(node.type === 'terminal' ? { h: 42 } : {}),
        payload: { ...node.payload, windowState: 'minimized', restoreBounds }
      });
      return;
    }
    if (action === 'maximize') {
      const topLeft = camera.toWorld(16, 54);
      const bottomRight = camera.toWorld(window.innerWidth - 16, window.innerHeight - 16);
      workspace.patchNode(node.id, {
        x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y,
        payload: { ...node.payload, windowState: 'maximized', restoreBounds }
      });
      workspace.bringToFront(node.id);
      return;
    }
    workspace.patchNode(node.id, {
      x: prior?.x ?? node.x,
      y: prior?.y ?? node.y,
      w: prior?.w ?? (node.type === 'terminal' ? 860 : 1080),
      h: prior?.h ?? (node.type === 'terminal' ? 480 : 720),
      payload: { ...node.payload, windowState: 'normal', restoreBounds: undefined }
    });
  }, [camera, workspace]);

  const openDevBrowser = useCallback((at: Point, requestedUrl?: string) => {
    const seed = renderedBrowserSeed(requestedUrl || 'https://developer.mozilla.org');
    if (!seed) return '';
    return spawnSeeds([seed], at)[0];
  }, [spawnSeeds]);

  const submitQuickWebSearch = useCallback((query: string) => {
    const center = camera.toWorld(window.innerWidth / 2, window.innerHeight / 2);
    const id = openDevBrowser({ x: center.x - 540, y: center.y - 360 }, query);
    if (!id) return;
    setWebSearchOpen(false);
    setPromptVisible(false);
    setToolMessage(`Opened web results for “${query}”.`);
  }, [camera, openDevBrowser]);

  const submit = useCallback(async (intent: string, anchor: Point, objectId?: string, conversationId?: string) => {
    const presentation = presentationRequest(intent, selected.length);
    const requestMode: CanvasModeId = presentation?.mode || mode;
    const requestIntent = presentation?.intent || intent;
    const activeMode = canvasMode(requestMode);
    if (presentation) setMode('show');
    setPrompt((current) => current ? {
      ...current,
      initialValue: requestIntent,
      response: requestMode === 'browse' ? 'Searching external context…' : `${activeMode.label} mode · ${activeMode.verb}…`,
      status: 'running'
    } : current);
    const at = camera.toWorld(anchor.x, anchor.y);
    try {
      const featureRequest = intent.match(/^\/feature\s+(.+)$/i);
      if (featureRequest) {
        const receipt = await requestFeature(featureRequest[1]);
        setPrompt((current) => current ? { ...current, response: receipt, status: 'completed' } : current);
        return;
      }
      const terminalSeed = terminalSeedFromCommand(intent);
      if (terminalSeed) {
        if (mode !== 'build') {
          setPrompt((current) => current ? { ...current, response: 'Terminal objects are created in Build mode. Switch to Build, then run this command again.', status: 'failed' } : current);
          return;
        }
        ensureWorkspaceTerminal('canvas', terminalSeed);
        setPrompt(null);
        setPromptVisible(false);
        return;
      }
      if (/^\/?(?:status|state)$/i.test(intent)) {
        const home = await readAgentHome();
        setPrompt((current) => current ? { ...current, response: formatActiveState(home), status: 'completed' } : current);
        return;
      }
      const browserCommand = intent.match(/^\/?browser(?:\s+(.+))?$/i);
      if (canMutateCanvas(mode) && browserCommand) {
        openDevBrowser(at, browserCommand[1]);
        setPrompt(null);
        setPromptVisible(false);
        return;
      }
      const searchCommand = intent.match(/^\/?search(?:\s+(.+))?$/i);
      if (canMutateCanvas(mode) && searchCommand?.[1]) {
        const count = await searchWeb(searchCommand[1], at);
        setPrompt((current) => current ? { ...current, response: `Placed ${count} source${count === 1 ? '' : 's'} on the canvas.`, status: 'completed' } : current);
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
        const count = await searchWeb(discovery[1], at);
        setPrompt((current) => current ? { ...current, response: `Placed ${count} source${count === 1 ? '' : 's'} on the canvas.`, status: 'completed' } : current);
        return;
      }
      // Resolved here rather than at the top of `submit` so a URL capture or a
      // web search carrying an `@` in its path is never read as a handle.
      const handles = resolveHandles(requestIntent, workspaceRef.current.nodes);
      if (handles.unresolved.length) {
        const names = handles.unresolved.map((reference) => reference.raw).join(', ');
        setPrompt((current) => current ? {
          ...current,
          response: `No canvas object answers to ${names}. Nothing ran.`,
          status: 'failed'
        } : current);
        return;
      }
      // A named object is context the person chose as deliberately as a
      // selection, so it enters the pack the same way and is reviewable there.
      const contextNodeIds = [...new Set([...selected, ...handles.nodes.map((node) => node.id)])];
      await startWithContext({
        intent: modeIntent(requestMode, handles.text),
        mode: requestMode,
        contextNodeIds
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
  }, [camera, ensureWorkspaceTerminal, mode, openDevBrowser, searchWeb, selected, spawnInformation, startWithContext]);

  useEffect(() => {
    if (!runtimeEnabled) return;
    let unlisten = () => {};
    let disposed = false;
    listenAgentEvents((event: AgentEventV1) => {
      const objectiveNodeId = activeObjectives.current.get(event.runId);
      if (activeRun.current !== event.runId && !objectiveNodeId) {
        const buffered = bufferedAgentEvents.current.get(event.runId) || [];
        bufferedAgentEvents.current.set(event.runId, [...buffered, event].slice(-20));
        return;
      }
      if (objectiveNodeId) {
        applyObjectiveAgentEvent(objectiveNodeId, event);
        return;
      }
      const conversation = activeConversation.current?.runId === event.runId ? activeConversation.current : null;
      if (conversation && event.text) {
        conversation.assistantText += `${conversation.assistantText ? '\n' : ''}${event.text}`;
      }
      setPrompt((current) => {
        if (!current || current.status !== 'running') return current;
        const response = mergeAgentResponse(current.response, event);
        return {
          ...current,
          response,
          status: event.status === 'failed' ? 'failed' : event.status === 'completed' ? 'completed' : 'running'
        };
      });
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
  }, [applyObjectiveAgentEvent, runtimeEnabled]);

  useEffect(() => {
    const inField = (target: EventTarget | null) => (target as Element | null)?.closest?.('input,textarea,[contenteditable]');
    const keydown = (event: KeyboardEvent) => {
      // The manager is a full-screen surface with its own keymap; nothing on
      // the canvas beneath it should react while it is up.
      if (canvasManagerOpen) return;
      if (isAccount && matchesCommandShortcut(event, commandShortcut)) {
        event.preventDefault();
        setCanvasCommandsOpen((open) => !open);
        setWebSearchOpen(false);
        setPromptVisible(false);
        return;
      }
      if (runtimeEnabled && isAssistantShortcut(event)) {
        event.preventDefault();
        if (workspaceTerminal?.payload.terminalPresentation === 'docked') {
          workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, terminalPresentation: 'hidden' } });
          return;
        }
        ensureWorkspaceTerminal('docked');
        setPromptVisible(false);
        return;
      }
      if (canvasCommandsOpen && event.key === 'Escape') {
        event.preventDefault();
        setCanvasCommandsOpen(false);
        setToolMessage('Commands closed.');
        return;
      }
      if (!inField(event.target) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.key === '?') {
        event.preventDefault();
        setCanvasCommandsOpen((open) => !open);
        setWebSearchOpen(false);
        setPromptVisible(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCanvasCommandsOpen((open) => !open);
        setWebSearchOpen(false);
        setPromptVisible(false);
        return;
      }
      if (runtimeEnabled && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        if (workspaceTerminal?.payload.terminalPresentation === 'docked') {
          workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, terminalPresentation: 'hidden' } });
        } else ensureWorkspaceTerminal('docked');
        setPromptVisible(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        setWebSearchOpen(true);
        setPromptVisible(false);
        setCanvasManagerOpen(false);
        return;
      }
      if (event.key === 'Escape' && activeDocumentId) {
        event.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        setActiveDocumentId(null);
        setFocusNodeId(null);
        setToolMessage('Editing finished.');
        return;
      }
      if (inField(event.target)) return;
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
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat) {
        const key = event.key.toLowerCase();
        const tool = ({ v: 'select', s: 'shape', c: 'connector', b: 'table', ...(!isAccount ? { t: 'text', n: 'sticky', d: 'draw' } : {}) } as Record<string, CanvasTool>)[key];
        if (tool) { event.preventDefault(); chooseCanvasTool(tool); return; }
      }
      if (isAccount && event.key === 'Escape') {
        // Escape keeps its old job first: it clears. Only an already-idle
        // canvas has nothing to clear, and that is when it opens the manager,
        // so the existing muscle memory is never overridden.
        if (drawing || canvasCommandsOpen || selected.length) {
          setDrawing(false);
          setCanvasCommandsOpen(false);
          setSelected([]);
          setToolMessage('Selection and active tool cleared.');
          return;
        }
        event.preventDefault();
        openCanvasManager();
        return;
      }
      // Camera keys run ahead of both branches: with nothing selected the arrows
      // move the viewport, so off-screen work is reachable without a pointer.
      const cameraKey = cameraKeyIntent(event, selected.length > 0);
      if (cameraKey) {
        event.preventDefault();
        if (cameraKey.kind === 'pan') {
          camera.panBy(cameraKey.dx, cameraKey.dy);
          setToolMessage('Moved the view.');
        } else {
          camera.zoomBy(cameraKey.factor);
          setToolMessage(`Zoomed ${cameraKey.factor > 1 ? 'in' : 'out'} to ${Math.round(camera.cam.current.z * 100)}%.`);
        }
        return;
      }
      if (!runtimeEnabled) {
        if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) {
          event.preventDefault();
          deleteSelection();
        }
        const history = historyShortcut(event);
        if (history) {
          event.preventDefault();
          history === 'redo' ? workspace.redo() : workspace.undo();
          return;
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
      if (event.key === 'Escape') {
        if (webSearchOpen || promptVisible || selected.length) { setWebSearchOpen(false); setPromptVisible(false); setSelected([]); return; }
        event.preventDefault();
        openCanvasManager();
        return;
      }
      if (isTerminalShortcut(event)) {
        event.preventDefault();
        const presentation = workspaceTerminal?.payload.terminalPresentation === 'canvas' ? 'docked' : 'canvas';
        ensureWorkspaceTerminal(presentation);
        setPromptVisible(false);
        return;
      }
      const history = historyShortcut(event);
      if (history) { event.preventDefault(); history === 'redo' ? workspace.redo() : workspace.undo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') { event.preventDefault(); fileInput.current?.click(); return; }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        const presentation = workspaceTerminal?.payload.terminalPresentation === 'canvas' ? 'docked' : 'canvas';
        ensureWorkspaceTerminal(presentation);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        openDevBrowser(camera.toWorld(mouse.current.x, mouse.current.y));
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) { event.preventDefault(); deleteSelection(); return; }
      if (selected.length && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        for (const id of selected) {
          const node = workspace.nodes.find((entry) => entry.id === id);
          if (!node) continue;
          workspace.patchNode(node.id, { x: node.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: node.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) });
        }
        return;
      }
      if (isDirectCanvasTyping(event)) {
        event.preventDefault();
        const at = camera.toWorld(mouse.current.x, mouse.current.y);
        const [id] = spawnSeeds([canvasTextSeed(event.key)], at);
        setFocusNodeId(id ?? null);
        setActiveDocumentId(id ?? null);
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
          openDevBrowser(at, value.trim());
          return;
        }
        spawnSeeds([canvasTextSeed(value.slice(0, 100_000))], at);
        return;
      }
      if (/^https?:\/\/\S+$/i.test(value.trim())) {
        openDevBrowser(at, value.trim());
      } else {
        spawnSeeds(directPasteSeeds([seedFromString(value)]), at);
      }
    };
    addEventListener('keydown', keydown);
    addEventListener('pointermove', pointermove);
    addEventListener('paste', paste);
    return () => { removeEventListener('keydown', keydown); removeEventListener('pointermove', pointermove); removeEventListener('paste', paste); };
  }, [activeDocumentId, allowPhoto, camera, canvasCommandsOpen, canvasManagerOpen, commandShortcut, chooseCanvasTool, deleteSelection, drawing, ensureWorkspaceTerminal, fitCanvas, importFiles, isAccount, isSpace, isTouchCanvas, mode, onRequestDevice, openCanvasManager, openDevBrowser, promptVisible, runtimeEnabled, selected, spawnCenteredSeed, spawnInformation, spawnSeeds, toggleDrawing, webSearchOpen, workspace, workspaceTerminal]);

  const canvasFeedback = toolMessage || (drawing
    ? 'Drawing on · drag anywhere · Esc to stop.'
    : selected.length
      ? `${selected.length} selected · drag to move${selected.length === 1 ? ' · drag handles to resize · double-click to edit' : ''} · Delete to remove.`
      : '');

  const openAssistantPanel = useCallback((initialValue = '') => {
    setPromptPresentation('terminal');
    setPrompt({
      anchor: { x: window.innerWidth / 2, y: window.innerHeight - 72 },
      initialValue,
      response: '',
      status: 'idle'
    });
    setPromptVisible(true);
  }, []);
  const startFromCommand = useCallback((intent: string) => {
    const anchor = { x: window.innerWidth / 2, y: window.innerHeight - 72 };
    setPromptPresentation('floating');
    setPrompt({ anchor, initialValue: intent, response: '', status: 'idle' });
    setPromptVisible(true);
    void submit(intent, anchor);
  }, [submit]);

  const openPresentationPanel = useCallback(() => {
    setMode('show');
    openAssistantPanel('/presentation ');
  }, [openAssistantPanel]);

  const openSearchPanel = useCallback(() => {
    setMode('browse');
    setWebSearchOpen(true);
    setPromptVisible(false);
  }, []);

  const openActivityPanel = useCallback(() => {
    setPromptPresentation('terminal');
    setPrompt({
      anchor: { x: window.innerWidth / 2, y: window.innerHeight - 72 },
      initialValue: '',
      response: 'Reading HII activity and proof…',
      status: 'running'
    });
    setPromptVisible(true);
    void readAgentHome()
      .then((home) => setPrompt((current) => current ? { ...current, response: formatActiveState(home), status: 'completed' } : current))
      .catch((error) => setPrompt((current) => current ? {
        ...current,
        response: error instanceof Error ? error.message : 'HII could not read activity.',
        status: 'failed'
      } : current));
  }, []);

  const selectionAction = useCallback((action: CanvasSelectionAction) => {
    if (action === 'format' || action === 'inspect') { setInspectorOpen(true); return; }
    if (action === 'export') { setExportOpen(true); return; }
    if (action === 'connect') { setActiveTool('connector'); setConnectorStartId(selected.length === 1 ? selected[0] : null); setToolMessage('Choose the next object to connect.'); return; }
  }, [selected]);

  const selectionBarAnchor = useMemo(() => {
    if (!selectedNodes.length || typeof window === 'undefined') return undefined;
    const left = Math.min(...selectedNodes.map((node) => node.x));
    const top = Math.min(...selectedNodes.map((node) => node.y));
    const right = Math.max(...selectedNodes.map((node) => node.x + node.w));
    const bottom = Math.max(...selectedNodes.map((node) => node.y + node.h));
    const view = camera.cam.current;
    const x = Math.min(window.innerWidth - 170, Math.max(170, view.x + ((left + right) / 2) * view.z));
    const above = view.y + top * view.z;
    const y = above > 82 ? above : Math.min(window.innerHeight - 90, view.y + bottom * view.z + 64);
    return { x, y };
  }, [camera.cam, cameraRevision, selectedNodes]);

  const content = (
    <main
      ref={camera.viewportRef}
      className="hii-canvas"
      data-zoom-level="detail"
      data-surface={surface}
      data-chrome={persistentChrome ? 'persistent' : 'adaptive'}
      data-commands-open={canvasCommandsOpen || undefined}
      data-drop-active={dropActive || undefined}
      tabIndex={-1}
      aria-label="HII canvas"
      onDoubleClick={(event) => {
        if ((event.target as Element).closest('[data-node-id],input,textarea,button,a,[data-workspace-ui]')) return;
        if (isTouchCanvas && drawing) return;
        if (Date.now() - lastTouchTap.current < 800) return;
        event.preventDefault();
        queueTextAt({ x: event.clientX, y: event.clientY });
      }}
      onClick={(event) => {
        if (event.detail !== 3 || Date.now() - lastTouchTap.current < 800) return;
        if ((event.target as Element).closest('[data-node-id],input,textarea,button,a,[data-workspace-ui]')) return;
        if (drawing || (isSpace && !allowPhoto)) return;
        event.preventDefault();
        showUploadAt({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        if (event.pointerType !== 'touch') return;
        activeTouchPointers.current.delete(event.pointerId);
        if (multiTouchSequence.current) {
          touchTap.current.pointerId = null;
          touchTap.current.start = null;
          touchTap.current.count = 0;
          if (activeTouchPointers.current.size === 0) multiTouchSequence.current = false;
          return;
        }
        if (touchTap.current.pointerId !== event.pointerId) return;
        const start = touchTap.current.start;
        touchTap.current.pointerId = null;
        touchTap.current.start = null;
        if (drawing || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
          touchTap.current.count = 0;
          return;
        }
        lastTouchTap.current = Date.now();
        const at = { x: event.clientX, y: event.clientY };
        const nearby = Math.hypot(at.x - touchTap.current.at.x, at.y - touchTap.current.at.y) < 32;
        touchTap.current.count = nearby && lastTouchTap.current - touchTap.current.time < 340 ? touchTap.current.count + 1 : 1;
        touchTap.current.at = at;
        touchTap.current.time = lastTouchTap.current;
        if (touchTap.current.count === 2) queueTextAt(at);
        if (touchTap.current.count === 3) {
          touchTap.current.count = 0;
          if (!isSpace || allowPhoto) showUploadAt(at);
        }
      }}
      onPointerCancel={(event) => {
        if (event.pointerType === 'touch') {
          activeTouchPointers.current.delete(event.pointerId);
          if (activeTouchPointers.current.size === 0) multiTouchSequence.current = false;
          touchTap.current.pointerId = null;
          touchTap.current.start = null;
          touchTap.current.count = 0;
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === 'touch') {
          activeTouchPointers.current.add(event.pointerId);
          if (activeTouchPointers.current.size > 1) {
            multiTouchSequence.current = true;
            touchTap.current.pointerId = null;
            touchTap.current.start = null;
            touchTap.current.count = 0;
            if (textTapTimer.current) clearTimeout(textTapTimer.current);
            textTapTimer.current = null;
          }
        }
        if ((event.target as Element).closest('[data-node-id],input,textarea,button,audio,video,a,[data-workspace-ui]')) return;
        if (event.pointerType === 'touch' && !multiTouchSequence.current) {
          touchTap.current.pointerId = event.pointerId;
          touchTap.current.start = { x: event.clientX, y: event.clientY };
        }
        setActiveDocumentId(null);
        setToolMessage('');
        setPromptVisible(false);
        if (drawing) {
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
        if (event.button !== 0) return;
        const createAt = camera.toWorld(event.clientX, event.clientY);
        if (createCanvasObject(activeTool, createAt)) { event.preventDefault(); return; }
        event.preventDefault();
        const start = camera.toWorld(event.clientX, event.clientY);
        const prior = event.shiftKey ? selected : [];
        trackPointerGesture(event.nativeEvent, {
          onMove: (_delta, current) => {
            const end = camera.toWorld(current.clientX, current.clientY);
            const rect = { x: start.x, y: start.y, w: end.x - start.x, h: end.y - start.y };
            setMarquee(rect);
            const hits = nodesInMarquee(visibleNodes, rect);
            setSelected(event.shiftKey ? [...new Set([...prior, ...hits])] : hits);
          },
          onEnd: (_delta, moved) => {
            if (!moved) setSelected(prior);
            setMarquee(null);
          },
          onCancel: () => {
            setSelected(prior);
            setMarquee(null);
          }
        });
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
      {!workspace.ready ? <div className="hii-workspace-load-state" data-workspace-ui role="status">
        <span>{workspace.syncError ? 'Could not load this canvas.' : 'Opening canvas...'}</span>
        {workspace.syncError && <button type="button" onClick={workspace.retrySave}>Retry</button>}
      </div> : (workspace.syncError || workspace.hasUnsavedChanges) && <div className="hii-workspace-save-state" data-workspace-ui role="status" aria-live="polite">
        <span>{workspace.syncError ? (workspace.hasUnsavedChanges ? 'Canvas not saved. Keep HII open.' : 'Canvas synchronization unavailable.') : 'Saving canvas...'}</span>
        {workspace.syncError && <button type="button" onClick={workspace.retrySave}>Retry save</button>}
      </div>}
      {persistentChrome && <UpdateBanner />}
      <CanvasThemeToggle />
      <CanvasToolbar
        activeTool={activeTool}
        open={canvasCommandsOpen}
        onOpenChange={setCanvasCommandsOpen}
        onToolChange={chooseCanvasTool}
        capabilities={{ scenes: true, export: selected.length === 1, nativeTerminal: runtimeEnabled, search: runtimeEnabled, activity: runtimeEnabled, remote: !runtimeEnabled }}
        onZoomOut={() => camera.zoomBy(1 / KEY_ZOOM_STEP)} onZoomIn={() => camera.zoomBy(KEY_ZOOM_STEP)} onFitView={fitCanvas}
        onOpenScenes={openPresentationPanel} onExport={() => setExportOpen(true)}
        onOpenTerminal={() => ensureWorkspaceTerminal('docked')} onSearch={openSearchPanel} onOpenActivity={openActivityPanel}
        onOpenRemote={() => { onRequestDevice?.(selectedNodes); setToolMessage('Opened HII Remote.'); }}
        onUpdateStatus={updateStatusAccess?.openUpdateStatus}
        hideDesktopChrome={desktopRuntime}
        selectionActions={selected.length ? [
          { label: 'Format selection', action: 'format' },
          { label: 'Inspect selection', action: 'inspect' },
          { label: 'Export selection', action: 'export' },
          { label: 'Connect selection', action: 'connect', disabled: selected.length > 2 }
        ] : undefined}
        onSelectionAction={selectionAction}
        onRequestFeature={desktopRuntime ? buildHiiFeature : undefined}
        onCaptureText={(value) => {
          const [id] = spawnCenteredSeed(canvasTextSeed(value.slice(0, 100_000)));
          if (id) { setSelected([id]); setFocusNodeId(null); }
          setToolMessage('Saved locally to this canvas.');
        }}
        onStartWork={runtimeEnabled ? startFromCommand : isAccount && spaceId ? queueAccountObjective : undefined}
        selectionLabels={selectedNodes.map(titleFor)}
        workUnavailableReason={!runtimeEnabled && (!isAccount || !spaceId) ? 'Agent work needs a connected HII executor. Canvas commands remain available here.' : undefined}
        shortcutLabel={isAccount ? commandShortcutLabel(commandShortcut) : '⌘K'}
        onShortcutChange={isAccount ? (shortcut) => { saveCommandShortcut(shortcut); setCommandShortcut(shortcut); } : undefined}
      />
      {isAccount && workspace.ready && !canvasManagerOpen && <CanvasOasis
        empty={visibleNodes.length === 0}
        recent={oasisRecent}
        spaces={oasisSpaces}
        onCommand={() => setCanvasCommandsOpen(true)}
        onNote={() => { spawnCenteredSeed(seedFor('note', { content: '', name: 'Note' })); }}
        onFile={(imagesOnly) => { setFileAccept(imagesOnly ? 'image/*' : ''); window.setTimeout(() => fileInput.current?.click(), 0); }}
        onLink={(url) => { spawnCenteredSeed(seedFromUrl(url)); }}
        onFocus={focusOasisTarget}
        onFit={fitCanvas}
      />}
      <CanvasSelectionBar
        selectionCount={selected.length}
        selectionType={selectedNodes[0]?.type}
        foreground={canvasObjectState(selectedNodes[0] || ({ payload: {} } as WorkspaceNode)).appearance?.foreground}
        fontSize={canvasObjectState(selectedNodes[0] || ({ payload: {} } as WorkspaceNode)).appearance?.fontSize}
        canConnect={selected.length <= 2}
        anchor={selectionBarAnchor}
        onAction={selectionAction}
      />
      {inspectorOpen && selectedNodes.length > 0 && <CanvasObjectInspector
        title={selectedNodes.length === 1 ? titleFor(selectedNodes[0]) : 'Multiple selection'} typeLabel={selectedNodes[0]?.type || 'objects'} selectionCount={selectedNodes.length}
        locked={selectedNodes.every((node) => canvasObjectState(node).locked)}
        fields={[{ label: 'Position', value: `${Math.round(selectedNodes[0].x)}, ${Math.round(selectedNodes[0].y)}` }, { label: 'Size', value: `${Math.round(selectedNodes[0].w)} × ${Math.round(selectedNodes[0].h)}` }]}
        actions={[
          { label: 'Align left', disabled: selectedNodes.length < 2, onClick: () => { const moves = alignWorkspaceNodes(selectedNodes, 'left'); patchSelection((node) => moves.get(node.id) || {}); } },
          { label: 'Align top', disabled: selectedNodes.length < 2, onClick: () => { const moves = alignWorkspaceNodes(selectedNodes, 'top'); patchSelection((node) => moves.get(node.id) || {}); } },
          { label: 'Distribute ↔', disabled: selectedNodes.length < 3, onClick: () => { const moves = distributeWorkspaceNodes(selectedNodes, 'x'); patchSelection((node) => moves.get(node.id) || {}); } },
          { label: 'Distribute ↕', disabled: selectedNodes.length < 3, onClick: () => { const moves = distributeWorkspaceNodes(selectedNodes, 'y'); patchSelection((node) => moves.get(node.id) || {}); } },
          { label: 'Group', disabled: selectedNodes.length < 2, onClick: () => { const groupId = `group-${Date.now()}`; patchSelection((node) => ({ payload: { ...node.payload, groupId } })); } },
          { label: 'Duplicate', onClick: () => { const result = duplicateWorkspaceNodes(workspace.document, selected); workspace.mutateDocument(() => result.doc); setSelected(result.createdIds); } },
          { label: 'Bring front', onClick: () => patchSelection(() => ({ z: workspace.takeZ() })) },
          { label: 'Send back', onClick: () => { const z = Math.min(...workspace.nodes.map((node) => node.z)) - 1; patchSelection(() => ({ z })); } }
        ]}
        onLockedChange={(locked) => patchSelection((node) => ({ payload: { ...node.payload, locked } }))} onClose={() => setInspectorOpen(false)}
      />}
      {canvasManagerOpen && <CanvasManager
        nodes={workspace.nodes}
        searchWorkspaces={searchWorkspaces}
        currentWorkspaceId={searchWorkspaceId ?? spaceId ?? 'local'}
        onFocusExternalNode={onFocusExternalNode ? (workspaceId, nodeId) => { setCanvasManagerOpen(false); onFocusExternalNode(workspaceId, nodeId); } : undefined}
        onFocusBoard={focusCanvasBoard}
        onFocusNode={focusCanvasNode}
        onClose={closeCanvasManager}
      />}
      {exportOpen && selected.length === 1 && (() => {
        const node = workspace.nodes.find((entry) => entry.id === selected[0]);
        if (!node) return null;
        return <ExportOutputPanel node={node} onClose={() => setExportOpen(false)} onCanvas={() => {
          const copy = makeNode({ type: node.type, w: node.w, h: node.h, object: node.object, objectRef: node.objectRef, payload: { ...node.payload, duplicatedFrom: node.id } }, node.x + 44, node.y + 44, workspace.takeZ());
          workspace.addNode(copy);
          setSelected([copy.id]);
          setExportOpen(false);
          setToolMessage('Placed an editable copy on the canvas.');
        }} onDownload={() => {
          downloadWorkspaceOutput(node);
          setExportOpen(false);
          setToolMessage('Prepared the selected output for saving.');
        }} />;
      })()}
      {isAccount && canvasFeedback && <div className="hii-canvas-feedback" role="status" aria-live="polite">{canvasFeedback}</div>}
      <div ref={camera.worldRef} className="hii-world">
        <svg className="hii-canvas-connectors" aria-label="Canvas connectors">
          {(workspace.document.links || []).map((link) => {
            const from = mountedNodes.find((node) => node.id === link.fromId);
            const to = mountedNodes.find((node) => node.id === link.toId);
            if (!from || !to) return null;
            return <line key={link.id} x1={from.x + from.w / 2} y1={from.y + from.h / 2} x2={to.x + to.w / 2} y2={to.y + to.h / 2} markerEnd="url(#hii-arrow)" />;
          })}
          <defs><marker id="hii-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
        </svg>
        {mountedNodes.map((node) => (
          <NodeFrame
            key={node.id}
            node={node}
            selected={selected.includes(node.id)}
            transformable={selected.length === 1 && selected[0] === node.id}
            editableContent={node.type === 'note' || node.type === 'canvas-text' || node.type === 'document' || canvasObjectPayload(node)?.canvasKind === 'table'}
            title={titleFor(node)}
            getZoom={() => camera.cam.current.z}
            onSelect={(event) => {
              if (activeTool === 'connector') {
                event.stopPropagation();
                if (!connectorStartId) { setConnectorStartId(node.id); setSelected([node.id]); setToolMessage('Choose the second object.'); }
                else if (connectorStartId !== node.id) {
                  workspace.mutateDocument((doc) => linkWorkspaceNodes(doc, connectorStartId, node.id));
                  setSelected([connectorStartId, node.id]); setConnectorStartId(null); setActiveTool('select'); setToolMessage('Objects connected.');
                }
                return;
              }
              if (activeDocumentId !== node.id) setActiveDocumentId(null);
              const additive = event.shiftKey || event.metaKey || event.ctrlKey;
              setSelected((ids) => additive
                ? ids.includes(node.id) ? ids.filter((id) => id !== node.id) : [...ids, node.id]
                : ids.includes(node.id) && ids.length > 1 ? ids : [node.id]);
              setToolMessage('');
              // Additive presses only change the selection. A following drag
              // moves the settled selection, avoiding the old shift-drag race.
              return !additive;
            }}
            contentActive={activeDocumentId === node.id}
            onActivateContent={() => { setActiveDocumentId(node.id); setFocusNodeId(node.id); }}
            onCommit={(patch) => workspace.patchNode(node.id, patch)}
            onTransformStart={() => workspace.bringToFront(node.id)}
            onTransformPreview={transformPreview}
            onTransformCommit={transformCommit}
            onWindowAction={(action) => windowAction(node, action)}
            onErase={() => { removeWorkspaceNode(node); setSelected((ids) => ids.filter((id) => id !== node.id)); }}
            onShare={onShareNode && (isAccount || (isSpace && isSpaceCanvasNode(node, spaceId))) ? () => onShareNode(node) : undefined}
            touchControls={isTouchCanvas}
            chromeless={node.payload.canvasPresentation === 'direct-paste' || node.type === 'canvas-text' || node.type === 'ink' || node.type === 'image' || node.type === 'document'}
          >
            <NodeBody
              node={node}
              autoFocus={focusNodeId === node.id}
              onAutoFocused={() => setFocusNodeId(null)}
              onPayload={(patch) => workspace.patchNode(node.id, { payload: { ...node.payload, ...patch } })}
              onResize={(size) => workspace.patchNode(node.id, size)}
              onAgentSubmit={(intent) => void (runtimeEnabled
                ? startObjectiveAgent(node.id, intent)
                : queueExistingAccountObjective(node.id, intent))}
              onBrowserCapture={(result) => spawnInformation(capturedInformationSeeds(result), { x: node.x + node.w + 40, y: node.y })}
              onOpenBrowser={(url) => openDevBrowser({ x: node.x + node.w + 40, y: node.y }, url)}
              onApproveRun={() => void (runtimeEnabled
                ? startObjectiveAgent(node.id, runIntent(node))
                : queueExistingAccountObjective(node.id, runIntent(node)))}
              onStopRun={() => void stopWorkspaceRun(node)}
              onOpenProof={openProof}
            />
          </NodeFrame>
        ))}
        {marquee && <div
          className="hii-selection-marquee"
          aria-hidden="true"
          style={{
            left: Math.min(marquee.x, marquee.x + marquee.w),
            top: Math.min(marquee.y, marquee.y + marquee.h),
            width: Math.abs(marquee.w),
            height: Math.abs(marquee.h)
          }}
        />}
      </div>
      {runtimeEnabled && (workspaceTerminal?.payload.terminalPresentation === 'docked' || workspaceTerminal?.payload.terminalPresentation === 'quick') && (
        <aside
          className="hii-docked-terminal"
          data-compact={workspaceTerminal.payload.terminalPresentation === 'quick' || undefined}
          data-workspace-ui
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDownCapture={(event) => {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'j') return;
            event.preventDefault();
            event.stopPropagation();
            workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, terminalPresentation: 'hidden' } });
          }}
        >
          <div className="hii-docked-terminal-context" aria-label="Terminal context">
            <span>{spaceId || runtimeSpaceId() || 'default'}</span>
            {selectedNodes.find((node) => typeof node.payload.path === 'string' && node.payload.path) && <button type="button" onClick={() => {
              const source = selectedNodes.find((node) => typeof node.payload.path === 'string' && node.payload.path);
              if (!source) return;
              void writeTerminalSession(text(workspaceTerminal.payload.sessionId), ` ${text(source.payload.path)} `);
            }}>Insert selected file path</button>}
          </div>
          <div className="hii-docked-terminal-actions">
            <button type="button" data-tooltip="Move to canvas · ⌘⇧T" aria-label="Move terminal to canvas" onClick={() => ensureWorkspaceTerminal('canvas')}><CornersOut size={16} /></button>
            <button type="button" data-tooltip="Hide · ⌘J" aria-label="Hide terminal" onClick={() => workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, terminalPresentation: 'hidden' } })}>×</button>
          </div>
          <TerminalBody node={workspaceTerminal} onPayload={(patch) => workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, ...patch } })} onAgentSubmit={(intent) => void startObjectiveAgent(workspaceTerminal.id, intent)} />
        </aside>
      )}
      {webSearchOpen && <QuickWebSearch onDismiss={() => setWebSearchOpen(false)} onSearch={submitQuickWebSearch} onOpen={(url) => {
        const center = camera.toWorld(window.innerWidth / 2, window.innerHeight / 2);
        openDevBrowser({ x: center.x - 380, y: center.y - 270 }, url);
        setWebSearchOpen(false);
      }} />}
      {runtimeEnabled && promptVisible && prompt && (
        <Prompt
          key={`${prompt.anchor.x}:${prompt.anchor.y}:${prompt.initialValue}:${prompt.menu || 'closed'}`}
          anchor={prompt.anchor}
          initialValue={prompt.initialValue}
          mode={mode}
          objectTitle={prompt.objectId ? titleFor(workspace.nodes.find((node) => node.id === prompt.objectId) || ({ type: 'context', payload: {} } as WorkspaceNode)) : undefined}
          response={prompt.response}
          status={prompt.status}
          initialMenu={prompt.menu}
          contextPack={prompt.contextPack}
          presentation={promptPresentation}
          workspaceLabel={spaceId ? `workspace · ${spaceId}` : 'working in ~/hii'}
          selectedCount={selected.length}
          timeline={prompt.objectId
            ? objectConversationTurns(workspace.nodes.find((node) => node.id === prompt.objectId)?.payload || {}, prompt.conversationId)
            : []}
          onDismiss={() => setPromptVisible(false)}
          onMode={setMode}
          onApproveContext={() => void approvePendingContext()}
          onRejectContext={rejectPendingContext}
          onDropContextItem={(objectId) => void dropContextItem(objectId)}
          nodes={workspace.nodes}
          onPlaceArtifacts={placeRunArtifacts}
          onSubmit={(value) => void submit(value, prompt.anchor, prompt.objectId, prompt.conversationId)}
        />
      )}
      {uploadChooser && <div className="hii-upload-chooser" data-workspace-ui role="dialog" aria-label="Import to canvas" onPointerDown={(event) => event.stopPropagation()}>
        <header><strong>Import</strong><small>Exports stay on this device</small></header>
        {!isSpace ? <div className="hii-import-sources">
          <button type="button" onClick={() => { setUploadChooser(false); notionInput.current?.click(); }}><b>N</b><span>Notion<small>Markdown, CSV, HTML, PDF</small></span></button>
          <button type="button" onClick={() => { setUploadChooser(false); miroInput.current?.click(); }}><b>M</b><span>Miro<small>PDF, CSV, images</small></span></button>
          <button type="button" onClick={() => { setUploadChooser(false); freeformInput.current?.click(); }}><b>F</b><span>Freeform<small>PDF or images</small></span></button>
        </div> : <div className="hii-import-sources"><button type="button" onClick={() => { setUploadChooser(false); cameraInput.current?.click(); }}><b>+</b><span>Camera<small>Take a Space photo</small></span></button></div>}
        <footer>
          <button type="button" onClick={() => { setUploadChooser(false); photosInput.current?.click(); }}>Photos</button>
          <button type="button" onClick={() => { setUploadChooser(false); fileInput.current?.click(); }}>Any file</button>
          <button type="button" onClick={() => { setUploadChooser(false); uploadAt.current = null; }}>Cancel</button>
        </footer>
      </div>}
      {(!isSpace || allowPhoto) && <>
      <input ref={cameraInput} className="hii-file-input" type="file" accept="image/*" capture="environment" aria-label="Take a photo for HII" onChange={(event) => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; acceptChosenFiles(files); }} />
      <input ref={photosInput} className="hii-file-input" type="file" accept="image/*" multiple={!isSpace} aria-label="Choose photos for HII" onChange={(event) => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; acceptChosenFiles(files); }} />
      {!isSpace && <>
      <input ref={notionInput} className="hii-file-input" type="file" multiple accept=".md,.markdown,.csv,.html,.htm,.txt,.json,.pdf,image/*" aria-label="Import a Notion export" onChange={(event) => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; acceptSourceFiles('Notion', files); }} />
      <input ref={miroInput} className="hii-file-input" type="file" multiple accept=".pdf,.csv,image/*" aria-label="Import a Miro export" onChange={(event) => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; acceptSourceFiles('Miro', files); }} />
      <input ref={freeformInput} className="hii-file-input" type="file" multiple accept=".pdf,image/*" aria-label="Import a Freeform export" onChange={(event) => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; acceptSourceFiles('Freeform', files); }} />
      </>}
      <input
        ref={fileInput}
        className="hii-file-input"
        type="file"
        multiple={!isSpace}
        accept={isSpace ? 'image/*' : fileAccept || undefined}
        aria-label={isSpace ? 'Take or choose a Space photo' : 'Import files to HII'}
        onChange={(event) => {
          const files = [...(event.currentTarget.files || [])];
          event.currentTarget.value = '';
          if (!files.length || (isSpace && !allowPhoto)) return;
          acceptChosenFiles(files);
        }}
      /></>}
    </main>
  );

  return content;
}
