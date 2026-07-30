import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SAFE_HOST_ENV = new Set([
  'DEVELOPER_DIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SDKROOT',
  'SYSTEM_VERSION_COMPAT'
]);

function quoteSandbox(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function sanitizedHostEnv({ layout, hostEnv = process.env }) {
  const env = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value == null || (!SAFE_HOST_ENV.has(name) && !name.startsWith('LC_'))) continue;
    env[name] = value;
  }
  const hostHome = os.homedir();
  env.PATH = (hostEnv.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
    .filter((entry) => entry !== hostHome && !entry.startsWith(`${hostHome}${path.sep}`))
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .join(path.delimiter);
  env.HOME = path.join(layout.sessionDir, 'home');
  env.TMPDIR = path.join(layout.sessionDir, 'tmp');
  env.HII_RUNTIME_DIR = layout.runtime;
  env.HII_ROOT = layout.workspace;
  env.HII_SESSION_PROFILE = 'public-test';
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.NO_COLOR;
  return env;
}

export async function createSandbox({ layout, hiiBinary, hostEnv = process.env }) {
  const home = path.join(layout.sessionDir, 'home');
  const temporary = path.join(layout.sessionDir, 'tmp');
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(temporary, { recursive: true, mode: 0o700 })
  ]);
  const canonicalSessionDir = await fs.realpath(layout.sessionDir);
  const canonicalWorkspace = await fs.realpath(layout.workspace);
  const hostHome = await fs.realpath(os.homedir());
  const pathDirectories = (hostEnv.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
    .filter((entry) => entry !== hostHome && !entry.startsWith(`${hostHome}${path.sep}`));
  const toolRoots = pathDirectories.map((entry) => {
    const leaf = path.basename(entry);
    const parent = path.dirname(entry);
    return (leaf === 'bin' || leaf === 'sbin') &&
      parent !== path.parse(entry).root &&
      parent !== hostHome
      ? parent
      : entry;
  });
  const readRoots = [
    '/System',
    '/Applications',
    '/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/opt/homebrew',
    '/usr/local',
    '/private/etc',
    '/private/var',
    '/private/var/select',
    '/dev',
    ...pathDirectories,
    ...toolRoots,
    path.dirname(path.resolve(hiiBinary))
  ];
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow pseudo-tty)',
    '(allow file-ioctl)',
    '(allow file-read-metadata)',
    '(allow file-read*)',
    `(deny file-read* (subpath ${quoteSandbox(hostHome)}))`,
    '(deny file-read* (subpath "/Volumes"))',
    '(deny file-read* (subpath "/Network"))',
    '(deny file-read* (subpath "/private/var/root"))',
    ...[...new Set(readRoots)].map((root) => `(allow file-read* (subpath ${quoteSandbox(root)}))`),
    `(allow file-read* file-write* (subpath ${quoteSandbox(canonicalSessionDir)}))`,
    `(deny file-write-unlink (subpath ${quoteSandbox(canonicalSessionDir)}))`,
    `(deny file-write-unlink (subpath ${quoteSandbox(canonicalWorkspace)}))`
  ].join('\n');
  const profilePath = path.join(layout.sessionDir, 'sandbox.sb');
  await fs.writeFile(profilePath, `${profile}\n`, { mode: 0o600 });
  return {
    launcher: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, path.resolve(hiiBinary)],
    env: sanitizedHostEnv({ layout, hostEnv }),
    profilePath
  };
}
