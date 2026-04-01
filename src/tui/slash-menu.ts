/**
 * Hierarchical slash-command menu for HII chat.
 * Typing "/" opens a navigable menu with arrow keys.
 * Right arrow drills into submenus, left arrow goes back.
 */
import { stdin, stdout } from 'node:process';

export type SlashMenuItem = {
  label: string;
  value: string;
  description?: string;
  children?: SlashMenuItem[];
};

const ESC = '\x1B';
const CSI = `${ESC}[`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

function clearLines(n: number) {
  for (let i = 0; i < n; i++) {
    stdout.write(`${CSI}2K`);
    if (i < n - 1) stdout.write(`${CSI}1A`);
  }
  stdout.write('\r');
}

function renderLevel(
  items: SlashMenuItem[],
  cursor: number,
  breadcrumb: string[],
  filterText: string,
  pageSize: number,
): string[] {
  const lines: string[] = [];
  const crumb = breadcrumb.length ? breadcrumb.join(' › ') + ' ›' : '/';
  lines.push(`\x1B[1m${crumb}\x1B[0m`);

  if (filterText) lines.push(`  filter: ${filterText}`);
  lines.push(`  \x1B[2mtab cycle  ↑/↓ navigate  → submenu  ← back  enter select  esc cancel\x1B[0m`);

  const total = items.length;
  let start = 0;
  if (total > pageSize) {
    start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), total - pageSize));
  }
  const end = Math.min(start + pageSize, total);

  if (start > 0) lines.push(`  \x1B[2m  ↑ ${start} more\x1B[0m`);

  for (let i = start; i < end; i++) {
    const item = items[i];
    const isCursor = i === cursor;
    const pointer = isCursor ? '\x1B[36m❯\x1B[0m' : ' ';
    const label = isCursor ? `\x1B[1m${item.label}\x1B[0m` : item.label;
    const arrow = item.children?.length ? ' \x1B[2m→\x1B[0m' : '';
    const desc = item.description ? `  \x1B[2m${item.description}\x1B[0m` : '';
    lines.push(`  ${pointer} ${label}${arrow}${desc}`);
  }

  if (end < total) lines.push(`  \x1B[2m  ↓ ${total - end} more\x1B[0m`);
  if (items.length === 0) lines.push('  \x1B[2mno matches\x1B[0m');

  return lines;
}

export const SLASH_MENU_TREE: SlashMenuItem[] = [
  {
    label: 'Chat',
    value: '_group',
    description: 'conversation controls',
    children: [
      { label: '/clear', value: '/clear', description: 'clear conversation history' },
      { label: '/status', value: '/status', description: 'show backend and model' },
      { label: '/help', value: '/help', description: 'show command reference' },
      { label: '/exit', value: '/exit', description: 'exit chat' },
    ],
  },
  {
    label: 'Model',
    value: '_group',
    description: 'switch models and backends',
    children: [
      { label: '/models', value: '/models', description: 'browse and select models' },
      { label: '/model', value: '/model ', description: 'set model by name' },
    ],
  },
  {
    label: 'Tools',
    value: '_group',
    description: 'toggle capabilities & browse tools',
    children: [
      { label: '/tools', value: '/tools', description: 'browse all available tools' },
      { label: '/web on|off', value: '/web ', description: 'toggle search tool access' },
      { label: '/ground on|off', value: '/ground ', description: 'toggle auto grounding' },
      { label: '/memory on|off', value: '/memory ', description: 'toggle Obsidian recall' },
      { label: '/search', value: '/search ', description: 'run a web search' },
    ],
  },
  {
    label: 'Create',
    value: '_group',
    description: 'generate and capture',
    children: [
      { label: '/generate', value: '/generate ', description: 'Rhino → ComfyUI img2img' },
      { label: '/capture', value: '/capture', description: 'capture Rhino viewport' },
    ],
  },
];

/**
 * Open the slash command menu. Returns the selected command string
 * (e.g. "/clear" or "/model ") or null if cancelled.
 */
export function slashMenu(
  tree: SlashMenuItem[] = SLASH_MENU_TREE,
  pageSize = 12,
): Promise<string | null> {
  return new Promise((resolve) => {
    const stack: { items: SlashMenuItem[]; cursor: number; filter: string }[] = [];
    let currentItems = tree;
    let cursor = 0;
    let filterText = '';
    let filtered = [...currentItems];
    let lastLineCount = 0;

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);

    function breadcrumb(): string[] {
      return stack.map((s) => {
        const item = s.items[s.cursor];
        return item?.label ?? '';
      });
    }

    function applyFilter() {
      const q = filterText.toLowerCase();
      filtered = q
        ? currentItems.filter(
            (it) =>
              it.label.toLowerCase().includes(q) ||
              (it.description?.toLowerCase().includes(q) ?? false),
          )
        : [...currentItems];
      cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
    }

    function draw() {
      if (lastLineCount > 0) clearLines(lastLineCount);
      const lines = renderLevel(filtered, cursor, breadcrumb(), filterText, pageSize);
      stdout.write(lines.join('\n') + '\n');
      lastLineCount = lines.length;
    }

    function cleanup() {
      stdin.removeListener('data', onKey);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdout.write(SHOW_CURSOR);
      if (lastLineCount > 0) clearLines(lastLineCount);
    }

    function onKey(buf: Buffer) {
      const key = buf.toString();

      // Escape / Ctrl-C
      if (key === ESC || key === '\x03') {
        cleanup();
        resolve(null);
        return;
      }

      // Enter — select current item
      if (key === '\r' || key === '\n') {
        const item = filtered[cursor];
        if (!item) { cleanup(); resolve(null); return; }
        // If it has children, drill in
        if (item.children?.length) {
          stack.push({ items: currentItems, cursor, filter: filterText });
          currentItems = item.children;
          cursor = 0;
          filterText = '';
          applyFilter();
          draw();
          return;
        }
        cleanup();
        resolve(item.value);
        return;
      }

      // Right arrow — drill into submenu
      if (key === `${CSI}C`) {
        const item = filtered[cursor];
        if (item?.children?.length) {
          stack.push({ items: currentItems, cursor, filter: filterText });
          currentItems = item.children;
          cursor = 0;
          filterText = '';
          applyFilter();
          draw();
        }
        return;
      }

      // Left arrow — go back
      if (key === `${CSI}D`) {
        const prev = stack.pop();
        if (prev) {
          currentItems = prev.items;
          cursor = prev.cursor;
          filterText = prev.filter;
          applyFilter();
          draw();
        } else {
          cleanup();
          resolve(null);
        }
        return;
      }

      // Up
      if (key === `${CSI}A`) {
        cursor = Math.max(0, cursor - 1);
        draw();
        return;
      }

      // Down
      if (key === `${CSI}B`) {
        cursor = Math.min(filtered.length - 1, cursor + 1);
        draw();
        return;
      }

      // Tab — cycle forward through items
      if (key === '\t') {
        cursor = (cursor + 1) % filtered.length;
        draw();
        return;
      }

      // Shift-Tab — cycle backward
      if (key === `${CSI}Z`) {
        cursor = (cursor - 1 + filtered.length) % filtered.length;
        draw();
        return;
      }

      // Backspace
      if (key === '\x7F' || key === '\b') {
        if (filterText.length > 0) {
          filterText = filterText.slice(0, -1);
          applyFilter();
          draw();
        } else {
          // Backspace with no filter = go back
          const prev = stack.pop();
          if (prev) {
            currentItems = prev.items;
            cursor = prev.cursor;
            filterText = prev.filter;
            applyFilter();
            draw();
          }
        }
        return;
      }

      // Printable characters -> filter
      if (key.length === 1 && key >= ' ' && key <= '~') {
        filterText += key;
        applyFilter();
        draw();
        return;
      }
    }

    draw();
    stdin.on('data', onKey);
  });
}
