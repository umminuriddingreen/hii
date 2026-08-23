'use client';

import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import {
  ECOSYSTEM_RESOURCE_KINDS,
  HII_PROJECTION_MIME,
  buildResourceProjection,
  ecosystemAccessState,
  ecosystemSyncPresentation,
  filterEcosystemResources,
  type EcosystemResource,
  type EcosystemResourceKind,
  type EcosystemSession,
  type EcosystemSyncState,
  type ProjectionIntent,
  type ResourceProjectionSeed
} from '@/lib/ecosystem/contracts';
import styles from './HiiAppShell.module.css';

export type HiiAppShellProps = {
  session: EcosystemSession;
  resources: readonly EcosystemResource[];
  sync: EcosystemSyncState;
  children: ReactNode;
  onSignInWithPasskey: () => void;
  passkeyAvailable?: boolean;
  onUseRecovery: () => void;
  onRecoverySubmit?: (recoveryCode: string) => void;
  onSignOut: () => void;
  onAddProjection: (projection: ResourceProjectionSeed, intent: ProjectionIntent) => void;
  onOpenResource?: (resource: EcosystemResource) => void;
  onInstallApp?: () => void;
};

const KIND_LABELS: Record<EcosystemResourceKind, string> = {
  device: 'Devices', agent: 'Agents', model: 'Models', capability: 'Capabilities', job: 'Jobs',
  file: 'Files', service: 'Services', space: 'Spaces', artifact: 'Artifacts', receipt: 'Receipts'
};

function AuthBoundary({
  session,
  onSignInWithPasskey,
  passkeyAvailable = true,
  onUseRecovery,
  onRecoverySubmit
}: Pick<HiiAppShellProps, 'session' | 'onSignInWithPasskey' | 'passkeyAvailable' | 'onUseRecovery' | 'onRecoverySubmit'>) {
  const access = ecosystemAccessState(session);
  const [code, setCode] = useState('');
  return (
    <main className={styles.authBoundary} data-auth-state={session.state}>
      <section className={styles.authCard}>
        <div className={styles.authMark} aria-hidden="true"><span /><span /><span /></div>
        <p className={styles.eyebrow}>Human Information Interface</p>
        <h1>{access.label}</h1>
        {session.state === 'passkey-pending' ? (
          <>
            <p>Confirm with your passkey on this device. HII will never ask for the passkey itself.</p>
            <div className={styles.waitingLine}><i /> Secure confirmation open</div>
            <button className={styles.textButton} type="button" onClick={onUseRecovery}>Use recovery kit instead</button>
          </>
        ) : session.state === 'recovery' ? (
          <form onSubmit={(event) => { event.preventDefault(); if (code.trim()) onRecoverySubmit?.(code.trim()); }}>
            <p>{session.message || 'Use one code from your offline HII recovery kit.'}</p>
            <label htmlFor="hii-recovery-code">Recovery code</label>
            <input id="hii-recovery-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" />
            <button className={styles.primaryButton} type="submit" disabled={!code.trim() || !onRecoverySubmit}>Recover HII</button>
            <button className={styles.textButton} type="button" onClick={onSignInWithPasskey}>Back to passkey</button>
          </form>
        ) : (
          <>
            <p>Your machines, agents, work, and Spaces stay behind your owner identity.</p>
            <button className={styles.primaryButton} type="button" onClick={onSignInWithPasskey} disabled={!passkeyAvailable}>
              {passkeyAvailable ? 'Continue with passkey' : 'Passkey sign-in not connected'}
            </button>
            <button className={styles.textButton} type="button" onClick={onUseRecovery}>Use recovery kit</button>
          </>
        )}
        <footer>Private by default · No Supabase · Authority stays with HII</footer>
      </section>
    </main>
  );
}

function ResourceGlyph({ kind }: { kind: EcosystemResourceKind }) {
  return <span className={styles.resourceGlyph} data-kind={kind} aria-hidden="true">{kind.slice(0, 2).toUpperCase()}</span>;
}

function ResourceCard({
  resource,
  onAddProjection,
  onOpenResource
}: {
  resource: EcosystemResource;
  onAddProjection: HiiAppShellProps['onAddProjection'];
  onOpenResource?: HiiAppShellProps['onOpenResource'];
}) {
  const projection = useMemo(() => buildResourceProjection(resource), [resource]);
  function startDrag(event: DragEvent<HTMLElement>) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(HII_PROJECTION_MIME, JSON.stringify(projection));
    event.dataTransfer.setData('text/plain', resource.name);
  }
  function finishDrag(event: DragEvent<HTMLElement>) {
    if (event.dataTransfer.dropEffect === 'none') return;
    onAddProjection(projection, { source: 'drag', clientX: event.clientX, clientY: event.clientY });
  }
  return (
    <article className={styles.resourceCard} draggable onDragStart={startDrag} onDragEnd={finishDrag} data-status={resource.status}>
      <button className={styles.resourceOpen} type="button" onClick={() => onOpenResource?.(resource)} disabled={!onOpenResource}>
        <ResourceGlyph kind={resource.kind} />
        <span><strong>{resource.name}</strong><small>{resource.detail || KIND_LABELS[resource.kind]}</small></span>
        <i aria-label={resource.status} />
      </button>
      <button
        className={styles.addButton}
        type="button"
        aria-label={`Add ${resource.name} to canvas`}
        onClick={() => onAddProjection(projection, { source: 'add-button' })}
      >+</button>
    </article>
  );
}

function ResourceLibrary({
  resources,
  onAddProjection,
  onOpenResource,
  compact = false
}: Pick<HiiAppShellProps, 'resources' | 'onAddProjection' | 'onOpenResource'> & { compact?: boolean }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<EcosystemResourceKind | 'all'>('all');
  const filtered = useMemo(() => filterEcosystemResources(resources, query, kind), [resources, query, kind]);
  return (
    <section className={styles.library} data-compact={compact || undefined} aria-label="HII ecosystem library">
      <header>
        <span><b>Ecosystem</b><small>{resources.length} live objects</small></span>
        <kbd>drag → canvas</kbd>
      </header>
      <label className={styles.search}>
        <span aria-hidden="true">⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find anything in HII" aria-label="Search ecosystem" />
      </label>
      <nav className={styles.kindRail} aria-label="Filter ecosystem resources">
        <button type="button" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>All</button>
        {ECOSYSTEM_RESOURCE_KINDS.map((item) => (
          <button type="button" key={item} aria-pressed={kind === item} onClick={() => setKind(item)}>{KIND_LABELS[item]}</button>
        ))}
      </nav>
      <div className={styles.resourceList}>
        {filtered.map((resource) => <ResourceCard key={`${resource.kind}:${resource.id}`} resource={resource} onAddProjection={onAddProjection} onOpenResource={onOpenResource} />)}
        {!filtered.length && <p className={styles.empty}>Nothing matches. Try a machine name, capability, or Space.</p>}
      </div>
    </section>
  );
}

export function HiiAppShell(props: HiiAppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const syncView = ecosystemSyncPresentation(props.sync);
  if (props.session.state !== 'authenticated') return <AuthBoundary {...props} />;
  const { owner } = props.session;
  return (
    <main className={styles.shell} data-connectivity={props.sync.connectivity}>
      <div className={styles.canvasStage}>{props.children}</div>
      <header className={styles.topbar}>
        <div className={styles.wordmark}><b>HII</b><span>your information surface</span></div>
        <div className={styles.nodeConstellation} aria-label={`${props.sync.onlineNodes} of ${props.sync.totalNodes} nodes online`}>
          {Array.from({ length: Math.min(props.sync.totalNodes, 5) }, (_, index) => <i key={index} data-online={index < props.sync.onlineNodes || undefined} />)}
          <span>{props.sync.onlineNodes}/{props.sync.totalNodes} nodes</span>
        </div>
        <button className={styles.ownerButton} type="button" onClick={props.onSignOut} title="Sign out">
          <span>{owner.displayName.slice(0, 1).toUpperCase()}</span>
          <b>{owner.displayName}</b>
          <small>{owner.deviceName || 'trusted device'}</small>
        </button>
      </header>
      <aside className={styles.desktopLibrary}><ResourceLibrary {...props} /></aside>
      <aside className={styles.syncCard} data-tone={syncView.tone}>
        <i aria-hidden="true" />
        <span><b>{syncView.label}</b><small>{syncView.detail}</small></span>
        {props.onInstallApp && <button type="button" onClick={props.onInstallApp}>Install</button>}
      </aside>
      <button className={styles.mobileTrigger} type="button" aria-expanded={mobileOpen} onClick={() => setMobileOpen((open) => !open)}>
        <span className={styles.triggerConstellation} aria-hidden="true"><i /><i /><i /></span>
        <b>{mobileOpen ? 'Close ecosystem' : 'Open ecosystem'}</b>
        <small>{props.sync.pendingOperations ? `${props.sync.pendingOperations} pending` : `${props.resources.length} objects`}</small>
      </button>
      {mobileOpen && (
        <div className={styles.mobileScrim} onPointerDown={(event) => { if (event.target === event.currentTarget) setMobileOpen(false); }}>
          <aside className={styles.mobileSheet}><div className={styles.sheetHandle} /><ResourceLibrary {...props} compact /></aside>
        </div>
      )}
    </main>
  );
}

export default HiiAppShell;
