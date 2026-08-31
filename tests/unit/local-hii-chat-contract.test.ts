import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('local HII chat contract', () => {
  const ui = readFileSync('components/remote/LocalHiiChat.tsx', 'utf8');
  const host = readFileSync('remote/host/hii-remote-host.mjs', 'utf8');
  const relay = readFileSync('workers/public-site/src/remote.rs', 'utf8');
  const installer = readFileSync('public/hii-chat/install.sh', 'utf8');
  const updater = readFileSync('remote/host/update.sh', 'utf8');

  it('unlocks only against an online account-owned host', () => {
    expect(ui).toContain("fetch('/api/remote/hosts'");
    expect(ui).toContain('/api/remote/chat?host=');
    expect(ui).toContain('download / connect HII Chat');
    expect(ui).toContain('No paired hardware means no hidden local access');
    expect(relay).toContain('SELECT id FROM remote_hosts WHERE id = ?1 AND account_id = ?2');
  });

  it('runs bounded direct answers through the local HII CLI', () => {
    expect(host).toContain("'ask', '--jsonl', transcript");
    expect(host).toContain("'--deadline', '120s'");
    expect(host).toContain("'--token-budget', '4096'");
    expect(host).toContain("t: 'chat.delta'");
    expect(host).not.toContain('shell: true');
  });

  it('ships a public checksum-verified installer and recurring updater', () => {
    expect(installer).toContain('humaninformationinterface.com/hii-chat/files/update.sh');
    expect(installer).toContain("read -r token < /dev/tty");
    expect(updater).toContain('shasum -a 256');
    expect(updater).toContain('manifest.json');
    expect(updater).toContain('HII_PAIR_TOKEN');
  });
});
