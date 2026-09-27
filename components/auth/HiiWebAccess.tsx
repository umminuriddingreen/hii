// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { HiiRoot } from '@/components/workspace/HiiRoot';
import { NativeDevBrowser } from '@/components/workspace/NativeDevBrowser';
import { browserSpacePersistence } from '@/components/spaces/SpaceCanvas';
import type { WorkspaceNode } from '@/lib/workspace/types';
import type { SearchableWorkspace } from '@/lib/workspace/cross-workspace-search';
import { browserCanvasSeedsFromFiles, hydrateBrowserCanvasAssets } from '@/lib/web/canvas-assets';
import {
  AccountWorkspacePersistence,
  createAccountDeviceLinkCode,
  createAccountWorkspace,
  createWorkspaceShareCode,
  listAccountDevices,
  listAccountWorkspaces,
  listWorkspaceMembers,
  redeemWorkspaceShareCode,
  revokeAccountDevice,
  revokeWorkspaceMember,
  type AccountDevice,
  type AccountWorkspaceMember,
  type AccountWorkspaceSummary
} from '@/lib/web/account-workspace';
import { nodeSeedFromFeedSnapshot, type FeedItem } from '@/lib/web/feed-contract';
import { comfyOutputUrl, compileCanvasContext, localComfyStatus, queueCanvasPrompt, waitForCanvasOutput } from '@/lib/web/comfy-create';
import { canvasTextSeed, type NodeSeed } from '@/lib/workspace/ingest';
import { HiiWebPanel, type WebPanel } from './HiiWebPanels';
import styles from './HiiWebAccess.module.css';

type AccessMode = 'login' | 'signup' | null;

function safeOAuthReturn(value: string | null, origin: string) {
  if (!value) return '';
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || target.pathname !== '/oauth/authorize') return '';
    return `${target.pathname}${target.search}`;
  } catch {
    return '';
  }
}

function workspaceDeepLink(search: string) {
  const params = new URLSearchParams(search);
  const workspaceId = params.get('workspace') ?? '';
  const nodeId = params.get('node') ?? '';
  return {
    workspaceId: /^[A-Za-z0-9_-]{43}$/.test(workspaceId) ? workspaceId : '',
    nodeId: nodeId && nodeId.length <= 128 ? nodeId : '',
  };
}

function HiiCanvasFrame({ accountName, workspaces, activeWorkspaceId, onWorkspaceSelect, onAccount, onFindObjects }: {
  accountName: string;
  workspaces: AccountWorkspaceSummary[];
  activeWorkspaceId: string;
  onWorkspaceSelect?: (id: string) => void;
  onAccount: () => void;
  onFindObjects: () => void;
}) {
  const [railOpen, setRailOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserUrl, setBrowserUrl] = useState('');
  return <>
    <button type="button" className={styles.railToggle} data-open={railOpen} data-workspace-ui aria-label={railOpen ? 'Hide navigation' : 'Show navigation'} onClick={() => setRailOpen((value) => !value)}>{railOpen ? '‹' : '☰'}</button>
    {railOpen && <aside className={styles.workspaceRail} data-workspace-ui aria-label="Workspace navigation">
      <div className={styles.railBrand}><strong>hii</strong><span>your workspace</span></div>
      <nav aria-label="Workspace views">
        <span aria-current="page">Canvas</span>
        <button type="button" onClick={onFindObjects}>Find objects <small>all workspaces</small></button>
        <button type="button" aria-pressed={browserOpen} onClick={() => setBrowserOpen((value) => !value)}>Browser <small>{browserOpen ? 'open' : 'closed'}</small></button>
      </nav>
      <section aria-label="Workspaces"><small>Workspaces</small>
        {workspaces.length ? workspaces.map((workspace) => <button key={workspace.id} type="button" aria-current={workspace.id === activeWorkspaceId ? 'page' : undefined} onClick={() => onWorkspaceSelect?.(workspace.id)}>{workspace.name}<small>{workspace.role}</small></button>) : <p>Browser-only canvas</p>}
      </section>
      <footer><button type="button" onClick={onAccount}>{accountName}</button><small>⌘K for canvas commands</small></footer>
    </aside>}
    <button type="button" className={styles.browserToggle} data-workspace-ui aria-label={browserOpen ? 'Hide browser pane' : 'Show browser pane'} onClick={() => setBrowserOpen((value) => !value)}>{browserOpen ? '×' : '◎'}</button>
    {browserOpen && <aside className={styles.browserDock} data-workspace-ui aria-label="Browser pane"><header><span>Browser</span><small>local-first</small></header><NativeDevBrowser nodeId="workspace-browser-dock" initialUrl={browserUrl} startEmpty={!browserUrl} docked onUrl={setBrowserUrl} /></aside>}
  </>;
}

type Session = {
  authenticated: boolean;
  accountId?: string;
  handle?: string;
  csrfToken?: string;
  source?: 'account' | 'network' | 'local';
};

const LOCAL_OWNER_ACCOUNT_ID = 'z1zLugCcqYOu8FfOK51CCmatt6Q19nJrmEyqKZLi5Js';

function ComfyCreatePanel({ nodes, onClose, onOutput }: { nodes: WorkspaceNode[]; onClose: () => void; onOutput: (seed: NodeSeed) => void }) {
  const context = useMemo(() => compileCanvasContext(nodes), [nodes]);
  const [direction, setDirection] = useState('Create a coherent architectural visualization from this selected HII canvas context. Preserve the core intent, spatial relationships, material logic, atmosphere, and human scale.');
  const [status, setStatus] = useState('Checking local ComfyUI…');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void localComfyStatus().then(() => setStatus('Local ComfyUI ready on this computer.')).catch(() => setStatus('Local ComfyUI bridge is not reachable on this computer.')); }, []);
  async function generate() {
    if (!context || busy) return;
    setBusy(true);
    setStatus('Queued on local hardware…');
    try {
      const fullPrompt = `${direction.trim()}\n\nHII CANVAS CONTEXT:\n${context}`.slice(0, 16_000);
      const promptId = await queueCanvasPrompt(fullPrompt);
      setStatus(`Rendering locally · ${promptId.slice(0, 8)}`);
      const output = await waitForCanvasOutput(promptId);
      const url = comfyOutputUrl(output);
      onOutput({
        type: 'image', w: 520, h: 520,
        object: { kind: 'artifact', owner: 'hii', status: 'completed', source: url, capabilityId: 'hii.create.workflow', proofRefs: [`comfy-prompt:${promptId}`], audit: [{ ts: new Date().toISOString(), actor: 'hii', action: 'generated from explicit canvas selection through local ComfyUI' }] },
        payload: { title: 'HII Create output', name: output.filename, url, prompt: fullPrompt, promptId }
      });
      setStatus('Complete · output placed back on the canvas.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Local generation failed.'); }
    finally { setBusy(false); }
  }
  return <aside className={styles.comfyPanel} data-workspace-ui aria-label="Create with local ComfyUI">
    <header><strong>HII Create</strong><button type="button" onClick={onClose}>close</button></header>
    <small>selected canvas context · {nodes.length} object{nodes.length === 1 ? '' : 's'} · local hardware only</small>
    <pre>{context || 'Select one or more canvas objects first.'}</pre>
    <label>creative direction<textarea value={direction} onChange={(event) => setDirection(event.target.value)} /></label>
    <button type="button" disabled={!context || busy} onClick={() => void generate()}>{busy ? 'rendering…' : 'review and render locally'}</button>
    <p role="status" aria-live="polite">{status}</p>
  </aside>;
}

function localOwnerSession(hostname: string): Session | null {
  const normalized = hostname.toLocaleLowerCase();
  const loopback = normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized.endsWith('.localhost');
  return loopback ? {
    authenticated: true,
    accountId: LOCAL_OWNER_ACCOUNT_ID,
    handle: 'local owner',
    source: 'local',
  } : null;
}

async function networkOwnerSession(): Promise<Session | null> {
  try {
    const response = await fetch('/hii/network/session', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const session = await response.json() as Session;
    return session.authenticated ? session : null;
  } catch {
    return null;
  }
}

type RegistrationOptions = {
  ceremonyId: string;
  publicKey: PublicKeyCredentialCreationOptionsJSON;
};

type LoginOptions = {
  ceremonyId: string;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
};

function bytesFromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64urlFromBytes(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function api<T>(path: string, body?: unknown, csrfToken?: string): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrfToken ? { 'X-HII-CSRF': csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request_failed');
  return payload;
}

function registrationCredential(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: base64urlFromBytes(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64urlFromBytes(response.clientDataJSON),
      attestationObject: base64urlFromBytes(response.attestationObject),
    },
  };
}

function loginCredential(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: base64urlFromBytes(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64urlFromBytes(response.clientDataJSON),
      authenticatorData: base64urlFromBytes(response.authenticatorData),
      signature: base64urlFromBytes(response.signature),
      userHandle: response.userHandle ? base64urlFromBytes(response.userHandle) : null,
    },
  };
}

function ProsumerLanding({ onLogin, onCreateAccount }: { onLogin: () => void; onCreateAccount: () => void }) {
  return (
    <div className={styles.landing}>
      <header className={styles.landingHeader}>
        <a className={styles.landingBrand} href="#top" aria-label="HII home">
          <strong>HII</strong>
          <span>human information interface</span>
        </a>
        <nav aria-label="HII account access">
          <button type="button" onClick={onLogin}>log in</button>
          <button type="button" onClick={onCreateAccount}>create your HII</button>
        </nav>
      </header>

      <section className={styles.hero} id="top" aria-labelledby="hii-hero-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Human Information Interface / local-first</p>
          <h1 id="hii-hero-title">Everything you&apos;ve made.<br />Ready to make what&apos;s next.</h1>
          <p className={styles.heroBody}>HII gives your files, notes, links, media, projects, and tools one working surface—then lets your own agent create with them.</p>
          <div className={styles.heroActions}>
            <a href="/">try the canvas</a>
            <a href="/site-analysis">site analysis for students</a>
            <button type="button" onClick={onCreateAccount}>create your HII</button>
          </div>
          <p className={styles.heroNote}>Start in your browser. No account needed. Your first canvas stays on this device.</p>
        </div>
        <figure className={styles.heroVisual}>
          <div className={styles.visualHeader}><span>workspace</span><span>live HII surface</span></div>
          <Image
            src="/marketing/hii-workspace-live.png"
            alt="A live HII canvas with a launch brief, approved context, agent conversation, and verified receipt arranged as connected objects."
            width={1280}
            height={720}
            priority
            sizes="(max-width: 900px) 100vw, 58vw"
          />
          <figcaption><span>local-first workspace</span><span>context → work → proof</span></figcaption>
        </figure>
      </section>

      <section className={styles.workingLoop} aria-labelledby="working-loop-title">
        <header>
          <p className={styles.eyebrow}>One creative loop</p>
          <h2 id="working-loop-title">Your material becomes a workspace, not a pile of uploads.</h2>
        </header>
        <ol className={styles.loopRail}>
          <li><article><small>01 / Bring it in</small><h3>Collect your world.</h3><p>Drop in files and media. Paste links. Write notes. Capture useful pages in the browser.</p><span>files · images · video · PDF · notes · links</span></article></li>
          <li><article><small>02 / Work with it</small><h3>Ask HII directly.</h3><p>Select what matters and describe the outcome. HII keeps the relevant context attached to the work.</p><span>selection · text intent · local intelligence</span></article></li>
          <li><article><small>03 / Carry it forward</small><h3>Keep the result connected.</h3><p>Return finished work to the canvas, synchronize the workspace, and invite trusted collaborators with explicit access.</p><span>artifacts · workspaces · collaborators · proof</span></article></li>
        </ol>
      </section>

      <section className={styles.productProof} aria-labelledby="product-proof-title">
        <header>
          <p className={styles.eyebrow}>Your information. Your tools. Your agent.</p>
          <h2 id="product-proof-title">The technical layer stays underneath. You stay in the creative loop.</h2>
        </header>
        <article className={styles.proofFeature}>
          <figure className={styles.productFrame}>
            <div className={styles.visualHeader}><span>command palette</span><span>choose the capability</span></div>
            <Image
              src="/marketing/hii-command-palette-live.png"
              alt="The HII command palette offering real workspace capabilities such as a terminal, browser, chat, note, and live system context."
              width={1280}
              height={720}
              loading="lazy"
              sizes="(max-width: 900px) 100vw, 58vw"
            />
          </figure>
          <div className={styles.proofCopy}>
            <p className={styles.eyebrow}>Direct manipulation</p>
            <h3>Point at the context. Choose the move.</h3>
            <p>Files, pages, notes, terminals, and agent runs stay visible as objects. Select what matters, then ask for one bounded outcome.</p>
            <span>selection · intent · approved context</span>
          </div>
        </article>
        <article className={`${styles.proofFeature} ${styles.proofFeatureReverse}`}>
          <figure className={styles.productFrame}>
            <div className={styles.visualHeader}><span>run receipt</span><span>proof returned to the canvas</span></div>
            <Image
              src="/marketing/hii-run-receipt-live.png"
              alt="A completed HII run showing approved intent, bounded work, collected proof, a saved artifact, and the final receipt on the canvas."
              width={1920}
              height={1080}
              loading="lazy"
              sizes="(max-width: 900px) 100vw, 58vw"
            />
          </figure>
          <div className={styles.proofCopy}>
            <p className={styles.eyebrow}>Visible result</p>
            <h3>Keep the artifact and the evidence together.</h3>
            <p>HII returns the finished work, its source context, and a receipt you can inspect before trusting or repeating it.</p>
            <span>artifact · verification · receipt</span>
          </div>
        </article>
      </section>

      <section className={styles.controlSection} aria-labelledby="control-title">
        <div className={styles.controlCopy}>
          <p className={styles.eyebrow}>Private by design</p>
          <h2 id="control-title">Power without giving up control.</h2>
          <p>HII can use connected computers, local models, browser research, and bounded tools. Consequential work stays visible, permissioned, and revocable.</p>
          <button type="button" onClick={onCreateAccount}>start with your own workspace</button>
        </div>
        <aside className={styles.controlCard} aria-label="HII authority boundary">
          <header><strong>Authority boundary</strong><span>owner controlled</span></header>
          <dl>
            <div><dt>context</dt><dd>source-linked</dd></div>
            <div><dt>execution</dt><dd>bounded</dd></div>
            <div><dt>access</dt><dd>revocable</dd></div>
            <div><dt>result</dt><dd>receipt attached</dd></div>
          </dl>
          <p>Local-first by default. Nothing is connected, transmitted, or published silently.</p>
        </aside>
      </section>

      <footer className={styles.landingFooter}>
        <span>hii · Human Information Interface</span>
        <nav><a href="/download">desktop app</a><a href="/docs">documentation</a><a href="/privacy">privacy</a></nav>
      </footer>
    </div>
  );
}

export function HiiWebAccess() {
  const [mode, setMode] = useState<AccessMode>(null);
  const [oauthReturn, setOAuthReturn] = useState('');
  const authRef = useRef<HTMLElement | null>(null);
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [personalAccess, setPersonalAccess] = useState(false);
  useEffect(() => {
    let active = true;
    setPersonalAccess(false);
    if (session.authenticated && session.source !== 'local') {
      fetch('/api/personal/access', { cache: 'no-store' }).then(r => {
        if (active) {
          setPersonalAccess(r.ok);
          if (r.ok && !window.location.search) window.location.replace('/');
        }
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [session.authenticated, session.accountId, session.source]);

  const [browserOnly, setBrowserOnly] = useState(false);
  const [handle, setHandle] = useState('');
  const [message, setMessage] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [cliLinkRequested, setCliLinkRequested] = useState(false);
  const [productSite, setProductSite] = useState(false);
  const [deviceMessage, setDeviceMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [panel, setPanel] = useState<WebPanel | null>(null);
  const [shareNode, setShareNode] = useState<WorkspaceNode | null>(null);
  const [agentContextNodes, setAgentContextNodes] = useState<WorkspaceNode[]>([]);
  const [canvasImport, setCanvasImport] = useState<{ id: string; seed: ReturnType<typeof nodeSeedFromFeedSnapshot> } | null>(null);
  const [comfyOpen, setComfyOpen] = useState(false);
  const [selectedCanvasNodes, setSelectedCanvasNodes] = useState<WorkspaceNode[]>([]);
  const [workspaces, setWorkspaces] = useState<AccountWorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [searchFocusNodeId, setSearchFocusNodeId] = useState<string | null>(null);
  const [canvasManagerRequest, setCanvasManagerRequest] = useState(0);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceMessage, setWorkspaceMessage] = useState('');
  const canvasUnsaved = useRef(false);
  const setCanvasUnsaved = useCallback((unsaved: boolean) => { canvasUnsaved.current = unsaved; }, []);
  const [shareCode, setShareCode] = useState('');
  const [redeemCode, setRedeemCode] = useState('');
  const [accountDevices, setAccountDevices] = useState<AccountDevice[]>([]);
  const [appLinkCode, setAppLinkCode] = useState('');
  const [workspaceMembers, setWorkspaceMembers] = useState<AccountWorkspaceMember[]>([]);
  const canvasAccountId = session.accountId ?? '';
  const canvasAccountReady = /^[A-Za-z0-9_-]{43}$/.test(canvasAccountId);
  const accountSync = session.source === 'account' && Boolean(session.csrfToken);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const canvasSpaceId = activeWorkspace?.id ?? `account:${canvasAccountId}`;
  const canvasPersistence = useMemo(
    () => !canvasAccountReady
      ? undefined
      : accountSync && activeWorkspace
        ? new AccountWorkspacePersistence(
            activeWorkspace.id,
            session.csrfToken ?? '',
            (document) => hydrateBrowserCanvasAssets(canvasAccountId, document)
          )
        : browserSpacePersistence(
            `account:${canvasAccountId}`,
            (document) => hydrateBrowserCanvasAssets(canvasAccountId, document)
          ),
    [accountSync, activeWorkspace?.id, canvasAccountId, canvasAccountReady, session.csrfToken],
  );
  const searchWorkspaces = useCallback(async (): Promise<SearchableWorkspace[]> => {
    if (!accountSync) return [];
    return Promise.all(workspaces.map(async (entry) => {
      const document = await new AccountWorkspacePersistence(entry.id, session.csrfToken ?? '').read();
      return { id: entry.id, title: entry.name, nodes: document.nodes };
    }));
  }, [accountSync, session.csrfToken, workspaces]);
  const focusSearchResult = useCallback((workspaceId: string, nodeId: string) => {
    if (canvasUnsaved.current) { setWorkspaceMessage('Save or retry the current canvas before changing workspaces.'); return; }
    setSearchFocusNodeId(nodeId);
    setActiveWorkspaceId(workspaceId);
  }, []);
  // The signed-out canvas is the same surface, kept in this browser only.
  const guestPersistence = useMemo(() => browserSpacePersistence('guest'), []);
  const canvasFileSeeder = useCallback(
    (files: File[]) => browserCanvasSeedsFromFiles(canvasAccountId, files),
    [canvasAccountId],
  );

  useEffect(() => {
    if (!mode) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = authRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') ?? []);
    (dialog?.querySelector<HTMLElement>('input') ?? controls()[0])?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMode(null);
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0];
        const last = items[items.length - 1];
        if (!dialog?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [mode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedLink = params.get('link') === 'cli';
    const requestedFirstRun = params.get('first-run') === '1';
    const requestedOAuthReturn = safeOAuthReturn(params.get('oauth_return'), window.location.origin);
    const deepLink = workspaceDeepLink(window.location.search);
    if (params.get('site') === '1') setProductSite(true);
    setCliLinkRequested(requestedLink);
    if (requestedLink) setMode('login');
    if (requestedOAuthReturn) {
      setOAuthReturn(requestedOAuthReturn);
      setMode('login');
    }
    if (deepLink.nodeId) setSearchFocusNodeId(deepLink.nodeId);
    if (requestedFirstRun) {
      setReady(true);
      return;
    }
    const localSession = localOwnerSession(window.location.hostname);
    if (localSession) {
      setSession(localSession);
      setReady(true);
      return;
    }
    let active = true;
    void networkOwnerSession()
      .then(async (networkSession) => networkSession
        ? { ...networkSession, source: 'network' as const }
        : { ...(await api<Session>('/api/auth/session')), source: 'account' as const })
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession({ authenticated: false }); })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ready || !session.authenticated || !oauthReturn) return;
    window.location.assign(oauthReturn);
  }, [oauthReturn, ready, session.authenticated]);

  useEffect(() => {
    if (cliLinkRequested && session.authenticated) setAccountOpen(true);
  }, [cliLinkRequested, session.authenticated]);

  useEffect(() => {
    if (!ready || productSite) return;
    const toggleAccount = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.code !== 'Digit1' || event.repeat) return;
      event.preventDefault();
      setAccountOpen((value) => !value);
    };
    window.addEventListener('keydown', toggleAccount);
    return () => window.removeEventListener('keydown', toggleAccount);
  }, [ready, productSite]);

  useEffect(() => () => {
    if (canvasPersistence instanceof AccountWorkspacePersistence) canvasPersistence.dispose();
  }, [canvasPersistence]);

  const refreshWorkspaces = useCallback(async (preferredId = '') => {
    if (!accountSync || !session.csrfToken) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      let next = await listAccountWorkspaces();
      if (!next.length) {
        const created = await createAccountWorkspace(`${session.handle ?? 'My'} HII`, session.csrfToken);
        next = [created];
      }
      setWorkspaces(next);
      setActiveWorkspaceId((current) => {
        if (canvasUnsaved.current) return current;
        const linkedWorkspace = typeof window === 'undefined' ? '' : workspaceDeepLink(window.location.search).workspaceId;
        const requested = preferredId || current || linkedWorkspace;
        return next.some((workspace) => workspace.id === requested) ? requested : next[0]?.id ?? '';
      });
    } catch {
      setWorkspaceMessage('could not synchronize account workspaces.');
    } finally {
      setWorkspaceBusy(false);
    }
  }, [accountSync, session.csrfToken, session.handle]);

  const refreshDevices = useCallback(async () => {
    if (!accountSync) return;
    try {
      setAccountDevices(await listAccountDevices());
    } catch {
      setWorkspaceMessage('could not load linked apps.');
    }
  }, [accountSync]);

  const refreshMembers = useCallback(async () => {
    if (!accountSync || !activeWorkspace || !['owner', 'admin'].includes(activeWorkspace.role)) {
      setWorkspaceMembers([]);
      return;
    }
    try {
      setWorkspaceMembers(await listWorkspaceMembers(activeWorkspace.id));
    } catch {
      setWorkspaceMessage('could not load workspace members.');
    }
  }, [accountSync, activeWorkspace]);

  useEffect(() => {
    if (!accountSync) {
      setWorkspaces([]);
      setActiveWorkspaceId('');
      return;
    }
    void refreshWorkspaces();
    void refreshDevices();
  }, [accountSync, refreshDevices, refreshWorkspaces]);

  useEffect(() => {
    setShareCode('');
    void refreshMembers();
  }, [activeWorkspaceId, refreshMembers]);

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canvasUnsaved.current) { setWorkspaceMessage('Save or retry the current canvas before changing workspaces.'); return; }
    if (!session.csrfToken || !workspaceName.trim() || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const created = await createAccountWorkspace(workspaceName, session.csrfToken);
      setWorkspaceName('');
      await refreshWorkspaces(created.id);
      setWorkspaceMessage(`${created.name} is ready.`);
    } catch {
      setWorkspaceMessage('could not create that workspace.');
      setWorkspaceBusy(false);
    }
  };

  const issueStudioCode = async () => {
    if (!session.csrfToken || !activeWorkspace || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const issued = await createWorkspaceShareCode(activeWorkspace.id, session.csrfToken, 'admin');
      setShareCode(issued.code);
      setWorkspaceMessage('single-use studio admin code ready for 15 minutes.');
    } catch {
      setWorkspaceMessage('could not create a studio admin code.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const redeemStudioCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canvasUnsaved.current) { setWorkspaceMessage('Save or retry the current canvas before changing workspaces.'); return; }
    if (!session.csrfToken || !redeemCode.trim() || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const granted = await redeemWorkspaceShareCode(redeemCode, session.csrfToken);
      setRedeemCode('');
      await refreshWorkspaces(granted.id);
      setWorkspaceMessage(`admin access granted to ${granted.name}.`);
    } catch {
      setWorkspaceMessage('that share code is invalid, expired, or already used.');
      setWorkspaceBusy(false);
    }
  };

  const issueAppLinkCode = async () => {
    if (!session.csrfToken || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const issued = await createAccountDeviceLinkCode(session.csrfToken);
      setAppLinkCode(issued.code);
      setWorkspaceMessage('single-use app link code ready for 15 minutes.');
    } catch {
      setWorkspaceMessage('could not create an app link code.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const revokeDevice = async (deviceId: string) => {
    if (!session.csrfToken || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      await revokeAccountDevice(deviceId, session.csrfToken);
      await refreshDevices();
      setWorkspaceMessage('app workspace access revoked.');
    } catch {
      setWorkspaceMessage('could not revoke that app.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const revokeMember = async (accountId: string) => {
    if (!session.csrfToken || !activeWorkspace || activeWorkspace.role !== 'owner' || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      await revokeWorkspaceMember(activeWorkspace.id, accountId, session.csrfToken);
      await refreshMembers();
      setWorkspaceMessage('workspace access revoked.');
    } catch {
      setWorkspaceMessage('could not revoke that workspace member.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const chooseMode = (nextMode: Exclude<AccessMode, null>) => {
    setMode(nextMode);
    setMessage('');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canvasUnsaved.current) { setMessage('Save or retry the current canvas before signing in.'); return; }
    if (!mode || busy) return;

    setBusy(true);
    setMessage('');

    try {
      if (!window.PublicKeyCredential || !navigator.credentials) {
        throw new Error('passkeys_unavailable');
      }

      if (mode === 'signup') {
        const options = await api<RegistrationOptions>('/api/auth/register/start', {
          handle: handle.trim(),
        });
        const publicKey: PublicKeyCredentialCreationOptions = {
          rp: options.publicKey.rp,
          user: {
            ...options.publicKey.user,
            id: bytesFromBase64url(options.publicKey.user.id),
          },
          challenge: bytesFromBase64url(options.publicKey.challenge),
          pubKeyCredParams: options.publicKey.pubKeyCredParams.map((parameter) => ({
            type: 'public-key',
            alg: parameter.alg,
          })),
          timeout: options.publicKey.timeout,
          excludeCredentials: options.publicKey.excludeCredentials?.map((item) => ({
            type: 'public-key',
            id: bytesFromBase64url(item.id),
          })),
          authenticatorSelection: options.publicKey.authenticatorSelection ? {
            authenticatorAttachment: options.publicKey.authenticatorSelection.authenticatorAttachment as AuthenticatorAttachment | undefined,
            requireResidentKey: options.publicKey.authenticatorSelection.requireResidentKey,
            residentKey: options.publicKey.authenticatorSelection.residentKey as ResidentKeyRequirement | undefined,
            userVerification: options.publicKey.authenticatorSelection.userVerification as UserVerificationRequirement | undefined,
          } : undefined,
          attestation: options.publicKey.attestation as AttestationConveyancePreference | undefined,
        };
        const credential = await navigator.credentials.create({
          publicKey,
        }) as PublicKeyCredential | null;
        if (!credential) throw new Error('passkey_cancelled');
        const next = await api<Session>('/api/auth/register/finish', {
          ceremonyId: options.ceremonyId,
          credential: registrationCredential(credential),
        });
        setSession({ ...next, source: 'account' });
      } else {
        const options = await api<LoginOptions>('/api/auth/login/start', {});
        const publicKey: PublicKeyCredentialRequestOptions = {
          challenge: bytesFromBase64url(options.publicKey.challenge),
          rpId: options.publicKey.rpId,
          timeout: options.publicKey.timeout,
          userVerification: options.publicKey.userVerification as UserVerificationRequirement | undefined,
          allowCredentials: options.publicKey.allowCredentials?.map((item) => ({
            type: 'public-key',
            id: bytesFromBase64url(item.id),
          })),
        };
        const credential = await navigator.credentials.get({
          publicKey,
        }) as PublicKeyCredential | null;
        if (!credential) throw new Error('passkey_cancelled');
        const next = await api<Session>('/api/auth/login/finish', {
          ceremonyId: options.ceremonyId,
          credential: loginCredential(credential),
        });
        setSession({ ...next, source: 'account' });
      }
      // Authentication changes identity, never the canvas the person is editing.
      setBrowserOnly(true);
      setMode(null);
      setProductSite(false);
      setAccountOpen(true);
    } catch {
      setMessage(
        mode === 'signup'
          ? 'could not sign up.'
          : 'could not log in.',
      );
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (canvasUnsaved.current) { setWorkspaceMessage('Save or retry the current canvas before logging out.'); return; }
    if (busy || !session.csrfToken) return;
    setBusy(true);
    setDeviceMessage('');
    try {
      await api('/api/auth/logout', {}, session.csrfToken);
      setSession({ authenticated: false });
      setMode(null);
      setAccountOpen(false);
      setWorkspaces([]);
      setActiveWorkspaceId('');
    } catch {
      setDeviceMessage('could not log out. try again.');
    } finally {
      setBusy(false);
    }
  };

  const switchCanvas = (local: boolean) => {
    if (canvasUnsaved.current) {
      setWorkspaceMessage('Save or retry the current canvas before changing workspaces.');
      return;
    }
    setBrowserOnly(local);
    setWorkspaceMessage('');
    setPanel(null);
    setAgentContextNodes([]);
  };

  if (ready && session.authenticated && !browserOnly && !productSite) {
    const accountName = session.handle ?? 'account';
    if (!canvasAccountReady || !canvasPersistence || (accountSync && (!activeWorkspace || workspaceBusy && !workspaces.length))) {
      return (
        <main className={styles.access} id="hii-main">
          <span className={styles.wordmark}>hii</span>
          <section className={styles.formPanel} aria-label="Account unavailable">
            <p className={styles.message} role="status">
              {accountSync && workspaceBusy
                ? 'opening your account-owned workspace.'
                : 'could not open this account.'}
            </p>
            <button type="button" onClick={() => window.location.reload()}>retry</button>
            <button type="button" onClick={() => switchCanvas(true)}>open browser-only canvas</button>
          </section>
        </main>
      );
    }
    return (
      <div className={styles.canvasShell}>
        {personalAccess && <a href="/personal/" data-workspace-ui style={{position:'absolute',right:20,top:18,zIndex:110,padding:'8px 14px',borderRadius:12,background:'var(--panel, #fff)',color:'var(--ink, #222)',fontSize:13,textDecoration:'none'}}>Personal chat</a>}
        <HiiRoot
          key={`${canvasAccountId}:${canvasSpaceId}`}
          surface="account"
          spaceId={canvasSpaceId}
          creatorId={`account:${canvasAccountId}`}
          persistence={canvasPersistence}
          onUnsavedChanges={setCanvasUnsaved}
          onSelectionChange={setSelectedCanvasNodes}
          allowPhoto
          allowLocalRuntime={session.source === 'local'}
          persistentChrome={false}
          fileSeeder={canvasFileSeeder}
          onRequestDevice={(selection) => { setAgentContextNodes(selection); setPanel('models'); }}
          onShareNode={(node) => { setAgentContextNodes([]); setShareNode(node); setPanel('feed'); }}
          canvasImportRequest={canvasImport}
          searchWorkspaces={searchWorkspaces}
          searchWorkspaceId={activeWorkspaceId}
          onFocusExternalNode={focusSearchResult}
          searchFocusNodeId={searchFocusNodeId}
          canvasManagerRequest={canvasManagerRequest}
        />
        <HiiCanvasFrame accountName={accountName} workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSelect={(id) => {
          if (canvasUnsaved.current) { setWorkspaceMessage('Save or retry the current canvas before changing workspaces.'); return; }
          setActiveWorkspaceId(id);
        }} onAccount={() => setAccountOpen((value) => !value)} onFindObjects={() => setCanvasManagerRequest((value) => value + 1)} />
        <header className={styles.canvasHeader} data-workspace-ui aria-label="HII account access">
          <nav aria-label="HII account actions">
            <button type="button" disabled={!selectedCanvasNodes.length} onClick={() => setComfyOpen(true)}>Create{selectedCanvasNodes.length ? ` · ${selectedCanvasNodes.length}` : ''}</button>
            <button
              type="button"
              aria-expanded={accountOpen}
              aria-controls="hii-web-account"
              onClick={() => setAccountOpen((value) => !value)}
            >
              {accountName}
            </button>
          </nav>
        </header>
        {comfyOpen ? <ComfyCreatePanel nodes={selectedCanvasNodes} onClose={() => setComfyOpen(false)} onOutput={(seed) => { setCanvasImport({ id: crypto.randomUUID(), seed }); setComfyOpen(false); }} /> : null}
        {panel ? <HiiWebPanel
          panel={panel}
          csrfToken={session.csrfToken ?? ''}
          shareNode={shareNode}
          contextNodes={agentContextNodes}
          onClose={() => { setPanel(null); setShareNode(null); setAgentContextNodes([]); }}
          onImport={(item: FeedItem) => {
            setCanvasImport({ id: crypto.randomUUID(), seed: nodeSeedFromFeedSnapshot(item) });
            setPanel(null);
            setShareNode(null);
            setAgentContextNodes([]);
          }}
          onPlaceResult={(text) => {
            setCanvasImport({ id: crypto.randomUUID(), seed: canvasTextSeed(text.slice(0, 100_000)) });
            setPanel(null);
            setAgentContextNodes([]);
          }}
        /> : null}
        {accountOpen ? (
          <aside id="hii-web-account" className={styles.accountPanel} data-workspace-ui aria-label="HII account">
            <dl>
              <div><dt>profile</dt><dd>{accountName}</dd></div>
              <div><dt>sign-in</dt><dd>passkey</dd></div>
              <div><dt>workspace</dt><dd>{accountSync ? 'synchronized to your account' : 'stored on this device'}</dd></div>
              <div><dt>computer</dt><dd>connected only when you allow it</dd></div>
            </dl>
            <button type="button" onClick={() => switchCanvas(true)}>open browser-only canvas</button>
            {accountSync ? <section className={styles.workspaceControls} aria-label="Your workspaces">
              <label>
                your workspaces
                <select value={activeWorkspaceId} onChange={(event) => {
                  if (canvasUnsaved.current) { setWorkspaceMessage('Save or retry the current canvas before changing workspaces.'); return; }
                  setActiveWorkspaceId(event.target.value);
                }}>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>
                    {workspace.name} · {workspace.role}
                  </option>)}
                </select>
              </label>
              <form onSubmit={createWorkspace}>
                <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="new workspace" maxLength={80} />
                <button type="submit" disabled={workspaceBusy || !workspaceName.trim()}>create</button>
              </form>
              {activeWorkspace?.role === 'owner' ? <button type="button" disabled={workspaceBusy} onClick={() => void issueStudioCode()}>
                invite a trusted operator
              </button> : null}
              {activeWorkspace?.role === 'owner' ? <small>A one-time code grants admin access to this workspace for onboarding and support.</small> : null}
              {shareCode ? <div>
                <code>{shareCode}</code>
                <button type="button" onClick={() => navigator.clipboard?.writeText(shareCode)}>copy once</button>
              </div> : null}
              {workspaceMembers.length ? <div>
                <small>workspace members</small>
                {workspaceMembers.map((member) => <span key={member.accountId}>
                  {member.handle} · {member.role}
                  {activeWorkspace?.role === 'owner' && member.role !== 'owner' ? <button
                    type="button"
                    disabled={workspaceBusy}
                    onClick={() => void revokeMember(member.accountId)}
                  >revoke</button> : null}
                </span>)}
              </div> : null}
              <form onSubmit={redeemStudioCode}>
                <input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value)} placeholder="enter a workspace code" maxLength={96} />
                <button type="submit" disabled={workspaceBusy || !redeemCode.trim()}>join</button>
              </form>
            </section> : null}
            {accountSync ? <section className={styles.deviceControls} aria-label="Connect HII on a computer" data-requested={cliLinkRequested || undefined}>
              <strong>{cliLinkRequested ? 'Finish connecting the HII CLI' : 'Connect HII on a computer'}</strong>
              <small>Create a one-time code, then paste it into the HII CLI or installed app. This does not grant browser terminal access.</small>
              <button type="button" disabled={workspaceBusy} onClick={() => void issueAppLinkCode()}>
                create a computer code
              </button>
              {appLinkCode ? <div>
                <code>{appLinkCode}</code>
                <button type="button" onClick={() => navigator.clipboard?.writeText(appLinkCode)}>copy once</button>
              </div> : null}
              {accountDevices.length ? <div>
                <small>connected HII apps</small>
                {accountDevices.map((device) => <span key={device.id}>
                  {device.name}
                  <button type="button" disabled={workspaceBusy} onClick={() => void revokeDevice(device.id)}>revoke</button>
                </span>)}
              </div> : null}
            </section> : null}
            <p role="status" aria-live="polite">{workspaceMessage}</p>
            <nav className={styles.platformLinks} aria-label="Open HII on a computer">
              <button type="button" onClick={() => { setAgentContextNodes([]); setPanel('models'); setAccountOpen(false); }}>HII Remote</button>
              <a href="/download#mac">HII for Mac</a>
              <a href="/download#windows">HII for Windows</a>
            </nav>
            <button type="button" onClick={signOut} disabled={busy}>log out</button>
            <p role="status" aria-live="polite">{deviceMessage}</p>
            <small>{accountSync ? 'Workspace objects synchronize through your account. Media bytes remain on the importing browser until private asset sync is enabled.' : 'Canvas media stays on this browser.'} Connected computers use a separate outbound, revocable link.</small>
          </aside>
        ) : null}
      </div>
    );
  }

  const authDialog = <>
        {mode ? <div className={styles.authBackdrop} onPointerDown={(event) => { if (event.target === event.currentTarget) setMode(null); }}>
          <section ref={authRef} className={styles.formPanel} role="dialog" aria-modal="true" aria-label={mode === 'login' ? 'Log in' : 'Create your HII'}>
            <header><span>hii / {mode === 'login' ? 'log in' : 'create your HII'}</span><button type="button" onClick={() => setMode(null)}>close</button></header>
            {oauthReturn ? <p className={styles.cliLinkNotice}>ChatGPT is waiting. Log in to review the exact HII access it requested.</p> : null}
            {!oauthReturn && cliLinkRequested ? <p className={styles.cliLinkNotice}>The HII CLI is waiting. Log in, then create a one-time computer code.</p> : null}
            <form onSubmit={submit}>
              {mode === 'signup' ? (
                <label>
                  name
                  <input
                    type="text"
                    name="handle"
                    autoComplete="username"
                    value={handle}
                    onChange={(event) => setHandle(event.target.value)}
                    minLength={3}
                    maxLength={48}
                    pattern="[-A-Za-z0-9._]+"
                    required
                  />
                </label>
              ) : null}
              <button type="submit" disabled={busy || (mode === 'signup' && handle.trim().length < 3)}>
                {busy ? 'working…' : 'continue'}
              </button>
            </form>
            {message ? <p className={styles.message} role="status">{message}</p> : null}
            <p className={styles.note}>{mode === 'login' ? 'Continue with your passkey.' : 'No password. Your public name identifies you on HII.'}</p>
            <nav className={styles.modeLinks} aria-label="Switch account action">
              <button type="button" aria-current={mode === 'login'} onClick={() => chooseMode('login')}>log in</button>
              <span aria-hidden="true">/</span>
              <button type="button" aria-current={mode === 'signup'} onClick={() => chooseMode('signup')}>create account</button>
            </nav>
          </section>
        </div> : null}
  </>;

  if (productSite) {
    return (
      <main className={styles.access} id="hii-main">
        <ProsumerLanding
          onLogin={() => session.authenticated ? setProductSite(false) : chooseMode('login')}
          onCreateAccount={() => session.authenticated ? setProductSite(false) : chooseMode('signup')}
        />
        {authDialog}
      </main>
    );
  }

  // Signing in keeps this browser-only document mounted. Account workspaces
  // are separate documents, opened explicitly; login never uploads this one.
  return (
    <div className={styles.canvasShell}>
      <HiiRoot
        key="guest"
        surface="account"
        spaceId=""
        creatorId="human:guest"
        persistence={guestPersistence}
        onUnsavedChanges={setCanvasUnsaved}
        allowPhoto
        allowLocalRuntime={session.source === 'local'}
        persistentChrome={false}
        canvasManagerRequest={canvasManagerRequest}
      />
      <HiiCanvasFrame accountName={session.authenticated ? session.handle ?? 'account' : 'hii'} workspaces={[]} activeWorkspaceId="" onAccount={() => setAccountOpen((value) => !value)} onFindObjects={() => setCanvasManagerRequest((value) => value + 1)} />
      <header className={styles.canvasHeader} data-workspace-ui aria-label="HII account access">
        <nav aria-label="HII account actions">
          <button
            type="button"
            aria-expanded={accountOpen}
            aria-controls="hii-web-account"
            onClick={() => setAccountOpen((value) => !value)}
          >
            {session.authenticated ? session.handle ?? 'account' : 'hii'}
          </button>
        </nav>
      </header>
      {accountOpen ? (
        <aside id="hii-web-account" className={styles.accountPanel} data-workspace-ui aria-label="HII account">
          <dl>
            <div><dt>profile</dt><dd>{session.authenticated ? session.handle ?? 'account' : 'not signed in'}</dd></div>
            <div><dt>sign-in</dt><dd>passkey</dd></div>
            <div><dt>workspace</dt><dd>stored on this browser</dd></div>
            <div><dt>computer</dt><dd>connected only when you allow it</dd></div>
          </dl>
          {session.authenticated ? <>
            <button type="button" onClick={() => switchCanvas(false)}>open account workspace</button>
            <button type="button" onClick={signOut} disabled={busy}>log out</button>
          </> : <>
            <button type="button" onClick={() => { chooseMode('login'); setAccountOpen(false); }}>log in</button>
            <button type="button" onClick={() => { chooseMode('signup'); setAccountOpen(false); }}>create your HII</button>
          </>}
          <small>This canvas stays in this browser. Account workspaces are separate; signing in does not upload or synchronize this canvas.</small>
          <p role="status" aria-live="polite">{workspaceMessage || deviceMessage}</p>
          <nav className={styles.platformLinks} aria-label="Open HII on a computer">
            <a href="/?site=1">what HII is</a>
            <a href="/download#mac">HII for Mac</a>
            <a href="/download#windows">HII for Windows</a>
            <a href="/docs">documentation</a>
          </nav>
        </aside>
      ) : null}
      {authDialog}
    </div>
  );
}

export default HiiWebAccess;
