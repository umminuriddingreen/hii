import type { RequestHandler } from './$types';
import * as boardTasks from '@/app/api/board/tasks/route';
import * as browseCheck from '@/app/api/browse/check/route';
import * as capabilities from '@/app/api/capabilities/route';
import * as config from '@/app/api/config/route';
import * as context from '@/app/api/context/route';
import * as daemonRun from '@/app/api/daemon/runs/[id]/route';
import * as daemon from '@/app/api/daemon/route';
import * as filesOpen from '@/app/api/files/open/route';
import * as knowledge from '@/app/api/knowledge/route';
import * as links from '@/app/api/links/route';
import * as ogStatus from '@/app/api/og/status/route';
import * as runnerHeartbeat from '@/app/api/runners/heartbeat/route';
import * as runnerComplete from '@/app/api/runners/jobs/[id]/complete/route';
import * as runnerEvents from '@/app/api/runners/jobs/[id]/events/route';
import * as runnerNext from '@/app/api/runners/jobs/next/route';
import * as search from '@/app/api/search/route';
import * as skills from '@/app/api/skills/route';
import * as terminalSessions from '@/app/api/terminal/sessions/route';
import * as terminalStream from '@/app/api/terminal/stream/route';
import * as workspaceAsset from '@/app/api/workspace/assets/[name]/route';
import * as workspaceAssets from '@/app/api/workspace/assets/route';
import * as workspaceRuns from '@/app/api/workspace/runs/route';
import * as workspaceSnapshot from '@/app/api/workspace/snapshot/route';
import * as workspaceWindows from '@/app/api/workspace/windows/route';
import * as workspace from '@/app/api/workspace/route';

type LegacyHandler = (request: Request, context: { params: Record<string, string> }) => Response | Promise<Response>;
type LegacyModule = Record<string, unknown>;

const routes: Array<{ pattern: RegExp; module: LegacyModule; keys?: string[] }> = [
  { pattern: /^board\/tasks$/, module: boardTasks },
  { pattern: /^browse\/check$/, module: browseCheck },
  { pattern: /^capabilities$/, module: capabilities },
  { pattern: /^config$/, module: config },
  { pattern: /^context$/, module: context },
  { pattern: /^daemon\/runs\/([^/]+)$/, module: daemonRun, keys: ['id'] },
  { pattern: /^daemon$/, module: daemon },
  { pattern: /^files\/open$/, module: filesOpen },
  { pattern: /^knowledge$/, module: knowledge },
  { pattern: /^links$/, module: links },
  { pattern: /^og\/status$/, module: ogStatus },
  { pattern: /^runners\/heartbeat$/, module: runnerHeartbeat },
  { pattern: /^runners\/jobs\/([^/]+)\/complete$/, module: runnerComplete, keys: ['id'] },
  { pattern: /^runners\/jobs\/([^/]+)\/events$/, module: runnerEvents, keys: ['id'] },
  { pattern: /^runners\/jobs\/next$/, module: runnerNext },
  { pattern: /^search$/, module: search },
  { pattern: /^skills$/, module: skills },
  { pattern: /^terminal\/sessions$/, module: terminalSessions },
  { pattern: /^terminal\/stream$/, module: terminalStream },
  { pattern: /^workspace\/assets\/([^/]+)$/, module: workspaceAsset, keys: ['name'] },
  { pattern: /^workspace\/assets$/, module: workspaceAssets },
  { pattern: /^workspace\/runs$/, module: workspaceRuns },
  { pattern: /^workspace\/snapshot$/, module: workspaceSnapshot },
  { pattern: /^workspace\/windows$/, module: workspaceWindows },
  { pattern: /^workspace$/, module: workspace }
];

const dispatch = (method: string): RequestHandler => async (event) => {
  const path = event.params.path ?? '';
  for (const route of routes) {
    const match = path.match(route.pattern);
    if (!match) continue;
    const handler = route.module[method] as LegacyHandler | undefined;
    if (!handler) return new Response('Method Not Allowed', { status: 405 });
    const params = Object.fromEntries((route.keys ?? []).map((key, index) => [key, decodeURIComponent(match[index + 1])]));
    const request = event.request as Request & { nextUrl?: URL };
    Object.defineProperty(request, 'nextUrl', { value: event.url, configurable: true });
    return handler(request, { params });
  }
  return new Response('Not Found', { status: 404 });
};

export const GET = dispatch('GET');
export const POST = dispatch('POST');
export const PUT = dispatch('PUT');
export const PATCH = dispatch('PATCH');
export const DELETE = dispatch('DELETE');
