#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PLATFORM_RHINOCODE = process.platform === 'darwin'
  ? '/Applications/Rhino 8.app/Contents/Resources/bin/rhinocode'
  : process.platform === 'win32'
    ? 'C:\\Program Files\\Rhino 8\\System\\RhinoCode.exe'
    : '';
const RHINOCODE = process.env.HII_RHINOCODE_PATH || PLATFORM_RHINOCODE;

function fail(message) {
  process.stderr.write(`hii rhino: ${message}\n`);
  process.exit(1);
}

function run(args, options = {}) {
  if (!RHINOCODE) fail(`RhinoCode is unsupported on ${process.platform}; set HII_RHINOCODE_PATH to an explicit executable`);
  if (!existsSync(RHINOCODE)) fail(`RhinoCode not found: ${RHINOCODE}`);
  const result = spawnSync(RHINOCODE, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.error) fail(result.error.message);
  if (!options.inherit) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function targetArgs() {
  const target = process.env.HII_RHINO_ID?.trim();
  return target ? ['--rhino', target] : [];
}

function printWindowState() {
  process.stdout.write('HII RHINO WINDOWS\n');
  if (process.platform === 'win32') {
    const script = [
      "Get-Process Rhino -ErrorAction SilentlyContinue",
      "Select-Object Id,MainWindowTitle,Responding,StartTime,@{n='WorkingSetMB';e={[math]::Round($_.WorkingSet64/1MB)}}",
      'ConvertTo-Json -Compress'
    ].join(' | ');
    const state = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    const text = state.stdout?.trim();
    if (!text) process.stdout.write('none\n');
    else {
      const rows = JSON.parse(text);
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        process.stdout.write(`${row.Id}\t${row.Responding ? 'responsive' : 'not-responding'}\t${row.WorkingSetMB} MB\t${row.MainWindowTitle || '(no window title)'}\n`);
      }
    }
  } else if (process.platform === 'darwin') {
    const state = spawnSync('ps', ['-axo', 'pid=,stat=,comm='], { encoding: 'utf8' });
    const rows = (state.stdout || '').split(/\r?\n/).filter((line) => /Rhino/i.test(line));
    process.stdout.write(rows.length ? `${rows.join('\n')}\n` : 'none\n');
  } else {
    process.stdout.write(`unsupported on ${process.platform}\n`);
  }
  process.stdout.write('\nRHINOCODE DOCUMENTS\n');
}

const [verb = 'status', ...words] = process.argv.slice(2);
if (verb === 'status') {
  printWindowState();
  run(['list']);
} else if (verb === 'command') {
  if (!words.length) fail('command text is required');
  run([...targetArgs(), 'command', words.join(' ')], { inherit: true });
} else if (verb === 'script') {
  if (words.length !== 1) fail('one Rhino Python script path is required');
  const script = path.resolve(words[0]);
  if (!existsSync(script)) fail(`script not found: ${script}`);
  run([...targetArgs(), 'script', script], { inherit: true });
} else if (verb === 'grasshopper') {
  if (words.length !== 1) fail('one Grasshopper definition path is required');
  const definition = path.resolve(words[0]);
  if (!existsSync(definition)) fail(`definition not found: ${definition}`);
  const escaped = definition.replaceAll('"', '""');
  run([...targetArgs(), 'command', `_-Grasshopper _Document _Open "${escaped}" _Enter`], { inherit: true });
} else {
  fail('usage: hii-rhino status | command <command> | script <path.py> | grasshopper <path.gh>');
}
