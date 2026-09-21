import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeTestTree } from './lib/test-temp.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'hii-window-state-'));
process.env.HII_RUNTIME_DIR = directory;

try {
  const {
    WindowStateConflictError,
    closeWindowState,
    getWindowState,
    listWindowStates,
    upsertWindowState,
    windowStateStorePath
  } = await import('../lib/server/hii-window-state.ts');

  const first = await upsertWindowState({
    id: 'window:one',
    workspaceId: 'main',
    route: '/knowledge',
    scroll: { y: 640 },
    viewport: { x: 20, y: 40, zoom: 1.2 },
    baseRevision: 0
  });
  await upsertWindowState({ id: 'window:two', workspaceId: 'main', route: '/terminal', baseRevision: 0 });
  await upsertWindowState({ id: 'window:three', workspaceId: 'main', route: '/board', baseRevision: 0 });

  assert.equal(first.revision, 1);
  assert.equal(first.scroll.y, 640);
  assert.equal(windowStateStorePath(), path.join(directory, 'hii.db'));

  const firstPage = await listWindowStates({ workspaceId: 'main', limit: 2 });
  assert.equal(firstPage.windows.length, 2);
  assert.equal(firstPage.page.total, 3);
  assert.equal(firstPage.page.hasMore, true);
  assert.ok(firstPage.page.nextCursor);

  const secondPage = await listWindowStates({
    workspaceId: 'main',
    limit: 2,
    cursor: firstPage.page.nextCursor ?? undefined
  });
  assert.equal(secondPage.windows.length, 1);
  assert.equal(new Set([...firstPage.windows, ...secondPage.windows].map((window) => window.id)).size, 3);

  const updated = await upsertWindowState({
    id: first.id,
    scroll: { x: 12, y: 1280 },
    baseRevision: first.revision
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.scroll, { x: 12, y: 1280 });

  await assert.rejects(
    () => upsertWindowState({ id: first.id, scroll: { y: 1 }, baseRevision: first.revision }),
    WindowStateConflictError
  );

  const closed = await closeWindowState(first.id, updated.revision);
  assert.equal(closed.status, 'closed');
  assert.equal(await getWindowState(first.id).then((window) => window?.status), 'closed');
  assert.equal((await listWindowStates({ workspaceId: 'main' })).page.total, 2);
  assert.equal((await listWindowStates({ workspaceId: 'main', includeClosed: true })).page.total, 3);

  console.log(JSON.stringify({
    ok: true,
    store: windowStateStorePath(),
    checks: ['sqlite persistence', 'audit history', 'cursor pagination', 'scroll restore', 'revision conflict', 'close filtering']
  }, null, 2));
} finally {
  await removeTestTree(directory);
}
