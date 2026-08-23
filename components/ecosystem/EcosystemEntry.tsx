'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { HiiRoot, type WorkspaceProjectionRequest } from '@/components/workspace/HiiRoot';
import type {
  EcosystemResource,
  EcosystemSession,
  EcosystemSyncState,
  ProjectionIntent,
  ResourceProjectionSeed
} from '@/lib/ecosystem/contracts';
import { HiiAppShell } from './HiiAppShell';
import { HiiStartup } from './HiiStartup';
import { ecosystemSessionForEnvironment } from './local-session';
import { loadRuntimeCatalog } from './runtime-catalog';

const EMPTY_RESOURCES: readonly EcosystemResource[] = Object.freeze([]);

const LOCAL_ONLY_SYNC: EcosystemSyncState = {
  connectivity: 'offline',
  phase: 'pending',
  offlineWriter: true,
  pendingOperations: 0,
  onlineNodes: 1,
  totalNodes: 1
};

export type EcosystemEntryProps = {
  /** A future authenticated endpoint may inject a verified session here. */
  session?: EcosystemSession;
  /** Empty until a CLI-owned runtime resource adapter is connected. */
  resources?: readonly EcosystemResource[];
  sync?: EcosystemSyncState;
};

export function EcosystemEntry({
  session: injectedSession,
  resources: injectedResources,
  sync = LOCAL_ONLY_SYNC
}: EcosystemEntryProps = {}) {
  const [session, setSession] = useState<EcosystemSession>(injectedSession || { state: 'signed-out' });
  const [localSession, setLocalSession] = useState<EcosystemSession>({ state: 'signed-out' });
  const [projectionRequest, setProjectionRequest] = useState<WorkspaceProjectionRequest | null>(null);
  const [runtimeResources, setRuntimeResources] = useState<readonly EcosystemResource[]>(EMPTY_RESOURCES);
  const [sessionReady, setSessionReady] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [startupVisible, setStartupVisible] = useState(true);

  useEffect(() => {
    if (injectedSession) {
      setSession(injectedSession);
      return;
    }
    const resolved = ecosystemSessionForEnvironment({
      hostname: window.location.hostname,
      isTauri: '__TAURI_INTERNALS__' in window
    });
    setLocalSession(resolved);
    setSession(resolved);
    setSessionReady(true);
  }, [injectedSession]);

  useEffect(() => {
    if (injectedSession) setSessionReady(true);
  }, [injectedSession]);

  useEffect(() => {
    if (injectedResources) {
      setRuntimeResources(injectedResources);
      setCatalogReady(true);
      return;
    }
    let active = true;
    loadRuntimeCatalog()
      .then((catalog) => {
        if (active) setRuntimeResources(catalog.resources);
      })
      .catch(() => {
        if (active) setRuntimeResources(EMPTY_RESOURCES);
      })
      .finally(() => { if (active) setCatalogReady(true); });
    return () => { active = false; };
  }, [injectedResources]);

  useEffect(() => {
    if (!sessionReady || !catalogReady) return;
    const timer = window.setTimeout(() => setStartupVisible(false), 650);
    return () => window.clearTimeout(timer);
  }, [catalogReady, sessionReady]);

  const addProjection = useCallback((projection: ResourceProjectionSeed, intent: ProjectionIntent) => {
    setProjectionRequest({ id: crypto.randomUUID(), projection, intent });
  }, []);

  const effectiveSync = useMemo<EcosystemSyncState>(() => {
    if (injectedSession || localSession.state === 'authenticated') return sync;
    return { ...LOCAL_ONLY_SYNC, offlineWriter: false, onlineNodes: 0, totalNodes: 0 };
  }, [injectedSession, localSession.state, sync]);

  if (startupVisible) {
    return <HiiStartup sessionReady={sessionReady} catalogReady={catalogReady} />;
  }

  return (
    <HiiAppShell
      session={session}
      resources={runtimeResources}
      sync={effectiveSync}
      passkeyAvailable={Boolean(injectedSession)}
      onSignInWithPasskey={() => setSession({ state: 'passkey-pending' })}
      onUseRecovery={() => setSession({ state: 'recovery', message: 'Recovery is not connected on this web surface yet.' })}
      onSignOut={() => setSession({ state: 'signed-out' })}
      onAddProjection={addProjection}
    >
      <HiiRoot projectionRequest={projectionRequest} />
    </HiiAppShell>
  );
}

export default EcosystemEntry;
