type HistoryKey = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

export function historyShortcut(event: HistoryKey): 'undo' | 'redo' | null {
  if ((!event.metaKey && !event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === '[' || key === '{') return 'undo';
  if (key === ']' || key === '}') return 'redo';
  return null;
}
