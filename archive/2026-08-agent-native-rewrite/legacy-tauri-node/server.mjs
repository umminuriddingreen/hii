// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { WebSocketServer } from 'ws';
import { attachPtyGateway, isLocalRequest } from './server/pty-gateway.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = createServer((request, response) => {
  Promise.resolve(handler(request, response)).catch((error) => {
    console.error('hii request failed', error);
    if (!response.headersSent) response.statusCode = 500;
    if (!response.writableEnded) response.end('Internal Server Error');
  });
});

const wss = new WebSocketServer({ noServer: true });
attachPtyGateway(wss);
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/api/pty' || !isLocalRequest(request)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
});
server.on('error', (error) => {
  console.error('hii server listen failed', error);
  process.exit(1);
});
server.listen(port, host, () => console.log(`hii ready on http://${host}:${port} (SvelteKit + Vite)`));

// The desktop app spawns this process and stops it when it exits. A crash or a
// Force Quit never reaches that handler, and what survived was a headless server
// reparented to launchd, still bound to its port and still holding the user's
// runtime open with no window anywhere. Outliving the application that started
// it is never correct, so the supervisor is watched rather than trusted to say
// goodbye.
const supervisor = Number(process.env.HII_SUPERVISOR_PID || 0);
if (supervisor > 0) {
  const watch = setInterval(() => {
    try {
      process.kill(supervisor, 0);
    } catch {
      console.log(`hii supervisor ${supervisor} is gone; shutting down`);
      server.close(() => process.exit(0));
      // A held-open connection must not keep an orphan alive indefinitely.
      setTimeout(() => process.exit(0), 2000).unref();
      clearInterval(watch);
    }
  }, 2000);
  watch.unref();
}
