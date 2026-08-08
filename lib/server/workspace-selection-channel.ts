/**
 * Ephemeral cross-window selection handoff.
 *
 * The Notch is a separate window from the Workspace, so it cannot see what is
 * selected. The tempting fix — writing the current selection into WorkspaceDoc —
 * would put transient UI state into the persisted document every other window
 * reloads, make every click a workspace revision, and let a stale save resurrect
 * a selection nobody made. Selection is not a property of the document.
 *
 * So this carries coordinates only, in memory, with a short life:
 *
 *   workspaceId, workspaceRevision, selectedNodeIds, activeSceneId,
 *   sourceWindow, capturedAt
 *
 * No titles, no excerpts, no content. The server resolves every identifier
 * against the authoritative Workspace before anything is shown or executed, so a
 * window that lies about what is selected can at worst name objects that exist.
 */

export type WorkspaceSelectionSignal = {
  workspaceId: string;
  workspaceRevision: number;
  selectedNodeIds: string[];
  activeSceneId?: string;
  sourceWindow: string;
  capturedAt: string;
};

/**
 * How long a published selection stays usable.
 *
 * Long enough to speak a sentence after clicking, short enough that a selection
 * from an hour ago never silently becomes the context for a new run.
 */
export const SELECTION_TTL_MS = 90_000;

const signals = new Map<string, WorkspaceSelectionSignal>();

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown, max = 120) {
  return clean(value, max).replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Validate and record what a window says is selected.
 *
 * Everything is bounded and stripped: this is untrusted input from a browser
 * context, and the only reason it is accepted at all is that it names things
 * rather than describing them.
 */
export function publishWorkspaceSelection(value: unknown, now = Date.now()): WorkspaceSelectionSignal {
  if (!value || typeof value !== 'object') throw new Error('A selection signal is required.');
  const raw = value as Record<string, unknown>;
  const workspaceId = cleanId(raw.workspaceId);
  if (!workspaceId) throw new Error('A selection signal must name its workspace.');
  const sourceWindow = cleanId(raw.sourceWindow, 60) || 'unknown';
  const revision = Number(raw.workspaceRevision);
  const selectedNodeIds = Array.isArray(raw.selectedNodeIds)
    ? Array.from(new Set(raw.selectedNodeIds.map((entry) => cleanId(entry)).filter(Boolean))).slice(0, 64)
    : [];
  const activeSceneId = cleanId(raw.activeSceneId);
  const signal: WorkspaceSelectionSignal = {
    workspaceId,
    workspaceRevision: Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0,
    selectedNodeIds,
    ...(activeSceneId ? { activeSceneId } : {}),
    sourceWindow,
    capturedAt: new Date(now).toISOString()
  };
  signals.set(workspaceId, signal);
  return signal;
}

/**
 * The current selection, or null when there is none or it has expired.
 *
 * Returning null rather than the last known selection is deliberate: a stale
 * selection presented as current is how a run gets approved against context the
 * human is no longer looking at.
 */
export function readWorkspaceSelection(
  workspaceId?: string,
  now = Date.now()
): WorkspaceSelectionSignal | null {
  const key = cleanId(workspaceId);
  const candidates = key
    ? ([signals.get(key)].filter(Boolean) as WorkspaceSelectionSignal[])
    : [...signals.values()];
  const live = candidates
    .filter((signal) => now - Date.parse(signal.capturedAt) < SELECTION_TTL_MS)
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  return live[0] ?? null;
}

/** Drop a window's selection when it closes or clears it. */
export function clearWorkspaceSelection(workspaceId?: string) {
  const key = cleanId(workspaceId);
  if (key) signals.delete(key);
  else signals.clear();
}

export function resetWorkspaceSelectionChannelForTests() {
  signals.clear();
}
