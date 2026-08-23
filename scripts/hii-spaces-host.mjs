#!/usr/bin/env node

import { startSpacesHost } from '../lib/spaces/host/server.ts';

function usage() {
  return [
    'Usage: node --experimental-strip-types scripts/hii-spaces-host.mjs [--lan] [--port <port>] [--operator-port <port>] [--app-root <path>]',
    '',
    'Default: listen only on 127.0.0.1.',
    '--lan: explicitly expose Space-safe routes to this Mac\'s local network.'
  ].join('\n');
}

function parseArguments(argv) {
  const options = { mode: 'local' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--lan') {
      options.mode = 'lan';
      continue;
    }
    if (argument === '--port') {
      const value = argv[++index];
      if (value === undefined || !/^\d+$/.test(value)) throw new TypeError('--port requires an integer');
      options.port = Number(value);
      continue;
    }
    if (argument === '--operator-port') {
      const value = argv[++index];
      if (value === undefined || !/^\d+$/.test(value)) throw new TypeError('--operator-port requires an integer');
      options.operatorPort = Number(value);
      continue;
    }
    if (argument === '--app-root') {
      const value = argv[++index];
      if (!value) throw new TypeError('--app-root requires a path');
      options.appRoot = value;
      continue;
    }
    if (argument === '--help' || argument === '-h') return { help: true };
    throw new TypeError(`unknown option: ${argument}`);
  }
  return { options };
}

let parsed;
try {
  parsed = parseArguments(process.argv.slice(2));
} catch (caught) {
  console.error(caught instanceof Error ? caught.message : String(caught));
  console.error(usage());
  process.exitCode = 2;
}

if (parsed?.help) {
  console.log(usage());
} else if (parsed?.options) {
  try {
    const host = await startSpacesHost(parsed.options);
    if (host.binding.mode === 'lan') {
      console.warn('LAN mode is active. Only HII Space-safe routes are exposed; anyone on this network can attempt to open them.');
    }
    console.log(`HII Spaces host listening on ${host.binding.bindAddress}:${host.port}`);
    for (const origin of host.origins) console.log(`Open ${origin}/s/<space-id>`);
    console.log(`Manage ${host.operatorOrigins[0]}/spaces`);

    const stop = async () => {
      await host.stop();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    if ('code' in error && error.code === 'EADDRINUSE') {
      console.error('The requested HII Spaces port is already in use. Choose another with --port.');
    } else if ('code' in error && error.code === 'EACCES') {
      console.error('macOS refused the listener. Check Local Network permission for the terminal or HII application.');
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}
