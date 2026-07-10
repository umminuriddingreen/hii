import { createServer } from 'http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { attachPtyGateway, isLocalRequest } from './server/pty-gateway.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const PTY_PATH = '/api/pty';

const app = next({ dev });
const handle = app.getRequestHandler();

try {
  console.log(
    `hii preparing ${dev ? 'development' : 'production'} server on ${host}:${port}`
  );
  await app.prepare();
} catch (error) {
  console.error('hii server prepare failed');
  console.error(error);
  process.exit(1);
}

const server = createServer((req, res) => handle(req, res));

// Next lazily attaches its own 'upgrade' listener (for HMR/routing) after the
// first request. Wrap every upgrade listener registered by anyone else so the
// PTY path never reaches Next — otherwise it writes to (and corrupts) our
// websocket. Our own handler is registered with the raw method below.
const rawOn = server.on.bind(server);
const guard = (listener) => (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === PTY_PATH) return;
  listener(req, socket, head);
};
for (const method of ['on', 'addListener', 'prependListener']) {
  const original = server[method].bind(server);
  server[method] = (event, listener) => (event === 'upgrade' ? original(event, guard(listener)) : original(event, listener));
}

const wss = new WebSocketServer({ noServer: true });
attachPtyGateway(wss);

rawOn('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname !== PTY_PATH) return; // Next's own listener handles HMR etc.
  if (!isLocalRequest(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
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
