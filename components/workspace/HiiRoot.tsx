'use client';

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
  runtimeSpaceId,
  startAgent,
  stopTerminalSession,
  type AgentEventV1,
  type ContextPackV1,
  type HiiApplicationManifest,
  type InformationCaptureResult
} from '@/lib/client/hii-bridge';
import { RunBody } from '@/components/workspace/RunBody';
import { handleCompletions, resolveHandles } from '@/lib/workspace/handles';
import { workspaceNodeTitle } from '@/lib/workspace/search';
import { seedsFromRunOutput } from '@/lib/workspace/stdout-types';
import { TypedOutput } from '@/components/workspace/TypedOutput';
import { renderedBrowserSeed } from '@/lib/workspace/browser-seed';
import { canvasTextSeed, canvasTextSize, clipboardFiles, directPasteSeeds, makeNode, nodeSeedFromResourceProjection, seedFor, seedFromFile, seedFromString, seedsFromDataTransfer, seedsFromFiles, type NodeSeed } from '@/lib/workspace/ingest';
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
  buildCurationAgentPrompt,
  createMusicPanelPayload,
  normalizeMusicPanelPayload,
  parseCurationProposal,
  type MusicPanelPayload
} from '@/lib/workspace/music-playlists';
import {
  isAssistantShortcut,
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
import { workspaceNodeTransform3D, type WorkspaceNode } from '@/lib/workspace/types';
import { applicationSeed } from '@/lib/workspace/application-seed';
import { UpdateBanner } from './UpdateBanner';
import { NodeFrame } from './NodeFrame';
import { ShellTerminal } from './ShellTerminal';
import { packagePlacementSeed, WAYMARK_PACKAGE, type HiiMarketplacePackage } from '@/lib/marketplace/catalog';
import { KEY_ZOOM_STEP, cameraKeyIntent, useCamera } from './useCamera';
import dynamic from 'next/dynamic';
import { useWorkspace, type WorkspacePersistence } from './useWorkspace';
import { SpaceToolbar } from '@/components/spaces/SpaceToolbar';
import { InkBody } from '@/components/spaces/InkBody';
import { inkSeedFromPoints } from '@/components/spaces/ink-capture';
import { isAccountCanvasNode, isAccountCanvasNodeType, isSpaceCanvasNode, isSpaceCanvasNodeType } from '@/components/spaces/space-surface';
import { trackPointerGesture } from '@/lib/workspace/gestures';
import { fitWorkspaceViewport } from '@/lib/workspace/viewport';
import { canvasManagerFocusNodes, type CanvasManagerBoard } from '@/lib/workspace/canvas-manager';
import { CanvasManager } from './CanvasManager';
import type { SearchableWorkspace } from '@/lib/workspace/cross-workspace-search';
const WorkspaceScene3D = dynamic(() => import('./WorkspaceScene3D').then((m) => m.WorkspaceScene3D), {
  ssr: false,
  loading: () => <div className="hii-scene3d-loading">Opening 3D view…</div>
});
import { nodesInMarquee, type MarqueeRect } from '@/lib/workspace/selection';
import { historyShortcut } from '@/lib/workspace/history-shortcut';
import { mergeAgentResponse } from '@/lib/workspace/agent-stream';
import { browserCanvasAssetUrl } from '@/lib/web/canvas-assets';
import { VoiceInputButton } from './VoiceInputButton';

const MusicPlaylistPanel = lazy(() => import('./MusicPlaylistPanel').then((module) => ({ default: module.MusicPlaylistPanel })));
const NativeDevBrowser = lazy(() => import('./NativeDevBrowser').then((module) => ({ default: module.NativeDevBrowser })));
const HiiMarketplace = lazy(() => import('./HiiMarketplace').then((module) => ({ default: module.HiiMarketplace })));

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
const HiiLinkApp = lazy(() => import('./HiiLinkApp').then((module) => ({ default: module.HiiLinkApp })));
const RegisteredApplication = lazy(() => import('./RegisteredApplication').then((module) => ({ default: module.RegisteredApplication })));
const WaymarkApp = lazy(() => import('./WaymarkApp').then((module) => ({ default: module.WaymarkApp })));

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
        <button type="button" onClick={onAsk}><Sparkle size={17} />Quick terminal <kbd>⌘ K</kbd></button>
        <button type="button" onClick={onActivity}><ListBullets size={17} />Activity & proof <kbd>⌘ 2</kbd></button>
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
  ['/marketplace', 'Open apps, skills, and runtimes']
] as const;

const promptKeyboardCommands = [
  ['⌘ K', 'Quick terminal'],
  ['⌘ T', 'Search Google on the canvas'],
  ['⌘ Space / ⌥ Space', 'Open or hide the HII terminal'],
  ['⌘ ⇧ T', 'Move the terminal between dock and canvas'],
  ['⌘ ⇧ B', 'Open the native browser'],
  ['⌘ U', 'Import files'],
  ['⌘ Z / ⇧ ⌘ Z', 'Undo / redo'],
  ['⇧ Tab', 'Cycle Build, Plan, Browse, See, Present'],
  ['?', 'Show all commands'],
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

function QuickWebSearch({
  onDismiss,
  onSearch
}: {
  onDismiss: () => void;
  onSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <form
      className="hii-canvas-search-text"
      data-workspace-ui
      onPointerDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        const value = query.trim();
        if (value) onSearch(value);
      }}
    >
      <input
        autoFocus
        aria-label="Write a web search on the canvas"
        autoComplete="off"
        spellCheck={false}
        value={query}
        placeholder="Search the web"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }}
      />
    </form>
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
  onInstallPackage,
  onCurationRequest,
  onBrowserAgent,
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
  onInstallPackage: (pkg: HiiMarketplacePackage, destination: string) => void;
  onCurationRequest: (request: string, payload: MusicPanelPayload) => void;
  onBrowserAgent: (request: string) => void;
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

  if (node.type === 'browser' && payload.surface === 'native-dev-browser') {
    return <DeferredSurface><NativeDevBrowser nodeId={node.id} initialUrl={url} onUrl={(nextUrl) => onPayload({ url: nextUrl, title: hostFor(nextUrl) })} onAgent={onBrowserAgent} onCapture={onBrowserCapture} onOpenObject={onOpenBrowser} /></DeferredSurface>;
  }
  if (node.type === 'browser' || node.type === 'link') return <SourceBody node={node} onOpen={onOpenBrowser} />;
  if (node.type === 'run') return <RunBody node={node} onApprove={onApproveRun} onStop={onStopRun} onOpenProof={onOpenProof} />;
  if (node.type === 'terminal') return <TerminalBody node={node} onPayload={onPayload} onAgentSubmit={onAgentSubmit} />;
  if (node.type === 'intent') return <RequestBody node={node} onPayload={onPayload} onAgentSubmit={onAgentSubmit} />;
  if (node.type === 'surface' && payload.surface === 'profile-music') {
    return <DeferredSurface><MusicPlaylistPanel payload={payload} onPayload={onPayload} onRequestCuration={onCurationRequest} /></DeferredSurface>;
  }
  if (node.type === 'surface' && payload.surface === 'hii-marketplace') return <DeferredSurface><HiiMarketplace onInstall={onInstallPackage} /></DeferredSurface>;
  if (node.type === 'app' && payload.surface === 'waymark-location') return <DeferredSurface><WaymarkApp destination={text(payload.destination) || 'this canvas'} onPayload={onPayload} /></DeferredSurface>;
  if (node.type === 'app' && payload.surface === 'hii-link') return <DeferredSurface><HiiLinkApp /></DeferredSurface>;
  if (node.type === 'app') return <DeferredSurface><RegisteredApplication name={name} summary={content || 'Registered HII application'} entryUrl={text(payload.entryUrl) || undefined} /></DeferredSurface>;
  if (node.type === 'html') return <iframe className="hii-html" srcDoc={text(payload.srcdoc)} title={name} sandbox="allow-forms allow-scripts" />;
  if (node.type === 'ink') return <InkBody node={node} />;
  if (node.type === 'image' && payload.sticker === true) return <div className="hii-sticker" role="img" aria-label={name}>{text(payload.emoji) || '✦'}</div>;
  if (node.type === 'image' || node.type === 'document' || node.type === 'media') return <AssetNodeBody node={node} />;
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
            placeholder={response ? 'Continue…' : 'Ask HII…'}
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

export function HiiRoot({
  surface = 'workspace',
  spaceId = '',
  creatorId = 'guest:pending',
  persistence,
  allowPhoto = true,
  persistentChrome = true,
  openTerminalOnReady = false,
  onTerminalReady,
  onUnsavedChanges,
  onShareNode,
  onRequestDevice,
  fileSeeder,
  canvasImportRequest = null,
  projectionRequest = null,
  searchWorkspaces,
  searchWorkspaceId,
  onFocusExternalNode,
  searchFocusNodeId = null
}: {
  surface?: 'workspace' | 'space' | 'account';
  spaceId?: string;
  creatorId?: string;
  persistence?: WorkspacePersistence;
  allowPhoto?: boolean;
  persistentChrome?: boolean;
  openTerminalOnReady?: boolean;
  onTerminalReady?: () => void;
  onUnsavedChanges?: (unsaved: boolean) => void;
  onShareNode?: (node: WorkspaceNode) => void;
  onRequestDevice?: () => void;
  fileSeeder?: (files: File[]) => Promise<NodeSeed[]>;
  canvasImportRequest?: CanvasImportRequest | null;
  projectionRequest?: WorkspaceProjectionRequest | null;
  searchWorkspaces?: () => Promise<SearchableWorkspace[]>;
  searchWorkspaceId?: string;
  onFocusExternalNode?: (workspaceId: string, nodeId: string) => void;
  searchFocusNodeId?: string | null;
} = {}) {
  const isSpace = surface === 'space';
  const isAccount = surface === 'account';
  const isTouchCanvas = isSpace || isAccount;
  const runtimeEnabled = !isTouchCanvas;
  const startupTerminalHandled = useRef(false);
  const save = useRef<() => void>(() => {});
  const settleCamera = useCallback(() => save.current(), []);
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
  const [canvasCommandsOpen, setCanvasCommandsOpen] = useState(false);
  const [canvasManagerOpen, setCanvasManagerOpen] = useState(false);
  /**
   * Which projection of the workspace is on screen.
   *
   * A projection, not a document: both views read `workspace.nodes` and write
   * through the same patch path, so switching never migrates or copies state.
   */
  const [projection, setProjection] = useState<'2d' | '3d'>(() => {
    if (typeof window === 'undefined') return '2d';
    return new URLSearchParams(window.location.search).get('view') === '3d' ? '3d' : '2d';
  });

  /**
   * Keep the projection in the URL.
   *
   * A view someone can link to is a view someone can send you, and it costs one
   * `replaceState` — no history entry, because switching projection is not
   * navigation and should not need two Backs to undo.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (projection === '3d') url.searchParams.set('view', '3d');
    else url.searchParams.delete('view');
    if (url.toString() !== window.location.href) window.history.replaceState(null, '', url);
  }, [projection]);
  const [toolMessage, setToolMessage] = useState('');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [devFixtureState, setDevFixtureState] = useState<'normal' | 'minimized' | 'maximized'>('normal');
  const mouse = useRef<Point>({ x: 400, y: 280 });
  const activeRun = useRef<string | null>(null);
  const activeObjectives = useRef(new Map<string, string>());
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

  const spawnSeeds = useCallback((seeds: NodeSeed[], at: Point, layout: 'cascade' | 'flow' = 'cascade') => {
    const ids: string[] = [];
    const acceptedSeeds = isSpace
      ? seeds.filter((seed) => isSpaceCanvasNodeType(seed.type))
      : isAccount
        ? seeds.filter((seed) => isAccountCanvasNodeType(seed.type))
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
  }, [camera, creatorId, isAccount, isSpace, isTouchCanvas, spaceId, workspace]);

  const spawnCenteredSeed = useCallback((seed: NodeSeed) => {
    const center = camera.centerWorld();
    return spawnSeeds([seed], { x: center.x - seed.w / 2, y: center.y - seed.h / 2 });
  }, [camera, spawnSeeds]);

  const importFiles = useCallback(async (files: File[], at: Point, direct = false) => {
    try {
      const seeds = await (fileSeeder ? fileSeeder(files) : seedsFromFiles(files));
      spawnSeeds(direct ? directPasteSeeds(seeds) : seeds, at, 'flow');
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

  const openCanvasManager = useCallback(() => {
    setDrawing(false);
    setCanvasCommandsOpen(false);
    setPromptVisible(false);
    setCanvasManagerOpen(true);
  }, []);

  const closeCanvasManager = useCallback(() => setCanvasManagerOpen(false), []);

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
  }, [mode, startWithContext]);

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
    setPromptPresentation('floating');
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
  }, [camera, ensureWorkspaceTerminal, mode, openDevBrowser, openMarketplace, openMusicPanel, searchWeb, selected, spawnInformation, startWithContext]);

  useEffect(() => {
    if (!runtimeEnabled) return;
    let unlisten = () => {};
    let disposed = false;
    listenAgentEvents((event: AgentEventV1) => {
      const objectiveNodeId = activeObjectives.current.get(event.runId);
      if (activeRun.current !== event.runId && !objectiveNodeId) return;
      if (objectiveNodeId) {
        const node = workspaceRef.current.nodes.find((entry) => entry.id === objectiveNodeId);
        if (node) {
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
          workspaceRef.current.patchNode(objectiveNodeId, {
            payload: {
              ...node.payload,
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
        }
        if (['completed', 'failed', 'cancelled'].includes(event.status)) activeObjectives.current.delete(event.runId);
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
        const response = mergeAgentResponse(current.response, event);
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
      // The manager is a full-screen surface with its own keymap; nothing on
      // the canvas beneath it should react while it is up.
      if (canvasManagerOpen) return;
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
      if (isAccount && canvasCommandsOpen && event.key === 'Escape') {
        event.preventDefault();
        setCanvasCommandsOpen(false);
        setToolMessage('Commands closed.');
        return;
      }
      if (isAccount && isAssistantShortcut(event)) {
        event.preventDefault();
        onRequestDevice?.();
        setToolMessage('Opened HII Remote.');
        return;
      }
      if (runtimeEnabled && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ensureWorkspaceTerminal('quick');
        setWebSearchOpen(false);
        setPromptVisible(false);
        setSelected([]);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        setWebSearchOpen(true);
        setPromptVisible(false);
        setCanvasManagerOpen(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '?') {
        event.preventDefault();
        setPrompt({ anchor: mouse.current, initialValue: '', response: '', status: 'idle', menu: 'commands' });
        setPromptPresentation('floating');
        setPromptVisible(true);
        setWebSearchOpen(false);
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
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.key === '?') {
        event.preventDefault();
        setPrompt({
          anchor: mouse.current,
          initialValue: '',
          response: '',
          status: 'idle',
          menu: 'commands'
        });
        setPromptPresentation('floating');
        setPromptVisible(true);
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
  }, [allowPhoto, camera, canvasCommandsOpen, canvasManagerOpen, deleteSelection, drawing, ensureWorkspaceTerminal, fitCanvas, importFiles, isAccount, isSpace, isTouchCanvas, mode, onRequestDevice, openCanvasManager, openDevBrowser, promptVisible, runtimeEnabled, selected, spawnCenteredSeed, spawnInformation, spawnSeeds, toggleDrawing, webSearchOpen, workspace, workspaceTerminal]);

  const canvasFeedback = toolMessage || (drawing
    ? 'Drawing on · drag anywhere · Esc to stop.'
    : selected.length
      ? `${selected.length} selected · drag to move · option-drag to resize · Delete to remove.`
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

  const projectionToggle = runtimeEnabled && persistentChrome ? (
    <nav className="hii-projection-toggle" aria-label="Workspace projection" data-workspace-ui onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-pressed={projection === '2d'}
        onClick={() => setProjection('2d')}
      >2D</button>
      <button
        type="button"
        aria-pressed={projection === '3d'}
        onClick={() => setProjection('3d')}
      >3D</button>
    </nav>
  ) : null;

  if (projection === '3d') {
    return (
      <main className="hii-canvas" data-surface={surface} data-projection="3d" aria-label="HII canvas, 3D view">
        {projectionToggle}
        <WorkspaceScene3D
          nodes={workspace.nodes}
          selectedIds={selected}
          onSelect={setSelected}
          onMove={(id, position) => {
            const node = workspace.nodes.find((item) => item.id === id);
            if (!node) return;
            const transform = workspaceNodeTransform3D(node);
            workspace.patchNode(id, {
              x: position.x,
              y: position.y,
              transform: { ...transform, position }
            });
          }}
        />
      </main>
    );
  }

  return (
    <main
      ref={camera.viewportRef}
      className="hii-canvas"
      data-surface={surface}
      data-chrome={persistentChrome ? 'persistent' : 'adaptive'}
      data-commands-open={canvasCommandsOpen || undefined}
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
        setActiveDocumentId(null);
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
        if (event.button !== 0) return;
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
      {runtimeEnabled && persistentChrome && <UpdateBanner />}
      {runtimeEnabled && persistentChrome && <CanvasChrome
        drawing={drawing}
        selectionCount={selected.length}
        onAddNote={() => {
          const [id] = spawnCenteredSeed(seedFor('note', { content: '', name: 'Note' }));
          setFocusNodeId(id ?? null);
        }}
        onAddText={() => {
          const [id] = spawnCenteredSeed(canvasTextSeed());
          setFocusNodeId(id ?? null);
        }}
        onAddFrame={() => spawnCenteredSeed({ ...seedFor('frame', { title: 'Frame' }), w: 720, h: 480 })}
        onAddFile={() => fileInput.current?.click()}
        onDraw={toggleDrawing}
        onPresentation={openPresentationPanel}
        onSearch={openSearchPanel}
        onTerminal={() => ensureWorkspaceTerminal('docked')}
        onAsk={() => { ensureWorkspaceTerminal('quick'); setPromptVisible(false); }}
        onActivity={openActivityPanel}
        onZoomOut={() => camera.zoomBy(1 / KEY_ZOOM_STEP)}
        onZoomIn={() => camera.zoomBy(KEY_ZOOM_STEP)}
        onFit={fitCanvas}
      />}
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
          const seed = renderedBrowserSeed(url);
          if (seed) spawnCenteredSeed(seed);
          setToolMessage(seed ? 'Link rendered.' : 'That link could not be opened.');
        }}
        onAddSticker={() => spawnCenteredSeed({ ...seedFor('image', { sticker: true, emoji: '✦', name: 'Sticker' }), w: 120, h: 120 })}
        onOpenTerminal={() => { onRequestDevice?.(); setToolMessage('Opened HII Remote.'); }}
        onUndo={() => { workspace.undo(); setToolMessage('Undid the last canvas change.'); }}
        onRedo={() => { workspace.redo(); setToolMessage('Redid the last canvas change.'); }}
        onFitView={fitCanvas}
        onZoomIn={() => camera.zoomBy(KEY_ZOOM_STEP)}
        onZoomOut={() => camera.zoomBy(1 / KEY_ZOOM_STEP)}
        onDeleteSelection={deleteSelection}
        onShareSelection={onShareNode ? shareSelection : undefined}
        onCommandsOpenChange={setCanvasCommandsOpen}
        onToggleDrawing={toggleDrawing}
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
      {projectionToggle}
      {isAccount && canvasFeedback && <div className="hii-canvas-feedback" role="status" aria-live="polite">{canvasFeedback}</div>}
      {runtimeEnabled && persistentChrome && workspace.nodes.some((node) => node.type === 'app') && <div className="hii-app-dock" onPointerDown={(event) => event.stopPropagation()}>
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
          {devFixtureState !== 'minimized' && <DeferredSurface><WaymarkApp destination="HII development board" onPayload={() => undefined} /></DeferredSurface>}
        </section>
      )}
      <div ref={camera.worldRef} className="hii-world">
        {visibleNodes.map((node) => (
          <NodeFrame
            key={node.id}
            node={node}
            selected={selected.includes(node.id)}
            title={titleFor(node)}
            getZoom={() => camera.cam.current.z}
            onSelect={(event) => {
              if (activeDocumentId !== node.id) setActiveDocumentId(null);
              setSelected((ids) => event.shiftKey
                ? ids.includes(node.id) ? ids.filter((id) => id !== node.id) : [...ids, node.id]
                : [node.id]);
              setToolMessage('');
              workspace.bringToFront(node.id);
            }}
            contentActive={activeDocumentId === node.id}
            onActivateContent={() => setActiveDocumentId(node.id)}
            onOpenConversation={() => { if (runtimeEnabled) openObjectConversation(node); }}
            onCommit={(patch) => workspace.patchNode(node.id, patch)}
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
              onAgentSubmit={(intent) => void startObjectiveAgent(node.id, intent)}
              onInstallPackage={installPackage}
              onCurationRequest={(request, payload) => void requestCuration(node.id, request, payload)}
              onBrowserAgent={(request) => void requestBrowserAgent(node, request)}
              onBrowserCapture={(result) => spawnInformation(capturedInformationSeeds(result), { x: node.x + node.w + 40, y: node.y })}
              onOpenBrowser={(url) => openDevBrowser({ x: node.x + node.w + 40, y: node.y }, url)}
              onApproveRun={() => void startObjectiveAgent(node.id, runIntent(node))}
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
      {runtimeEnabled && persistentChrome && (workspaceTerminal?.payload.terminalPresentation === 'docked' || workspaceTerminal?.payload.terminalPresentation === 'quick') && (
        <aside
          className="hii-docked-terminal"
          data-compact={workspaceTerminal.payload.terminalPresentation === 'quick' || undefined}
          data-workspace-ui
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDownCapture={(event) => {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
            event.preventDefault();
            event.stopPropagation();
            workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, terminalPresentation: 'hidden' } });
          }}
        >
          <div className="hii-docked-terminal-actions">
            <button type="button" data-tooltip="Move to canvas · ⌘⇧T" aria-label="Move terminal to canvas" onClick={() => ensureWorkspaceTerminal('canvas')}><CornersOut size={16} /></button>
            <button type="button" data-tooltip="Hide · ⌘Space" aria-label="Hide terminal" onClick={() => workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, terminalPresentation: 'hidden' } })}>×</button>
          </div>
          <TerminalBody node={workspaceTerminal} onPayload={(patch) => workspace.patchNode(workspaceTerminal.id, { payload: { ...workspaceTerminal.payload, ...patch } })} onAgentSubmit={(intent) => void startObjectiveAgent(workspaceTerminal.id, intent)} />
        </aside>
      )}
      {webSearchOpen && <QuickWebSearch onDismiss={() => setWebSearchOpen(false)} onSearch={submitQuickWebSearch} />}
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
