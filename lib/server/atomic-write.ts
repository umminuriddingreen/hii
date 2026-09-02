import { randomUUID } from 'crypto';
import { open, rename, rm, stat, writeFile } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';

export async function atomicWriteFile(file: string, content: string) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await replace(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Rename over an existing file, tolerating Windows' briefly-locked destinations.
 *
 * POSIX `rename(2)` replaces the destination atomically even while another
 * process holds it open. Windows refuses with EPERM/EACCES/EBUSY whenever
 * anything -- a virus scanner, an indexer, a concurrent reader -- has a handle
 * on the target, and those holds are typically over in milliseconds. Retrying
 * keeps the write atomic in the case that matters (a crash never leaves a
 * partial file, because the content is fully written before the rename), while
 * unlinking first on the last attempt covers the case where the destination
 * itself is what cannot be overwritten.
 */
async function replace(temporary: string, file: string) {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!transient.has(code) || attempt >= 10) throw error;
      // The destination is held, not missing. On the final attempts drop it
      // first; a reader that loses the file is recoverable, a failed save is not.
      if (attempt >= 7) await rm(file, { force: true }).catch(() => {});
      await delay(20 * (attempt + 1));
    }
  }
}

export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  let handle;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30_000) {
        await rm(lockPath, { force: true });
        continue;
      }
      await delay(25);
    }
  }
  if (!handle) throw new Error('workspace save lock timed out');
  try {
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
