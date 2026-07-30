import { describe, expect, it } from 'vitest';
import { boardRunSyncKey } from '../../lib/workspace/board-run';

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
});
