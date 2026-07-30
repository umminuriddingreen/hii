import { contactSheetItemSeed, normalizeContactSheetSelection } from './contact-sheet.ts';
import { makeNode } from './ingest.ts';
import { findOpenWorkspacePosition } from './layout.ts';
import { organizeWorkspaceSelection } from './organize.ts';
import { workspaceScenes } from './scenes.ts';
import type { WorkspaceDoc, WorkspaceNode } from './types.ts';

export type ContactSheetReviewSceneResult = {
  created: boolean;
  doc: WorkspaceDoc;
  scene: WorkspaceNode;
  memberIds: string[];
};

const MEMBER_WIDTH = 280;
const MEMBER_HEIGHT = 180;
const MEMBER_GAP = 24;

function safeText(value: unknown, max = 160) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, max);
}

function selectedReviewItems(sheet: WorkspaceNode) {
  return normalizeContactSheetSelection(
    sheet.payload.items,
    sheet.payload.selectedItems,
    sheet.payload.itemLabels
  );
}

function reviewSetTitle(items: ReturnType<typeof selectedReviewItems>) {
  const labels = [...new Set(items.map((item) => safeText(item.label)).filter(Boolean))];
  if (labels.length === 1) return labels[0];
  if (labels.length > 1) return labels.slice(0, 2).join(' + ');
  return `Reference set · ${items[0]?.name || 'selected references'}`;
}

function reviewSetSignature(sheetId: string, title: string, hashes: string[]) {
  return `${sheetId}:${safeText(title).toLocaleLowerCase()}:${[...hashes].sort().join(',')}`;
}

export function organizeContactSheetReviewSet(
  doc: WorkspaceDoc,
  sheet: WorkspaceNode,
  options: { sceneId?: string; title?: string; now?: string } = {}
): ContactSheetReviewSceneResult | null {
  const items = selectedReviewItems(sheet);
  if (sheet.payload.adapter !== 'contact-sheet' || items.length < 2) return null;

  const title = safeText(options.title) || reviewSetTitle(items);
  const hashes = items.map((item) => item.sha256);
  const signature = reviewSetSignature(sheet.id, title, hashes);
  const existing = workspaceScenes(doc.nodes).find((scene) =>
    scene.payload.adapter === 'contact-sheet-review-scene'
    && scene.payload.reviewSetSignature === signature
  );
  if (existing) {
    return {
      created: false,
      doc,
      scene: existing,
      memberIds: doc.nodes.filter((node) => node.frameId === existing.id).map((node) => node.id)
    };
  }

  if (doc.nodes.length + items.length + 1 > 500) {
    throw new Error('This review set would exceed the 500-object workspace bound.');
  }

  const sceneId = safeText(options.sceneId, 64) || crypto.randomUUID();
  if (doc.nodes.some((node) => node.id === sceneId)) throw new Error('Scene id already exists.');
  const columns = Math.min(3, items.length);
  const rows = Math.ceil(items.length / columns);
  const groupSize = {
    w: columns * MEMBER_WIDTH + Math.max(0, columns - 1) * MEMBER_GAP,
    h: rows * MEMBER_HEIGHT + Math.max(0, rows - 1) * MEMBER_GAP
  };
  const origin = findOpenWorkspacePosition(
    doc.nodes,
    { x: sheet.x + sheet.w + 48, y: sheet.y },
    groupSize
  );
  let nextZ = doc.nextZ;
  const members = items.map((item, index) => {
    const seed = contactSheetItemSeed(item, sheet.id, item.label);
    const member = makeNode(
      {
        ...seed,
        w: MEMBER_WIDTH,
        h: MEMBER_HEIGHT,
        payload: {
          ...seed.payload,
          adapter: 'contact-sheet-review-item',
          title: item.name,
          ...(item.label ? {
            label: item.label,
            description: `Human classification: ${item.label}`
          } : {}),
          reviewSceneId: sceneId,
          reviewSetSignature: signature
        }
      },
      origin.x + (index % columns) * (MEMBER_WIDTH + MEMBER_GAP),
      origin.y + Math.floor(index / columns) * (MEMBER_HEIGHT + MEMBER_GAP),
      ++nextZ
    );
    return member;
  });
  const withMembers: WorkspaceDoc = {
    ...doc,
    nextZ,
    nodes: [...doc.nodes, ...members]
  };
  const organized = organizeWorkspaceSelection(withMembers, members.map((node) => node.id), {
    sceneId,
    title,
    now: options.now
  });
  if (!organized) return null;

  const now = organized.scene.updatedAt;
  const proofRefs = hashes.map((hash) => `sha256:${hash}`);
  const scene: WorkspaceNode = {
    ...organized.scene,
    object: {
      ...organized.scene.object,
      kind: 'scene',
      owner: 'human',
      status: 'ready',
      source: 'HII contact-sheet review set',
      capabilityId: 'hii.workspace.creative_canvas',
      parentId: sheet.id,
      proofRefs,
      audit: [
        ...(organized.scene.object?.audit ?? []),
        {
          ts: now,
          actor: 'human' as const,
          action: 'organized contact-sheet classification into scene',
          note: `${items.length} exact source-linked references · ${title}`
        }
      ].slice(-20)
    },
    payload: {
      ...organized.scene.payload,
      adapter: 'contact-sheet-review-scene',
      membership: 'contact-sheet-selection',
      sourceContactSheetId: sheet.id,
      sourceHashes: hashes,
      reviewSetSignature: signature
    }
  };
  return {
    created: true,
    scene,
    memberIds: members.map((node) => node.id),
    doc: {
      ...organized.doc,
      nodes: organized.doc.nodes.map((node) => node.id === scene.id ? scene : node)
    }
  };
}
