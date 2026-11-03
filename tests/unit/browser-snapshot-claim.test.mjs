import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

describe('browser snapshot ID reservation', () => {
  it('claims a unique account snapshot before any blob write', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY); CREATE TABLE chat_devices(id TEXT PRIMARY KEY);');
      const migrations = 'workers/public-site/migrations';
      const name = (await readdir(migrations)).find((file) => file.endsWith('_browser_snapshots.sql'));
      expect(name).toBeTruthy();
      db.exec(await readFile(`${migrations}/${name}`, 'utf8'));
      db.prepare('INSERT INTO accounts(id) VALUES (?)').run('account');
      db.prepare('INSERT INTO chat_devices(id) VALUES (?)').run('device');
      const claim = db.prepare('INSERT OR IGNORE INTO browser_snapshots(id,account_id,source_id,sender_device_id,bytes_used,created_at) VALUES (?1,?2,?3,?4,?5,?6)');
      expect(claim.run('snapshot', 'account', 'source', 'device', 100, 1).changes).toBe(1);
      expect(claim.run('snapshot', 'account', 'source', 'device', 100, 1).changes).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM browser_snapshots').get().count).toBe(1);
    } finally { db.close(); }
  });
});
