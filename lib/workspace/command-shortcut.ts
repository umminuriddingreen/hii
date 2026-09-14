export type CommandShortcut = {
  code: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

export const DEFAULT_WEB_COMMAND_SHORTCUT: CommandShortcut = {
  code: 'Space', alt: true, ctrl: false, meta: false, shift: false
};

const STORAGE_KEY = 'hii.canvas.command-shortcut.v1';

export function commandShortcutFromEvent(event: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): CommandShortcut | null {
  if (!event.altKey && !event.ctrlKey && !event.metaKey) return null;
  if (!/^(?:Key[A-Z]|Digit[0-9]|Space|Enter|Slash|Period|Comma)$/.test(event.code)) return null;
  return { code: event.code, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey };
}

export function matchesCommandShortcut(event: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>, shortcut: CommandShortcut) {
  return event.code === shortcut.code
    && event.altKey === shortcut.alt
    && event.ctrlKey === shortcut.ctrl
    && event.metaKey === shortcut.meta
    && event.shiftKey === shortcut.shift;
}

export function commandShortcutLabel(shortcut: CommandShortcut) {
  const key = shortcut.code === 'Space' ? 'Space' : shortcut.code.startsWith('Key') ? shortcut.code.slice(3) : shortcut.code.startsWith('Digit') ? shortcut.code.slice(5) : shortcut.code;
  return `${shortcut.ctrl ? '⌃' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.meta ? '⌘' : ''}${key}`;
}

export function readCommandShortcut(): CommandShortcut {
  if (typeof window === 'undefined') return DEFAULT_WEB_COMMAND_SHORTCUT;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') as CommandShortcut | null;
    if (value && typeof value.code === 'string'
      && typeof value.alt === 'boolean' && typeof value.ctrl === 'boolean'
      && typeof value.meta === 'boolean' && typeof value.shift === 'boolean'
      && commandShortcutFromEvent({ code: value.code, altKey: value.alt, ctrlKey: value.ctrl, metaKey: value.meta, shiftKey: value.shift })) return value;
  } catch { /* invalid saved shortcut uses the default */ }
  return DEFAULT_WEB_COMMAND_SHORTCUT;
}

export function saveCommandShortcut(shortcut: CommandShortcut) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcut));
}
