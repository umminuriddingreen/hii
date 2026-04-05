import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import type { MicroTool } from '../micro/index.js';
import { getHiiHealth } from '../health.js';

type SectionId = 'commands' | 'skills' | 'micro' | 'apis';

type DashboardItem = {
  id: string;
  label: string;
  summary: string;
  detail: string[];
  meta?: string[];
};

type DashboardSection = {
  id: SectionId;
  label: string;
  hint: string;
  items: DashboardItem[];
};

const ESC = '\x1B';
const CSI = `${ESC}[`;
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

function formatKeyValue(key: string, value: string): string {
  return `${key.padEnd(14, ' ')} ${value}`;
}

function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width, ' ');
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length >= width ? text.slice(0, width) : text.padEnd(width, ' ');
}

function wrapText(text: string, width: number): string[] {
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
      if (`${current} ${word}`.length <= width) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

function sectionTitle(section: DashboardSection): string {
  return `${section.label} (${section.items.length})`;
}

function flattenCommands(root: Command, prefix = ''): DashboardItem[] {
  const items: DashboardItem[] = [];
  for (const cmd of root.commands) {
    const full = [prefix, cmd.name()].filter(Boolean).join(' ');
    const aliases = cmd.aliases().length ? cmd.aliases().join(', ') : 'none';
    const args = cmd.registeredArguments.map((arg) => arg.name()).join(' ') || 'none';
    const options = cmd.options.map((opt) => opt.flags).join(', ') || 'none';
    const detail = [
      formatKeyValue('command', full),
      formatKeyValue('summary', cmd.description() || 'No description'),
      formatKeyValue('aliases', aliases),
      formatKeyValue('args', args),
      formatKeyValue('options', options),
    ];
    items.push({
      id: full,
      label: full,
      summary: cmd.description() || 'No description',
      detail,
      meta: cmd.options.length ? cmd.options.map((opt) => opt.flags) : undefined,
    });
    items.push(...flattenCommands(cmd, full));
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

function loadSkills(): DashboardItem[] {
  const skillsDir = path.join(os.homedir(), '.hii', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const files = fs.readdirSync(skillsDir).filter((name) => name.endsWith('.json') && name !== '_index.json');
  const items: DashboardItem[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(skillsDir, file), 'utf8'));
      const tags = Array.isArray(raw.tags) && raw.tags.length ? raw.tags.join(', ') : 'none';
      const examples = Array.isArray(raw.examples) && raw.examples.length ? raw.examples.join(' | ') : 'none';
      items.push({
        id: raw.id,
        label: raw.id,
        summary: raw.description || raw.name || '',
        detail: [
          formatKeyValue('name', raw.name || raw.id),
          formatKeyValue('category', raw.category || 'unknown'),
          formatKeyValue('target', raw.target || 'unknown'),
          formatKeyValue('created', raw.created_at || 'unknown'),
          formatKeyValue('tags', tags),
          formatKeyValue('examples', examples),
          '',
          ...(wrapText(String(raw.description || ''), 72).map((line) => `  ${line}`)),
        ],
        meta: raw.inputs ? Object.keys(raw.inputs).map((key) => `${key}: ${raw.inputs[key]}`) : undefined,
      });
    } catch {
      // ignore malformed skill records in the dashboard
    }
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

function loadInstalledApis(): DashboardItem[] {
  const registryFile = path.join(os.homedir(), '.hii', 'api_registry.json');
  if (!fs.existsSync(registryFile)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as Record<string, any>;
    return Object.entries(raw)
      .map(([name, entry]) => ({
        id: name,
        label: name,
        summary: entry.description || '',
        detail: [
          formatKeyValue('name', name),
          formatKeyValue('category', entry.category || 'unknown'),
          formatKeyValue('status', entry.status || 'unknown'),
          formatKeyValue('auth', entry.auth_type || 'unknown'),
          formatKeyValue('base_url', entry.base_url || 'n/a'),
          formatKeyValue('token_name', entry.token_name || 'n/a'),
          formatKeyValue('installed', entry.installed_at || 'n/a'),
        ],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

function loadMicroTools(microTools: MicroTool[]): DashboardItem[] {
  return microTools.map((tool) => ({
    id: tool.name,
    label: tool.name,
    summary: tool.description,
    detail: [
      formatKeyValue('name', tool.name),
      formatKeyValue('summary', tool.description),
      '',
      'arguments',
      ...Object.entries(tool.args).map(([key, value]) => `  ${key.padEnd(14, ' ')} ${value}`),
    ],
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function filterItems(items: DashboardItem[], query: string): DashboardItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    const haystack = [
      item.label,
      item.summary,
      ...(item.detail || []),
      ...(item.meta || []),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function renderBox(title: string, lines: string[], width: number, height: number, active = false): string[] {
  const innerWidth = Math.max(1, width - 2);
  const bodyHeight = Math.max(1, height - 2);
  const borderColor = active ? '\x1B[36m' : '\x1B[2m';
  const reset = '\x1B[0m';
  const top = `${borderColor}┌${fit(` ${title} `, innerWidth).padEnd(innerWidth, '─')}┐${reset}`;
  const bottom = `${borderColor}└${'─'.repeat(innerWidth)}┘${reset}`;
  const body: string[] = [];
  for (let i = 0; i < bodyHeight; i += 1) {
    const line = lines[i] ?? '';
    body.push(`${borderColor}│${reset}${fit(line, innerWidth)}${borderColor}│${reset}`);
  }
  return [top, ...body, bottom];
}

function mergeColumns(columns: string[][]): string[] {
  const height = Math.max(...columns.map((col) => col.length));
  const lines: string[] = [];
  for (let i = 0; i < height; i += 1) {
    lines.push(columns.map((col) => col[i] ?? '').join(' '));
  }
  return lines;
}

function keyHelp(): string {
  return 'tab shift panels | ↑↓ / j k move | ←→ / h l move | / search | r refresh | enter clear filter | q quit';
}

function percentBar(value: number, width: number): string {
  const safe = Math.max(0, Math.min(1, value));
  const filled = Math.round(safe * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function formatBytes(value: number): string {
  const gb = value / (1024 ** 3);
  return `${gb.toFixed(1)}G`;
}

async function buildStatusLines() {
  const health = await getHiiHealth().catch(() => null);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memRatio = totalMem > 0 ? usedMem / totalMem : 0;
  const cpus = os.cpus().length || 1;
  const [l1, l5] = os.loadavg();
  const loadRatio = Math.max(0, Math.min(1, l1 / cpus));
  const generation = health?.generation?.name || 'none';
  const remotes = health?.remotes?.total ?? 0;
  const search = health?.runtime?.allowSearch ? 'on' : 'off';
  const shell = health?.runtime?.allowShell ? 'on' : 'off';
  const ollama = health?.runtime?.ollamaInstalled ? 'yes' : 'no';
  const space = health?.desktop?.space?.running ? 'running' : 'idle';

  return [
    `cpu ${percentBar(loadRatio, 12)} ${(loadRatio * 100).toFixed(0).padStart(3, ' ')}%  load ${l1.toFixed(2)} / ${l5.toFixed(2)}`,
    `mem ${percentBar(memRatio, 12)} ${(memRatio * 100).toFixed(0).padStart(3, ' ')}%  ${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
    `gen ${generation}  remotes ${String(remotes).padStart(2, ' ')}  search ${search}  shell ${shell}`,
    `ollama ${ollama}  desktop ${space}  host ${os.hostname()}  up ${Math.round(os.uptime() / 60)}m`,
  ];
}

export async function runTopDashboard(root: Command, microTools: MicroTool[]): Promise<void> {
  if (!stdout.isTTY || !stdin.isTTY) {
    throw new Error('`hii top` requires an interactive terminal.');
  }

  const sections: DashboardSection[] = [
    { id: 'commands', label: 'Commands', hint: 'Every registered CLI command', items: flattenCommands(root) },
    { id: 'skills', label: 'Skills', hint: 'Local HII skill registry entries', items: loadSkills() },
    { id: 'micro', label: 'Micro Tools', hint: 'Fast native helper functions', items: loadMicroTools(microTools) },
    { id: 'apis', label: 'Installed APIs', hint: 'Configured HII API integrations', items: loadInstalledApis() },
  ];

  let activePane = 1; // 0 sections, 1 items, 2 details
  let activeSection = 0;
  let itemCursor = 0;
  let search = '';
  let searchMode = false;
  let detailScroll = 0;
  let statusLines = await buildStatusLines();
  let refreshInFlight = false;

  const prevRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(ALT_SCREEN_ON);
  stdout.write(HIDE_CURSOR);

  function currentSection(): DashboardSection {
    return sections[activeSection];
  }

  function currentItems(): DashboardItem[] {
    return filterItems(currentSection().items, search);
  }

  function clampState() {
    const items = currentItems();
    if (items.length === 0) {
      itemCursor = 0;
      detailScroll = 0;
      return;
    }
    itemCursor = Math.max(0, Math.min(itemCursor, items.length - 1));
    const detailLines = selectedItem()?.detail ?? [];
    detailScroll = Math.max(0, Math.min(detailScroll, Math.max(0, detailLines.length - 1)));
  }

  function selectedItem(): DashboardItem | null {
    const items = currentItems();
    return items[itemCursor] ?? null;
  }

  function draw() {
    const width = stdout.columns || 140;
    const height = stdout.rows || 40;
    clampState();

    const usableHeight = Math.max(12, height - 7);
    const sectionWidth = Math.max(24, Math.floor(width * 0.2));
    const itemWidth = Math.max(38, Math.floor(width * 0.34));
    const detailWidth = Math.max(40, width - sectionWidth - itemWidth - 2);
    const boxHeight = usableHeight;

    const sectionLines = sections.map((section, index) => {
      const prefix = index === activeSection ? (activePane === 0 ? '❯' : '•') : ' ';
      const summary = `${prefix} ${sectionTitle(section)}`;
      return index === activeSection ? `\x1B[1m${summary}\x1B[0m` : summary;
    });

    const items = currentItems();
    const pageSize = Math.max(5, boxHeight - 4);
    const start = Math.max(0, Math.min(itemCursor - Math.floor(pageSize / 2), Math.max(0, items.length - pageSize)));
    const visibleItems = items.slice(start, start + pageSize);
    const itemLines = visibleItems.map((item, offset) => {
      const absoluteIndex = start + offset;
      const marker = absoluteIndex === itemCursor ? (activePane === 1 ? '❯' : '•') : ' ';
      const base = `${marker} ${item.label}`;
      const summary = item.summary ? `  ${item.summary}` : '';
      return absoluteIndex === itemCursor
        ? `\x1B[1m${fit(base, Math.max(10, itemWidth - 4))}\x1B[0m${summary}`
        : `${base}${summary}`;
    });
    if (!itemLines.length) itemLines.push('  no matches');

    const selected = selectedItem();
    const detailBody = selected
      ? [
          ...selected.detail,
          ...(selected.meta?.length ? ['', 'related', ...selected.meta.map((line) => `  ${line}`)] : []),
        ]
      : ['No item selected.'];
    const detailWrapped = detailBody.flatMap((line) => wrapText(line, Math.max(12, detailWidth - 4)));
    const detailVisible = detailWrapped.slice(detailScroll, detailScroll + Math.max(5, boxHeight - 4));

    const header = [
      `HII TOP  skills:${sections[1].items.length}  commands:${sections[0].items.length}  micro:${sections[2].items.length}  apis:${sections[3].items.length}`,
      searchMode ? `search> ${search}` : `section: ${currentSection().label}  hint: ${currentSection().hint}  filter: ${search || 'off'}`,
    ];

    const screen = [
      ...header.map((line) => fit(line, width)),
      ...statusLines.map((line) => pad(line, width)),
      ...mergeColumns([
        renderBox('Sections', sectionLines, sectionWidth, boxHeight, activePane === 0),
        renderBox(sectionTitle(currentSection()), itemLines, itemWidth, boxHeight, activePane === 1),
        renderBox(selected ? `${selected.label}` : 'Details', detailVisible, detailWidth, boxHeight, activePane === 2),
      ]),
      fit(keyHelp(), width),
    ];

    stdout.write('\x1B[H\x1B[2J');
    stdout.write(screen.join('\n'));
  }

  function cleanup() {
    stdin.setRawMode(prevRaw ?? false);
    stdin.pause();
    stdout.write(SHOW_CURSOR);
    stdout.write(ALT_SCREEN_OFF);
  }

  async function refreshStatus() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      statusLines = await buildStatusLines();
    } finally {
      refreshInFlight = false;
      draw();
    }
  }

  const refreshTimer = setInterval(() => {
    void refreshStatus();
  }, 1500);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();

  await new Promise<void>((resolve) => {
  function onKey(buf: Buffer) {
    const key = buf.toString();

    if (searchMode) {
      if (key === '\r' || key === '\n' || key === ESC) {
        searchMode = false;
        itemCursor = 0;
        detailScroll = 0;
        draw();
        return;
      }
      if (key === '\x7F' || key === '\b') {
        search = search.slice(0, -1);
        itemCursor = 0;
        detailScroll = 0;
        draw();
        return;
      }
      if (key.length === 1 && key >= ' ' && key <= '~') {
        search += key;
        itemCursor = 0;
        detailScroll = 0;
        draw();
      }
      return;
    }

    if (key === 'q' || key === '\x03') {
      stdin.removeListener('data', onKey);
      clearInterval(refreshTimer);
      cleanup();
      resolve();
      return;
    }
    if (key === 'r') {
      void refreshStatus();
      return;
    }
    if (key === '/') {
      searchMode = true;
      draw();
      return;
    }
    if (key === '\r' || key === '\n') {
      search = '';
      itemCursor = 0;
      detailScroll = 0;
      draw();
      return;
    }
    if (key === '\t') {
      activePane = (activePane + 1) % 3;
      draw();
      return;
    }
    if (key === `${CSI}Z`) {
      activePane = (activePane + 2) % 3;
      draw();
      return;
    }
    if (key === `${CSI}C` || key === 'l') {
      if (activePane === 0) {
        activeSection = Math.min(sections.length - 1, activeSection + 1);
        itemCursor = 0;
        detailScroll = 0;
      } else {
        activePane = Math.min(2, activePane + 1);
      }
      draw();
      return;
    }
    if (key === `${CSI}D` || key === 'h') {
      if (activePane === 0) {
        activeSection = Math.max(0, activeSection - 1);
        itemCursor = 0;
        detailScroll = 0;
      } else {
        activePane = Math.max(0, activePane - 1);
      }
      draw();
      return;
    }
    if (key === `${CSI}A` || key === 'k') {
      if (activePane === 0) {
        activeSection = Math.max(0, activeSection - 1);
        itemCursor = 0;
        detailScroll = 0;
      } else if (activePane === 1) {
        itemCursor = Math.max(0, itemCursor - 1);
        detailScroll = 0;
      } else {
        detailScroll = Math.max(0, detailScroll - 1);
      }
      draw();
      return;
    }
    if (key === `${CSI}B` || key === 'j') {
      if (activePane === 0) {
        activeSection = Math.min(sections.length - 1, activeSection + 1);
        itemCursor = 0;
        detailScroll = 0;
      } else if (activePane === 1) {
        itemCursor = Math.min(Math.max(0, currentItems().length - 1), itemCursor + 1);
        detailScroll = 0;
      } else {
        detailScroll += 1;
      }
      draw();
      return;
    }
    if (key === 'g') {
      if (activePane === 1) itemCursor = 0;
      if (activePane === 2) detailScroll = 0;
      draw();
      return;
    }
    if (key === 'G') {
      if (activePane === 1) itemCursor = Math.max(0, currentItems().length - 1);
      if (activePane === 2) detailScroll = 10_000;
      draw();
      return;
    }
  }

  draw();
  stdin.on('data', onKey);
  });
}
