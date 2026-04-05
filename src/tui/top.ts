import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import type { MicroTool } from '../micro/index.js';
import { getHiiHealth } from '../health.js';
import { TuiRuntime, formatKeyValue, percentBar, wrapText, type TuiFrame, type TuiInput } from './runtime.js';

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

function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width, ' ');
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
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
    items.push({
      id: full,
      label: full,
      summary: cmd.description() || 'No description',
      detail: [
        formatKeyValue('command', full),
        formatKeyValue('summary', cmd.description() || 'No description'),
        formatKeyValue('aliases', aliases),
        formatKeyValue('args', args),
        formatKeyValue('options', options),
      ],
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
          ...wrapText(String(raw.description || ''), 72).map((line) => `  ${line}`),
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
  return microTools
    .map((tool) => ({
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
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function filterItems(items: DashboardItem[], query: string): DashboardItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    const haystack = [item.label, item.summary, ...(item.detail || []), ...(item.meta || [])].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function keyHelp(): string {
  return 'tab shift panels | ↑↓ / j k move | ←→ / h l move | / search | r refresh | enter clear filter | q quit';
}

function formatBytes(value: number): string {
  return `${(value / (1024 ** 3)).toFixed(1)}G`;
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
  const sections: DashboardSection[] = [
    { id: 'commands', label: 'Commands', hint: 'Every registered CLI command', items: flattenCommands(root) },
    { id: 'skills', label: 'Skills', hint: 'Local HII skill registry entries', items: loadSkills() },
    { id: 'micro', label: 'Micro Tools', hint: 'Fast native helper functions', items: loadMicroTools(microTools) },
    { id: 'apis', label: 'Installed APIs', hint: 'Configured HII API integrations', items: loadInstalledApis() },
  ];

  let activePane = 1;
  let activeSection = 0;
  let itemCursor = 0;
  let search = '';
  let searchMode = false;
  let detailScroll = 0;
  let statusLines = await buildStatusLines();

  function currentSection(): DashboardSection {
    return sections[activeSection];
  }

  function currentItems(): DashboardItem[] {
    return filterItems(currentSection().items, search);
  }

  function selectedItem(): DashboardItem | null {
    return currentItems()[itemCursor] ?? null;
  }

  function clampState() {
    const items = currentItems();
    if (!items.length) {
      itemCursor = 0;
      detailScroll = 0;
      return;
    }
    itemCursor = Math.max(0, Math.min(itemCursor, items.length - 1));
    const detailLength = selectedItem()?.detail?.length ?? 0;
    detailScroll = Math.max(0, Math.min(detailScroll, Math.max(0, detailLength - 1)));
  }

  function renderFrame(width: number, height: number): TuiFrame {
    clampState();
    const usableHeight = Math.max(12, height - 7);
    const sectionWidth = Math.max(24, Math.floor(width * 0.2));
    const itemWidth = Math.max(38, Math.floor(width * 0.34));
    const detailWidth = Math.max(40, width - sectionWidth - itemWidth - 2);
    const boxHeight = usableHeight;

    const sectionLines = sections.map((section, index) => {
      const prefix = index === activeSection ? (activePane === 0 ? '❯' : '•') : ' ';
      const line = `${prefix} ${sectionTitle(section)}`;
      return index === activeSection ? `\x1B[1m${line}\x1B[0m` : line;
    });

    const items = currentItems();
    const pageSize = Math.max(5, boxHeight - 4);
    const start = Math.max(0, Math.min(itemCursor - Math.floor(pageSize / 2), Math.max(0, items.length - pageSize)));
    const itemLines = items.slice(start, start + pageSize).map((item, offset) => {
      const absolute = start + offset;
      const marker = absolute === itemCursor ? (activePane === 1 ? '❯' : '•') : ' ';
      const base = `${marker} ${item.label}`;
      const summary = item.summary ? `  ${item.summary}` : '';
      return absolute === itemCursor
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
    const detailVisible = detailBody
      .flatMap((line) => wrapText(line, Math.max(12, detailWidth - 4)))
      .slice(detailScroll, detailScroll + Math.max(5, boxHeight - 4));

    return {
      header: [
        `HII TOP  skills:${sections[1].items.length}  commands:${sections[0].items.length}  micro:${sections[2].items.length}  apis:${sections[3].items.length}`,
        searchMode ? `search> ${search}` : `section: ${currentSection().label}  hint: ${currentSection().hint}  filter: ${search || 'off'}`,
      ],
      status: statusLines,
      boxes: [
        { title: 'Sections', lines: sectionLines, width: sectionWidth, active: activePane === 0 },
        { title: sectionTitle(currentSection()), lines: itemLines, width: itemWidth, active: activePane === 1 },
        { title: selected ? selected.label : 'Details', lines: detailVisible, width: detailWidth, active: activePane === 2 },
      ],
      footer: [fit(keyHelp(), width)],
    };
  }

  const runtime = new TuiRuntime<'exit'>({
    fps: 30,
    tickMs: 1500,
    initialState: async () => {
      statusLines = await buildStatusLines();
    },
    onTick: async () => {
      statusLines = await buildStatusLines().catch(() => statusLines);
    },
    render: ({ width, height }) => renderFrame(width, height),
    onInput: async (input: TuiInput) => {
      const key = input.raw;

      if (searchMode) {
        if (input.key === 'enter' || input.key === 'escape') {
          searchMode = false;
          itemCursor = 0;
          detailScroll = 0;
          return;
        }
        if (input.key === 'backspace') {
          search = search.slice(0, -1);
          itemCursor = 0;
          detailScroll = 0;
          return;
        }
        if (input.text) {
          search += input.text;
          itemCursor = 0;
          detailScroll = 0;
        }
        return;
      }

      if (key === 'q' || input.key === 'ctrl-c') return 'exit';
      if (key === 'r') {
        statusLines = await buildStatusLines().catch(() => statusLines);
        return;
      }
      if (key === '/') {
        searchMode = true;
        return;
      }
      if (input.key === 'enter') {
        search = '';
        itemCursor = 0;
        detailScroll = 0;
        return;
      }
      if (input.key === 'tab') {
        activePane = (activePane + 1) % 3;
        return;
      }
      if (input.key === 'shift-tab') {
        activePane = (activePane + 2) % 3;
        return;
      }
      if (input.key === 'right' || key === 'l') {
        if (activePane === 0) {
          activeSection = Math.min(sections.length - 1, activeSection + 1);
          itemCursor = 0;
          detailScroll = 0;
        } else {
          activePane = Math.min(2, activePane + 1);
        }
        return;
      }
      if (input.key === 'left' || key === 'h') {
        if (activePane === 0) {
          activeSection = Math.max(0, activeSection - 1);
          itemCursor = 0;
          detailScroll = 0;
        } else {
          activePane = Math.max(0, activePane - 1);
        }
        return;
      }
      if (input.key === 'up' || key === 'k') {
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
        return;
      }
      if (input.key === 'down' || key === 'j') {
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
        return;
      }
      if (key === 'g') {
        if (activePane === 1) itemCursor = 0;
        if (activePane === 2) detailScroll = 0;
        return;
      }
      if (key === 'G') {
        if (activePane === 1) itemCursor = Math.max(0, currentItems().length - 1);
        if (activePane === 2) detailScroll = 10_000;
      }
    },
  });

  await runtime.run();
}
