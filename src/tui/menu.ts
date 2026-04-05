/**
 * Interactive arrow-key menu for the HII terminal.
 * Zero external dependencies — raw stdin key parsing.
 */
import { stdin, stdout } from 'node:process';

export type MenuItem = {
  label: string;
  value: string;
  description?: string;
  group?: string;
};

export type MenuOptions = {
  title?: string;
  /** Max visible rows before scrolling */
  pageSize?: number;
  /** Allow multi-select with space */
  multi?: boolean;
};

const ESC = '\x1B';
const CSI = `${ESC}[`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

export function cycleCursor(length: number, cursor: number, delta: number): number {
  if (length <= 0) return 0;
  return (cursor + delta % length + length) % length;
}

function clampCursor(length: number, cursor: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(cursor, length - 1));
}

function clearLines(n: number) {
  for (let i = 0; i < n; i++) {
    stdout.write(`${CSI}2K`); // clear line
    if (i < n - 1) stdout.write(`${CSI}1A`); // move up
  }
  stdout.write('\r');
}

function renderMenu(
  items: MenuItem[],
  cursor: number,
  selected: Set<number>,
  opts: MenuOptions,
  filterText: string,
): string[] {
  const lines: string[] = [];
  const pageSize = opts.pageSize ?? 12;

  if (opts.title) {
    lines.push(`\x1B[1m${opts.title}\x1B[0m`);
  }
  if (filterText) {
    lines.push(`  filter: ${filterText}`);
  }
  lines.push(`  \x1B[2m↑/↓ or tab cycle  pgup/pgdn jump  home/end edge${opts.multi ? '  space select' : ''}  enter confirm  esc cancel  type to filter\x1B[0m`);

  // Compute visible window
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
    const isSelected = selected.has(i);
    const pointer = isCursor ? '\x1B[36m❯\x1B[0m' : ' ';
    const check = opts.multi ? (isSelected ? '\x1B[32m◉\x1B[0m' : '○') : '';
    const label = isCursor ? `\x1B[1m${item.label}\x1B[0m` : item.label;
    const desc = item.description ? `  \x1B[2m${item.description}\x1B[0m` : '';
    lines.push(`  ${pointer} ${check}${check ? ' ' : ''}${label}${desc}`);
  }

  if (end < total) lines.push(`  \x1B[2m  ↓ ${total - end} more\x1B[0m`);

  if (items.length === 0) {
    lines.push('  \x1B[2mno matches\x1B[0m');
  }

  return lines;
}

/**
 * Show an interactive menu and return the selected item(s).
 * Returns null if the user presses Escape.
 */
export function interactiveMenu(
  allItems: MenuItem[],
  opts: MenuOptions = {},
): Promise<MenuItem[] | null> {
  return new Promise((resolve) => {
    let cursor = 0;
    let selected = new Set<number>();
    let filterText = '';
    let filteredItems = [...allItems];
    let lastLineCount = 0;

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);

    function applyFilter() {
      const q = filterText.toLowerCase();
      filteredItems = q
        ? allItems.filter(
            (it) =>
              it.label.toLowerCase().includes(q) ||
              (it.description?.toLowerCase().includes(q) ?? false) ||
              (it.group?.toLowerCase().includes(q) ?? false),
          )
        : [...allItems];
      cursor = clampCursor(filteredItems.length, cursor);
      selected.clear();
    }

    function draw() {
      if (lastLineCount > 0) clearLines(lastLineCount);
      const lines = renderMenu(filteredItems, cursor, selected, opts, filterText);
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

      // Escape
      if (key === ESC || key === '\x03') {
        cleanup();
        resolve(null);
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        if (opts.multi) {
          const picks = [...selected].map((i) => filteredItems[i]).filter(Boolean);
          resolve(picks.length ? picks : filteredItems[cursor] ? [filteredItems[cursor]] : null);
        } else {
          resolve(filteredItems[cursor] ? [filteredItems[cursor]] : null);
        }
        return;
      }

      // Arrow keys
      if (key === `${CSI}A`) {
        cursor = cycleCursor(filteredItems.length, cursor, -1);
        draw();
        return;
      }
      if (key === `${CSI}B`) {
        cursor = cycleCursor(filteredItems.length, cursor, 1);
        draw();
        return;
      }

      if (key === '\t') {
        cursor = cycleCursor(filteredItems.length, cursor, 1);
        draw();
        return;
      }

      if (key === `${CSI}Z`) {
        cursor = cycleCursor(filteredItems.length, cursor, -1);
        draw();
        return;
      }

      // Space (multi-select toggle)
      if (key === ' ' && opts.multi) {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        draw();
        return;
      }

      // Backspace
      if (key === '\x7F' || key === '\b') {
        if (filterText.length > 0) {
          filterText = filterText.slice(0, -1);
          applyFilter();
          draw();
        }
        return;
      }

      if (key === 'j') {
        cursor = cycleCursor(filteredItems.length, cursor, 1);
        draw();
        return;
      }

      if (key === 'k') {
        cursor = cycleCursor(filteredItems.length, cursor, -1);
        draw();
        return;
      }

      if (key === `${CSI}5~`) {
        cursor = clampCursor(filteredItems.length, cursor - (opts.pageSize ?? 12));
        draw();
        return;
      }

      if (key === `${CSI}6~`) {
        cursor = clampCursor(filteredItems.length, cursor + (opts.pageSize ?? 12));
        draw();
        return;
      }

      if (key === `${CSI}H` || key === `${CSI}1~`) {
        cursor = 0;
        draw();
        return;
      }

      if (key === `${CSI}F` || key === `${CSI}4~`) {
        cursor = clampCursor(filteredItems.length, filteredItems.length - 1);
        draw();
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
