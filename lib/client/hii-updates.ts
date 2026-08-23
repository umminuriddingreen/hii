'use client';

/**
 * Desktop update checks. HII ships as a notarized DMG and then keeps itself current
 * through the Tauri updater, which verifies a minisign signature over every downloaded
 * bundle before installing it. The web build has no updater, so every entry point here
 * resolves to "nothing to do" rather than throwing.
 */

export type UpdateState =
  | { status: 'idle' | 'checking' | 'unsupported' | 'current' }
  | { status: 'available'; version: string; notes: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'failed'; message: string };

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Resolve the pending update, or null when the app is already current or not packaged. */
async function pendingUpdate() {
  if (!isTauri()) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  return check();
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (!isTauri()) return { status: 'unsupported' };
  try {
    const update = await pendingUpdate();
    if (!update) return { status: 'current' };
    return { status: 'available', version: update.version, notes: update.body ?? '' };
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : 'Update check failed.' };
  }
}

/**
 * Download and install the pending update, then restart into it.
 * Progress is reported as whole percent so a caller can render it without extra maths.
 */
export async function installUpdate(onState: (state: UpdateState) => void): Promise<void> {
  try {
    const update = await pendingUpdate();
    if (!update) {
      onState({ status: 'current' });
      return;
    }
    let downloaded = 0;
    let total = 0;
    onState({ status: 'downloading', version: update.version, percent: 0 });
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        onState({ status: 'downloading', version: update.version, percent });
      }
      if (event.event === 'Finished') onState({ status: 'ready', version: update.version });
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (error) {
    onState({ status: 'failed', message: error instanceof Error ? error.message : 'Update failed.' });
  }
}
