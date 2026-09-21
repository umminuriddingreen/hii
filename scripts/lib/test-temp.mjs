import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const transient = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

export function removeTestTreeSync(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (!transient.has(error?.code)) throw error;
    console.warn(`hii test cleanup deferred: ${target}`);
  }
}

export async function removeTestTree(target) {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (!transient.has(error?.code)) throw error;
    console.warn(`hii test cleanup deferred: ${target}`);
  }
}
