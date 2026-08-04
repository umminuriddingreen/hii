import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { attachPtyGateway, isLocalRequest } from './server/pty-gateway.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const hiiTarget = process.env.HII_TARGET === 'desktop' ? 'desktop' : 'web';
const hiiDeployTarget = process.env.HII_DEPLOY_TARGET === 'cloudflare' ? 'cloudflare' : 'local';

function hiiPtyGateway(): Plugin {
  return {
    name: 'hii-pty-gateway',
    configureServer(vite) {
      if (!vite.httpServer) return;
      const wss = new WebSocketServer({ noServer: true });
      attachPtyGateway(wss);
      const upgrade = (request: Parameters<typeof isLocalRequest>[0], socket: any, head: Buffer) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname !== '/api/pty') return;
        if (!isLocalRequest(request)) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
      };
      vite.httpServer.prependListener('upgrade', upgrade);
      return () => {
        vite.httpServer?.off('upgrade', upgrade);
        wss.close();
      };
    }
  };
}

export default defineConfig({
  define: {
    __HII_TARGET__: JSON.stringify(hiiTarget),
    __HII_DEPLOY_TARGET__: JSON.stringify(hiiDeployTarget)
  },
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  plugins: [sveltekit(), hiiPtyGateway()],
  resolve: {
    alias: [
      { find: 'next/server', replacement: `${root}src/lib/next-server-compat.ts` },
      { find: 'next/headers', replacement: `${root}src/lib/next-headers-compat.ts` },
      { find: 'server-only', replacement: `${root}src/lib/server-only.ts` },
      { find: /^@\//, replacement: `${root}` }
    ]
  },
  server: {
    host: '127.0.0.1',
    allowedHosts: ['humaninformationinterface.com', 'www.humaninformationinterface.com']
  },
  ssr: {
    noExternal: true,
    // These packages publish CommonJS Node entries. Keep them external so
    // Vite's SSR evaluator uses Node's ESM/CJS interop instead of inlining
    // their `require` calls into Desk-hosted same-origin surfaces.
    external: ['yaml', 'qs', 'ws']
  }
});
