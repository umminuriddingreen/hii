import { stdin, stdout } from 'node:process';

const ESC = '\x1B';
const CSI = `${ESC}[`;
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const BRACKETED_PASTE_ON = `${CSI}?2004h`;
const BRACKETED_PASTE_OFF = `${CSI}?2004l`;
const MOUSE_ON = `${CSI}?1000h${CSI}?1002h${CSI}?1006h`;
const MOUSE_OFF = `${CSI}?1000l${CSI}?1002l${CSI}?1006l`;
const FOCUS_ON = `${CSI}?1004h`;
const FOCUS_OFF = `${CSI}?1004l`;

export type TuiBox = {
  title: string;
  lines: string[];
  width: number;
  active?: boolean;
};

export type TuiFrame = {
  header?: string[];
  status?: string[];
  boxes?: TuiBox[];
  footer?: string[];
};

export type TuiKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'tab'
  | 'shift-tab'
  | 'enter'
  | 'escape'
  | 'backspace'
  | 'pageup'
  | 'pagedown'
  | 'home'
  | 'end'
  | 'ctrl-c'
  | 'focus-in'
  | 'focus-out'
  | 'resize'
  | 'unknown';

export type TuiInput = {
  key: TuiKey;
  raw: string;
  text?: string;
};

export type TuiContext = {
  width: number;
  height: number;
};

export type TuiScreen<Result> = {
  initialState?: () => Promise<void> | void;
  render: (ctx: TuiContext) => TuiFrame;
  onInput: (input: TuiInput) => Promise<Result | void> | Result | void;
  onTick?: () => Promise<void> | void;
  fps?: number;
  tickMs?: number;
  mouse?: boolean;
};

function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width, ' ');
  if (width === 1) return text;
  return `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length >= width ? text.slice(0, width) : text.padEnd(width, ' ');
}

function normalizeInput(raw: string): TuiInput {
  if (raw === `${CSI}A`) return { key: 'up', raw };
  if (raw === `${CSI}B`) return { key: 'down', raw };
  if (raw === `${CSI}C`) return { key: 'right', raw };
  if (raw === `${CSI}D`) return { key: 'left', raw };
  if (raw === '\t') return { key: 'tab', raw };
  if (raw === `${CSI}Z`) return { key: 'shift-tab', raw };
  if (raw === '\r' || raw === '\n') return { key: 'enter', raw };
  if (raw === ESC) return { key: 'escape', raw };
  if (raw === '\x03') return { key: 'ctrl-c', raw };
  if (raw === '\x7F' || raw === '\b') return { key: 'backspace', raw };
  if (raw === `${CSI}5~`) return { key: 'pageup', raw };
  if (raw === `${CSI}6~`) return { key: 'pagedown', raw };
  if (raw === `${CSI}H` || raw === `${CSI}1~`) return { key: 'home', raw };
  if (raw === `${CSI}F` || raw === `${CSI}4~`) return { key: 'end', raw };
  if (raw === `${CSI}I`) return { key: 'focus-in', raw };
  if (raw === `${CSI}O`) return { key: 'focus-out', raw };
  if (raw.length === 1 && raw >= ' ' && raw <= '~') return { key: 'unknown', raw, text: raw };
  return { key: 'unknown', raw };
}

function renderBox(box: TuiBox, height: number): string[] {
  const innerWidth = Math.max(1, box.width - 2);
  const bodyHeight = Math.max(1, height - 2);
  const borderColor = box.active ? '\x1B[36m' : '\x1B[2m';
  const reset = '\x1B[0m';
  const top = `${borderColor}┌${fit(` ${box.title} `, innerWidth).padEnd(innerWidth, '─')}┐${reset}`;
  const bottom = `${borderColor}└${'─'.repeat(innerWidth)}┘${reset}`;
  const body: string[] = [];
  for (let index = 0; index < bodyHeight; index += 1) {
    body.push(`${borderColor}│${reset}${fit(box.lines[index] ?? '', innerWidth)}${borderColor}│${reset}`);
  }
  return [top, ...body, bottom];
}

function mergeColumns(columns: string[][]): string[] {
  const height = Math.max(...columns.map((column) => column.length), 0);
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    lines.push(columns.map((column) => column[index] ?? '').join(' '));
  }
  return lines;
}

function frameToLines(frame: TuiFrame, width: number, height: number): string[] {
  const header = (frame.header ?? []).map((line) => fit(line, width));
  const status = (frame.status ?? []).map((line) => pad(line, width));
  const footer = (frame.footer ?? []).map((line) => fit(line, width));
  const reserved = header.length + status.length + footer.length;
  const boxHeight = Math.max(5, height - reserved);
  const boxes = frame.boxes?.length
    ? mergeColumns(frame.boxes.map((box) => renderBox(box, boxHeight)))
    : [];
  const lines = [...header, ...status, ...boxes, ...footer];
  const clipped = lines.slice(0, height);
  while (clipped.length < height) clipped.push(' '.repeat(width));
  return clipped.map((line) => pad(line, width));
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      if (!current) {
        current = word;
        continue;
      }
      const joined = `${current} ${word}`;
      if (joined.length <= width) {
        current = joined;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

export function formatKeyValue(key: string, value: string): string {
  return `${key.padEnd(14, ' ')} ${value}`;
}

export function percentBar(value: number, width: number): string {
  const safe = Math.max(0, Math.min(1, value));
  const filled = Math.round(safe * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

export class TuiRuntime<Result> {
  private readonly screen: TuiScreen<Result>;
  private previousLines: string[] = [];
  private resolveResult?: (value: Result) => void;
  private rejectResult?: (error: unknown) => void;
  private refreshTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private prevRaw?: boolean;
  private closed = false;
  private dirty = true;
  private pendingRender = false;

  constructor(screen: TuiScreen<Result>) {
    this.screen = screen;
  }

  async run(): Promise<Result> {
    if (!stdout.isTTY || !stdin.isTTY) {
      throw new Error('This surface requires an interactive terminal.');
    }

    return new Promise<Result>(async (resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
      try {
        this.prevRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdout.write(ALT_SCREEN_ON);
        stdout.write(HIDE_CURSOR);
        stdout.write(BRACKETED_PASTE_ON);
        stdout.write(FOCUS_ON);
        if (this.screen.mouse) stdout.write(MOUSE_ON);
        await this.screen.initialState?.();
        this.installTimers();
        this.scheduleRender();
        stdin.on('data', this.onData);
        process.stdout.on('resize', this.onResize);
      } catch (error) {
        this.cleanup();
        reject(error);
      }
    });
  }

  private installTimers() {
    const fps = Math.max(10, Math.min(60, this.screen.fps ?? 30));
    this.refreshTimer = setInterval(() => this.scheduleRender(), Math.round(1000 / fps));
    this.refreshTimer.unref?.();
    if (this.screen.onTick) {
      this.tickTimer = setInterval(async () => {
        await this.screen.onTick?.();
        this.dirty = true;
        this.scheduleRender();
      }, this.screen.tickMs ?? 1500);
      this.tickTimer.unref?.();
    }
  }

  private scheduleRender() {
    if (this.closed || this.pendingRender) return;
    this.pendingRender = true;
    queueMicrotask(() => {
      this.pendingRender = false;
      if (!this.dirty || this.closed) return;
      this.renderNow();
    });
  }

  private renderNow() {
    this.dirty = false;
    const width = stdout.columns || 120;
    const height = stdout.rows || 40;
    const nextLines = frameToLines(this.screen.render({ width, height }), width, height);
    if (!this.previousLines.length) {
      stdout.write('\x1B[H\x1B[2J');
      stdout.write(nextLines.join('\n'));
      this.previousLines = nextLines;
      return;
    }
    for (let index = 0; index < nextLines.length; index += 1) {
      if (nextLines[index] === this.previousLines[index]) continue;
      stdout.write(`\x1B[${index + 1};1H${nextLines[index]}`);
    }
    this.previousLines = nextLines;
  }

  private onResize = () => {
    void this.screen.onInput({ key: 'resize', raw: '' });
    this.dirty = true;
    this.scheduleRender();
  };

  private onData = async (buffer: Buffer) => {
    const input = normalizeInput(buffer.toString());
    try {
      const result = await this.screen.onInput(input);
      if (typeof result !== 'undefined') {
        this.cleanup();
        this.resolveResult?.(result);
        return;
      }
      this.dirty = true;
      this.scheduleRender();
    } catch (error) {
      this.cleanup();
      this.rejectResult?.(error);
    }
  };

  private cleanup() {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    stdin.removeListener('data', this.onData);
    process.stdout.off('resize', this.onResize);
    stdin.setRawMode(this.prevRaw ?? false);
    stdin.pause();
    stdout.write('\x1B[H\x1B[2J');
    if (this.screen.mouse) stdout.write(MOUSE_OFF);
    stdout.write(FOCUS_OFF);
    stdout.write(BRACKETED_PASTE_OFF);
    stdout.write(SHOW_CURSOR);
    stdout.write(ALT_SCREEN_OFF);
  }
}
