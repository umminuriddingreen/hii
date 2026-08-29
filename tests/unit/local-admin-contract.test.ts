import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('local HII admin portal', () => {
  it('is desktop-only and reads CLI-owned state through Tauri', () => {
    const page = readFileSync('app/admin/page.tsx', 'utf8');
    const bridge = readFileSync('lib/client/admin-bridge.ts', 'utf8');
    expect(page).toContain("NEXT_PUBLIC_HII_TARGET !== 'desktop'");
    expect(page).toContain('notFound()');
    expect(bridge).toContain("'__TAURI_INTERNALS__' in window");
    expect(bridge).toContain("invoke<AdminSnapshot>('admin_snapshot')");
    expect(bridge).toContain("invoke<AdminSnapshot>('admin_create_task'");
    const root = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
    expect(root).toContain("['/overview', 'open local HII administration']");
    expect(root).toContain("window.location.assign('/admin')");
  });
});
