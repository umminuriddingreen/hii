import { createServer } from 'http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { attachPtyGateway, isLocalRequest } from './server/pty-gateway.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT || 3000);
const PTY_PATH = '/api/pty';

const app = next({ dev });
const handle = app.getRequestHandler();

await app.prepare();

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

server.listen(port, () => {
  console.log(`hii ready on http://localhost:${port} (pty gateway at ws://localhost:${port}${PTY_PATH})`);
});
