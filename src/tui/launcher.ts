import { TuiRuntime, type TuiFrame, type TuiInput } from './runtime.js';

export type LauncherChoice =
  | 'chat'
  | 'top'
  | 'status'
  | 'radar'
  | 'models'
  | 'config'
  | 'health'
  | 'exit';

type LauncherItem = {
  label: string;
  value: LauncherChoice;
  description: string;
  group: string;
};

const LAUNCHER_ITEMS: LauncherItem[] = [
  {
    label: 'Chat',
    value: 'chat',
    description: 'interactive thought sharpening and tool use',
    group: 'core',
  },
  {
    label: 'Top',
    value: 'top',
    description: 'full-screen dashboard for commands, skills, tools, and APIs',
    group: 'monitoring',
  },
  {
    label: 'Status',
    value: 'status',
    description: 'live operational cockpit for runtime, paths, remotes, and desktop state',
    group: 'monitoring',
  },
  {
    label: 'Radar',
    value: 'radar',
    description: 'competitive intelligence and five-year product direction',
    group: 'strategy',
  },
  {
    label: 'Models',
    value: 'models',
    description: 'inspect and switch active model backends',
    group: 'configuration',
  },
  {
    label: 'Config',
    value: 'config',
    description: 'show current config, paths, and environment surface',
    group: 'configuration',
  },
  {
    label: 'Health',
    value: 'health',
    description: 'show compact operational health report',
    group: 'monitoring',
  },
  {
    label: 'Exit',
    value: 'exit',
    description: 'close HII',
    group: 'system',
  },
];

function renderLauncher(cursor: number): TuiFrame {
  const selected = LAUNCHER_ITEMS[cursor];
  return {
    header: [
      'HII  launcher shell',
      'default boot path for bare `hii`; shared runtime with top and status',
    ],
    status: [
      `selected ${selected.label}  group ${selected.group}  total surfaces ${LAUNCHER_ITEMS.length}`,
    ],
    boxes: [
      {
        title: 'Surfaces',
        width: 72,
        active: true,
        lines: LAUNCHER_ITEMS.map((item, index) => {
          const marker = index === cursor ? '❯' : ' ';
          const base = `${marker} ${item.label.padEnd(10, ' ')} ${item.description}`;
          return index === cursor ? `\x1B[1m${base}\x1B[0m` : base;
        }),
      },
      {
        title: 'Why This Exists',
        width: 56,
        lines: [
          'HII should launch like a product, not a flag matrix.',
          '',
          `surface   ${selected.label}`,
          `group     ${selected.group}`,
          '',
          selected.description,
          '',
          'The runtime under this screen provides diff rendering, consistent input handling, and a shared shell model for future command palette and session surfaces.',
        ],
      },
    ],
    footer: ['↑↓ or j k move | enter launch | q quit'],
  };
}

export async function launcherMenu(): Promise<LauncherChoice | null> {
  let cursor = 0;
  const runtime = new TuiRuntime<LauncherChoice | null>({
    fps: 30,
    render: () => renderLauncher(cursor),
    onInput: (input: TuiInput) => {
      if (input.key === 'ctrl-c' || input.raw === 'q') return null;
      if (input.key === 'enter') return LAUNCHER_ITEMS[cursor]?.value ?? null;
      if (input.key === 'down' || input.raw === 'j') {
        cursor = Math.min(LAUNCHER_ITEMS.length - 1, cursor + 1);
        return;
      }
      if (input.key === 'up' || input.raw === 'k') {
        cursor = Math.max(0, cursor - 1);
      }
    },
  });
  return runtime.run();
}
