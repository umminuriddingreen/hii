import { createServer } from 'http';
import { readFileSync } from 'node:fs';
import { getRequestHandlers } from 'next/dist/server/lib/start-server.js';
import { WebSocketServer } from 'ws';
import { attachPtyGateway, isLocalRequest } from './server/pty-gateway.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const PTY_PATH = '/api/pty';

// The desktop bundle uses Next's standalone output while retaining this small
// local PTY gateway. Reuse the exact serialized build config so Next runs in
// supported standalone mode instead of treating this process as `next start`.
if (!dev) {
  const manifestUrl = new URL('./.next/required-server-files.json', import.meta.url);
  const { config } = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
}

let handleRequest;
let handleUpgrade;
const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error('hii request failed', error);
    if (!res.headersSent) res.statusCode = 500;
    if (!res.writableEnded) res.end('Internal Server Error');
  }
});

try {
  console.log(`hii preparing ${dev ? 'development' : 'production'} server on ${host}:${port}`);
  [handleRequest, handleUpgrade] = await getRequestHandlers({
    dir: process.cwd(),
    port,
    isDev: dev,
    server,
    hostname: host,
    minimalMode: false
  });
} catch (error) {
  console.error('hii server prepare failed');
  console.error(error);
  process.exit(1);
}

const wss = new WebSocketServer({ noServer: true });
attachPtyGateway(wss);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === PTY_PATH) {
    if (!isLocalRequest(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  Promise.resolve(handleUpgrade(req, socket, head)).catch((error) => {
    console.error('hii upgrade failed', error);
    socket.destroy();
  });
});

server.on('error', (error) => {
  console.error('hii server listen failed');
  console.error(error);
  process.exit(1);
});

console.log(`hii listening on ${host}:${port}`);
server.listen(port, host, () => {
  console.log(`hii ready on http://${host}:${port} (pty gateway at ws://${host}:${port}${PTY_PATH})`);
});
