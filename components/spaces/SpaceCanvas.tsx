'use client';

import { useEffect, useMemo, useState } from 'react';
import { HiiRoot } from '@/components/workspace/HiiRoot';
import type { WorkspacePersistence } from '@/components/workspace/useWorkspace';
import { emptyWorkspace, normalizeWorkspace } from '@/lib/workspace/types';
import type { WorkspaceDoc } from '@/lib/workspace/types';
import { spaceIdFromPathname, spaceStorageKey } from './space-surface';
import { useSpaceTransport } from './useSpaceTransport';

export function browserSpacePersistence(spaceId: string, hydrate?: (document: WorkspaceDoc) => Promise<WorkspaceDoc>): WorkspacePersistence {
  const key = spaceStorageKey(spaceId);
  return {
    async read() {
      let document: WorkspaceDoc;
      try {
        document = normalizeWorkspace(JSON.parse(localStorage.getItem(key) || 'null'));
      } catch {
        document = emptyWorkspace();
      }
      return hydrate ? await hydrate(document) : document;
    },
    async write(document) {
      const saved = { ...document, revision: document.revision + 1 };
      localStorage.setItem(key, JSON.stringify(saved));
      return saved;
    }
  };
}

export function SpaceCanvas({ spaceId }: { spaceId: string }) {
  const { participantId, persistence } = useSpaceTransport(spaceId);
  return <HiiRoot surface="space" spaceId={spaceId} creatorId={participantId} persistence={persistence} />;
}

export function HiiEntry() {
  const [spaceId, setSpaceId] = useState<string | null | undefined>(undefined);
  useEffect(() => setSpaceId(spaceIdFromPathname(window.location.pathname)), []);
  if (spaceId === undefined) return <main className="hii-entry-loading" aria-label="Opening HII" />;
  return spaceId ? <SpaceCanvas spaceId={spaceId} /> : <HiiRoot />;
}
