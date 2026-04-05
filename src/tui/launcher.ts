import { interactiveMenu, type MenuItem } from './menu.js';

export type LauncherChoice =
  | 'chat'
  | 'top'
  | 'radar'
  | 'models'
  | 'config'
  | 'health'
  | 'exit';

const LAUNCHER_ITEMS: MenuItem[] = [
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

export async function launcherMenu(): Promise<LauncherChoice | null> {
  const picks = await interactiveMenu(LAUNCHER_ITEMS, {
    title: '  HII Launcher',
    pageSize: 10,
  });
  return (picks?.[0]?.value as LauncherChoice | undefined) ?? null;
}
