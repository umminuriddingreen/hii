import { getKnowledgeNote, knowledgeWorkspace } from '@/lib/server/hii-knowledge';

export const load = () => {
  const workspace = knowledgeWorkspace();
  const first = workspace.notes[0];
  return JSON.parse(JSON.stringify({ workspace, note: first ? getKnowledgeNote(first.id) : null }));
};
