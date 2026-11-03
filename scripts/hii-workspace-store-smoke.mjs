import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'hii-workspace-store-'));
process.env.HII_RUNTIME_DIR = directory;

try {
  const { atomicWriteFile } = await import('../lib/server/atomic-write.ts');
  const workspaceDir = path.join(directory, 'workspace');
  const workspacePath = path.join(workspaceDir, 'workspace.json');
  await mkdir(workspaceDir, { recursive: true });
  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      atomicWriteFile(workspacePath, `${JSON.stringify({ version: 1, writer: index })}\n`)
    )
  );

  const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
  assert.equal(workspace.version, 1);
  assert.ok(workspace.writer >= 0 && workspace.writer < 24);

  const files = await readdir(workspaceDir);
  assert.deepEqual(files, ['workspace.json']);
  console.log(JSON.stringify({
    ok: true,
    store: workspacePath,
    checks: ['concurrent atomic writes', 'valid final document', 'temporary-file cleanup']
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
