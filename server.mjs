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
