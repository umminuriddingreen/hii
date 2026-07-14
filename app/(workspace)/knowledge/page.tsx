import { getKnowledgeNote, knowledgeWorkspace } from '@/lib/server/hii-knowledge';
import { KnowledgeWorkspace } from './KnowledgeWorkspace';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  const workspace = knowledgeWorkspace();
  const first = workspace.notes[0];
  const note = first ? getKnowledgeNote(first.id) : null;
  // node:sqlite returns row objects with null prototypes. Normalize once at the
  // server/client boundary so React receives a transport-safe snapshot.
  const initial = JSON.parse(JSON.stringify({ workspace, note })) as {
    workspace: typeof workspace;
    note: typeof note;
  };
  return <KnowledgeWorkspace initialWorkspace={initial.workspace} initialNote={initial.note} />;
}
