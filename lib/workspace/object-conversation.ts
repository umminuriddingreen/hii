export type ObjectConversationTurn = {
  id: string;
  conversationId: string;
  at: string;
  role: 'human' | 'assistant';
  text: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  runId?: string;
  receiptPath?: string;
};

const MAX_TURNS = 80;
const MAX_TEXT = 8_000;

function clean(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function objectConversationTurns(payload: Record<string, unknown>, conversationId?: string) {
  if (!Array.isArray(payload.conversationTimeline)) return [];
  return payload.conversationTimeline
    .map((raw): ObjectConversationTurn | null => {
      if (!raw || typeof raw !== 'object') return null;
      const turn = raw as Record<string, unknown>;
      const id = clean(turn.id, 100);
      const linkedConversation = clean(turn.conversationId, 100);
      const at = clean(turn.at, 64);
      const text = clean(turn.text, MAX_TEXT);
      if (!id || !linkedConversation || !at || !text) return null;
      if (turn.role !== 'human' && turn.role !== 'assistant') return null;
      if (!['running', 'completed', 'failed', 'cancelled'].includes(String(turn.status))) return null;
      return {
        id,
        conversationId: linkedConversation,
        at,
        role: turn.role,
        text,
        status: turn.status as ObjectConversationTurn['status'],
        runId: clean(turn.runId, 160) || undefined,
        receiptPath: clean(turn.receiptPath, 500) || undefined
      };
    })
    .filter((turn): turn is ObjectConversationTurn => Boolean(turn))
    .filter((turn) => !conversationId || turn.conversationId === conversationId)
    .slice(-MAX_TURNS);
}

export function appendObjectConversationTurn(payload: Record<string, unknown>, turn: ObjectConversationTurn) {
  return [...objectConversationTurns(payload), turn].slice(-MAX_TURNS);
}

export function finishObjectConversationTurn(
  payload: Record<string, unknown>,
  id: string,
  status: ObjectConversationTurn['status']
) {
  return objectConversationTurns(payload).map((turn) => turn.id === id ? { ...turn, status } : turn);
}
