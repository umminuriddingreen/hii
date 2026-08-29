'use client';

export type AdminSnapshot = {
  schemaVersion: 1;
  kind: 'hii.admin.snapshot';
  generatedAt: string;
  authority: 'hii-cli';
  home: Record<string, any>;
  work: { activeTasks?: Array<Record<string, any>>; activeJobs?: Array<Record<string, any>> };
  latestProof?: Record<string, any> | null;
};

export async function readAdminSnapshot(): Promise<AdminSnapshot> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('HII Admin is available only inside the trusted local app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<AdminSnapshot>('admin_snapshot');
}

export async function createAdminTask(intent: string): Promise<AdminSnapshot> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('HII Admin is available only inside the trusted local app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<AdminSnapshot>('admin_create_task', { intent });
}
