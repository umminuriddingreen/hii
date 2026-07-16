import { randomUUID } from 'crypto';
import { rename, rm, writeFile } from 'fs/promises';

export async function atomicWriteFile(file: string, content: string) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
