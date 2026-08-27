'use client';

/**
 * Client side of the HII UI channel: the interface can be swapped underneath the
 * Tauri shell, so this is how a surface reads that state, applies a staged
 * interface bundle, or follows a dev server.
 */

export type UiChannelStatus = {
  mode: 'bundled' | 'live' | 'installed';
  url: string | null;
  version: string | null;
  pendingVersion: string | null;
  endpoint: string | null;
  autoApply: boolean;
  pollSeconds: number;
  channelDir: string;
};

export type UiChannelCheck =
  | { status: 'skipped'; reason: string }
  | { status: 'current'; version: string }
  | { status: 'pending'; version: string; notes?: string | null }
  | { status: 'applied'; version: string };

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(command, args);
}

export async function readUiChannelStatus(): Promise<UiChannelStatus | null> {
  if (!isTauri()) return null;
  return invoke<UiChannelStatus>('ui_channel_status');
}

/** Follow a dev server (HMR) or, with `null`, stop following it. */
export async function setUiChannelLive(url: string | null): Promise<UiChannelStatus> {
  return invoke<UiChannelStatus>('ui_channel_set_live', { url });
}

export async function configureUiChannel(options: {
  endpoint?: string | null;
  autoApply?: boolean;
  pollSeconds?: number;
}): Promise<UiChannelStatus> {
  return invoke<UiChannelStatus>('ui_channel_configure', {
    endpoint: options.endpoint,
    autoApply: options.autoApply,
    pollSeconds: options.pollSeconds
  });
}

/** Check the manifest now; installs, and applies when auto-apply is on. */
export async function checkUiChannel(force = false): Promise<UiChannelCheck> {
  return invoke<UiChannelCheck>('ui_channel_check', { force });
}

/** Apply a staged bundle (or roll back to an older one) without restarting. */
export async function applyUiChannel(version?: string): Promise<UiChannelStatus> {
  return invoke<UiChannelStatus>('ui_channel_apply', { version });
}

export async function listUiChannelVersions(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('ui_channel_versions');
}

export type UiChannelEvent =
  | { kind: 'update-available'; version: string; notes?: string | null }
  | { kind: 'applied'; version: string }
  | { kind: 'restart-required' };

/** Listen for interface updates staged or applied by the background poller. */
export async function listenUiChannel(handler: (event: UiChannelEvent) => void) {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const unlisteners = await Promise.all([
    listen<{ version: string; notes?: string | null }>('hii://ui-update-available', (event) =>
      handler({ kind: 'update-available', version: event.payload.version, notes: event.payload.notes })
    ),
    listen<{ version: string }>('hii://ui-applied', (event) =>
      handler({ kind: 'applied', version: event.payload.version })
    ),
    listen('hii://ui-restart-required', () => handler({ kind: 'restart-required' }))
  ]);
  return () => unlisteners.forEach((stop) => stop());
}
