import { describe, expect, it } from 'vitest';
import { boardPatchForRunState, boardRunSyncKey } from '../../lib/workspace/board-run';

describe('HII board run synchronization', () => {
  it('uses the same key before and after an empty receipt is materialized', () => {
    const prepared = boardRunSyncKey({
      status: 'waiting_approval',
      runId: 'run-one'
    });
    const persisted = boardRunSyncKey({
      status: 'waiting_approval',
      runId: 'run-one',
      receiptRef: ''
    });

    expect(prepared).toBe('waiting_approval:run-one:');
    expect(persisted).toBe(prepared);
  });

  it('rejects unknown or unlinked run states', () => {
    expect(boardRunSyncKey({ status: 'mystery', runId: 'run-one' })).toBe('');
    expect(boardRunSyncKey({ status: 'running', runId: '' })).toBe('');
  });

  it('maps lifecycle states to their governed board lanes', () => {
    expect(boardPatchForRunState({
      status: 'waiting_approval',
      runId: 'run-one',
      currentLane: 'blocked'
    })).toEqual({
      runId: 'run-one',
      runStatus: 'waiting_approval',
      lane: 'next'
    });
    expect(boardPatchForRunState({ status: 'queued', runId: 'run-one' }).lane).toBe('doing');
    expect(boardPatchForRunState({ status: 'running', runId: 'run-one' }).lane).toBe('doing');
    expect(boardPatchForRunState({ status: 'failed', runId: 'run-one' }).lane).toBe('blocked');
    expect(boardPatchForRunState({ status: 'cancelled', runId: 'run-one' }).lane).toBe('blocked');
    expect(boardPatchForRunState({
      status: 'completed',
      runId: 'run-one',
      receiptRef: '/tmp/receipt.json'
    })).toEqual({
      runId: 'run-one',
      runStatus: 'completed',
      lane: 'done',
      receiptRef: '/tmp/receipt.json'
    });
  });

  it('does not let a completion claim exist without a receipt', () => {
    expect(() => boardPatchForRunState({
      status: 'completed',
      runId: 'run-one'
    })).toThrow('A completed board run requires a receipt reference.');
  });
});
