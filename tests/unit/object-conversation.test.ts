import { describe, expect, it } from 'vitest';
import {
  appendObjectConversationTurn,
  finishObjectConversationTurn,
  objectConversationTurns
} from '../../lib/workspace/object-conversation';

const human = {
  id: 'turn-human',
  conversationId: 'conversation-a',
  at: '2026-08-18T20:00:00.000Z',
  role: 'human' as const,
  text: 'What does this object imply?',
  status: 'running' as const,
  runId: 'run-a'
};

describe('object conversation timeline', () => {
  it('keeps turns linked to a durable conversation and filters another thread', () => {
    const timeline = appendObjectConversationTurn({}, human);
    const payload = {
      conversationTimeline: [...timeline, { ...human, id: 'turn-b', conversationId: 'conversation-b' }]
    };
    expect(objectConversationTurns(payload, 'conversation-a')).toEqual([human]);
  });

  it('finishes the source turn without changing its identity or text', () => {
    const payload = { conversationTimeline: [human] };
    expect(finishObjectConversationTurn(payload, human.id, 'completed')).toEqual([
      { ...human, status: 'completed' }
    ]);
  });

  it('drops malformed timeline records instead of inventing provenance', () => {
    expect(objectConversationTurns({ conversationTimeline: [{ text: 'orphan' }, null] })).toEqual([]);
  });
});
