import { spawn } from 'node:child_process';

import { listSpaces, readSpace, updateSpace } from '../server/space-store.ts';
import type { Space } from './types.ts';

export const DEFAULT_PUBLIC_HTTPS_PORT = 443;
export const DEFAULT_PUBLIC_LISTENER_PORT = 4313;
export const DEFAULT_TAILSCALE_BINARY = '/usr/local/bin/tailscale';

export type PublicationCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type PublicationCommandRunner = (
  binary: string,
  args: readonly string[]
) => Promise<PublicationCommandResult>;

export type PublicSpaceListener = {
  port: number;
  stop(): Promise<void>;
};

export type StartPublicSpaceListener = (input: {
  allowedHostname: string;
  spaceId: string;
  port: number;
}) => Promise<PublicSpaceListener>;

export type PublishResult = {
  space: Space;
  endpoint: string;
  provider: string;
  listenerPort: number;
};

type FunnelStatus = {
  Web?: Record<string, {
    Handlers?: Record<string, { Proxy?: string }>;
  }>;
};

type TailscaleStatus = FunnelStatus & {
  BackendState?: string;
  Self?: { DNSName?: string };
};

type ActivePublication = {
  externalPort: number;
  listener: PublicSpaceListener;
};

export class SpacePublicationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SpacePublicationError';
    this.code = code;
  }
}

export async function runPublicationCommand(
  binary: string,
  args: readonly string[]
): Promise<PublicationCommandResult> {
  return await new Promise((resolve, reject) => {
    const maxOutputBytes = 1024 * 1024;
    const child = spawn(binary, [...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new SpacePublicationError('PUBLICATION_PROVIDER_TIMEOUT', 'The publication provider did not respond in time.'));
    }, 10_000);
    timeout.unref?.();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const capture = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (!settled && outputBytes > maxOutputBytes) {
        settled = true;
        child.kill('SIGKILL');
        clearTimeout(timeout);
        reject(new SpacePublicationError('PUBLICATION_PROVIDER_OUTPUT_LIMIT', 'The publication provider returned too much output.'));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

export function funnelStatusArgs() {
  return ['funnel', 'status', '--json'] as const;
}

export function tailscaleStatusArgs() {
  return ['status', '--json'] as const;
}

export function funnelStartArgs(externalPort: number, localPort: number) {
  return [
    'funnel',
    '--bg',
    '--yes',
    `--https=${validatePort(externalPort, 'externalPort')}`,
    expectedProxy(validatePort(localPort, 'localPort'))
  ] as const;
}

export function funnelStopArgs(externalPort: number) {
  return ['funnel', `--https=${validatePort(externalPort, 'externalPort')}`, 'off'] as const;
}

export function expectedProxy(localPort: number) {
  return `http://127.0.0.1:${validatePort(localPort, 'localPort')}`;
}

export function funnelRoute(status: FunnelStatus, externalPort: number) {
  const suffix = `:${validatePort(externalPort, 'externalPort')}`;
  return Object.entries(status.Web ?? {}).find(([hostPort]) => hostPort.endsWith(suffix)) ?? null;
}

export function routeOwnedBy(status: FunnelStatus, externalPort: number, localPort: number) {
  const route = funnelRoute(status, externalPort);
  if (!route) return false;
  return Object.values(route[1].Handlers ?? {}).some(
    (handler) => handler.Proxy === expectedProxy(localPort)
  );
}

function validatePort(port: number, name: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 through 65535`);
  }
  return port;
}

function parseJson<T>(result: PublicationCommandResult, operation: string): T {
  if (result.code !== 0) {
    throw new SpacePublicationError(
      'PUBLICATION_PROVIDER_UNAVAILABLE',
      `${operation} failed.`
    );
  }
  try {
    return JSON.parse(result.stdout || '{}') as T;
  } catch {
    throw new SpacePublicationError(
      'PUBLICATION_PROVIDER_INVALID_RESPONSE',
      `${operation} returned invalid JSON.`
    );
  }
}

function publicHostname(raw: unknown) {
  if (typeof raw !== 'string') {
    throw new SpacePublicationError('PUBLICATION_PROVIDER_UNAVAILABLE', 'The provider did not report a public DNS name.');
  }
  const hostname = raw.replace(/\.$/, '').toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new SpacePublicationError('PUBLICATION_PROVIDER_INVALID_RESPONSE', 'The provider reported an invalid public DNS name.');
  }
  return hostname;
}

function safeError(caught: unknown) {
  return caught instanceof Error ? caught.message.slice(0, 500) : 'Publication failed.';
}

export type SpacePublisherOptions = {
  startPublicListener: StartPublicSpaceListener;
  run?: PublicationCommandRunner;
  provider?: 'tailscale-funnel';
  binary?: string;
  externalPort?: number;
  /** Stable loopback target used to recover exact route ownership after restart. */
  localPort?: number;
};

/**
 * Process-local publication coordinator.
 *
 * The durable Space record stores intent/result. Listener handles and provider
 * route ownership stay in memory because they are runtime resources, not Space
 * identity. A restarted process therefore never tears down a route unless it
 * can prove that the current process created and owns its exact loopback target.
 */
export class SpacePublisher {
  private readonly startPublicListener: StartPublicSpaceListener;
  private readonly run: PublicationCommandRunner;
  private readonly provider: 'tailscale-funnel';
  private readonly binary: string;
  private readonly externalPort: number;
  private readonly localPort: number;
  private readonly active = new Map<string, ActivePublication>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: SpacePublisherOptions) {
    this.startPublicListener = options.startPublicListener;
    this.run = options.run ?? runPublicationCommand;
    this.provider = options.provider ?? 'tailscale-funnel';
    this.binary = options.binary ?? DEFAULT_TAILSCALE_BINARY;
    this.externalPort = validatePort(options.externalPort ?? DEFAULT_PUBLIC_HTTPS_PORT, 'externalPort');
    this.localPort = validatePort(options.localPort ?? DEFAULT_PUBLIC_LISTENER_PORT, 'localPort');
  }

  publish(spaceId: string): Promise<PublishResult> {
    return this.enqueue(spaceId, () => this.publishNow(spaceId));
  }

  unpublish(spaceId: string): Promise<Space> {
    return this.enqueue(spaceId, () => this.unpublishNow(spaceId));
  }

  isActive(spaceId: string) {
    return this.active.has(spaceId);
  }

  /** Rebind the one durable published Space after a host-process restart. */
  async reconcile() {
    const published = (await listSpaces()).filter((space) => space.publicationState === 'published');
    if (published.length > 1) {
      throw new SpacePublicationError(
        'PUBLICATION_SLOT_CONFLICT',
        'This HII node currently supports one published Space at a time.'
      );
    }
    if (published.length === 0) return null;
    return this.publish(published[0].id);
  }

  async close() {
    const ids = [...this.active.keys()];
    const results = await Promise.allSettled(ids.map(async (spaceId) => {
      try {
        await this.unpublish(spaceId);
      } catch (caught) {
        const active = this.active.get(spaceId);
        await active?.listener.stop().catch(() => undefined);
        this.active.delete(spaceId);
        throw caught;
      }
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  private enqueue<T>(spaceId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(spaceId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.queues.set(spaceId, next);
    void next.finally(() => {
      if (this.queues.get(spaceId) === next) this.queues.delete(spaceId);
    }).catch(() => undefined);
    return next;
  }

  private async providerStatus() {
    return parseJson<TailscaleStatus>(
      await this.run(this.binary, tailscaleStatusArgs()),
      'Tailscale status'
    );
  }

  private async currentFunnelStatus() {
    return parseJson<FunnelStatus>(
      await this.run(this.binary, funnelStatusArgs()),
      'Funnel status'
    );
  }

  private async publishNow(spaceId: string): Promise<PublishResult> {
    const original = await readSpace(spaceId);
    const existing = this.active.get(spaceId);
    if (existing && original.publication.state === 'published' && original.publication.endpoint) {
      return {
        space: original,
        endpoint: original.publication.endpoint,
        provider: this.provider,
        listenerPort: existing.listener.port
      };
    }
    const otherPublished = (await listSpaces()).find(
      (space) => space.id !== original.id && space.publicationState === 'published'
    );
    if (otherPublished) {
      throw new SpacePublicationError(
        'PUBLICATION_SLOT_OCCUPIED',
        `Space ${otherPublished.id} already owns this node's public publication slot.`
      );
    }

    let listener: PublicSpaceListener | undefined;
    let recovering = false;
    try {
      const status = await this.providerStatus();
      if (status.BackendState !== 'Running') {
        throw new SpacePublicationError('PUBLICATION_PROVIDER_OFFLINE', 'Tailscale is not connected.');
      }
      const hostname = publicHostname(status.Self?.DNSName);
      const before = await this.currentFunnelStatus();
      recovering = Boolean(
        funnelRoute(before, this.externalPort) &&
        original.publication.state === 'published' &&
        original.publication.provider === this.provider &&
        routeOwnedBy(before, this.externalPort, this.localPort)
      );
      if (funnelRoute(before, this.externalPort) && !recovering) {
        throw new SpacePublicationError(
          'PUBLICATION_ROUTE_OCCUPIED',
          `The provider HTTPS port ${this.externalPort} is already configured.`
        );
      }

      listener = await this.startPublicListener({ allowedHostname: hostname, spaceId: original.id, port: this.localPort });
      validatePort(listener.port, 'listener port');
      if (listener.port !== this.localPort) {
        throw new SpacePublicationError('PUBLICATION_LISTENER_MISMATCH', 'The public listener did not bind its stable recovery port.');
      }
      if (!recovering) {
        const started = await this.run(this.binary, funnelStartArgs(this.externalPort, listener.port));
        if (started.code !== 0) {
          throw new SpacePublicationError('PUBLICATION_START_FAILED', 'Funnel start failed.');
        }
      }
      const after = await this.currentFunnelStatus();
      if (!routeOwnedBy(after, this.externalPort, listener.port)) {
        throw new SpacePublicationError('PUBLICATION_ROUTE_UNVERIFIED', 'The provider did not expose the Space listener.');
      }

      const endpoint = `https://${hostname}/s/${original.id}`;
      const space = await updateSpace(original.id, {
        hosting: 'published',
        publication: {
          state: 'published',
          endpoint,
          provider: this.provider,
          error: undefined
        }
      }, original.revision);
      this.active.set(original.id, { externalPort: this.externalPort, listener });
      return { space, endpoint, provider: this.provider, listenerPort: listener.port };
    } catch (caught) {
      if (listener && !recovering) {
        try {
          const status = await this.currentFunnelStatus();
          if (routeOwnedBy(status, this.externalPort, listener.port)) {
            await this.run(this.binary, funnelStopArgs(this.externalPort));
          }
        } catch {
          // The durable failed state below is the recovery signal. Never issue
          // a broad reset, and never guess route ownership during rollback.
        }
      }
      await listener?.stop().catch(() => undefined);
      if (recovering) throw caught;
      await updateSpace(original.id, {
        hosting: 'local-only',
        publication: {
          state: 'failed',
          endpoint: undefined,
          provider: this.provider,
          error: safeError(caught)
        }
      }).catch(() => undefined);
      throw caught;
    }
  }

  private async unpublishNow(spaceId: string): Promise<Space> {
    const current = await readSpace(spaceId);
    const active = this.active.get(spaceId);
    if (!active) {
      const status = await this.currentFunnelStatus();
      const route = funnelRoute(status, this.externalPort);
      if (
        route &&
        current.publication.state === 'published' &&
        current.publication.provider === this.provider &&
        routeOwnedBy(status, this.externalPort, this.localPort)
      ) {
        const stopped = await this.run(this.binary, funnelStopArgs(this.externalPort));
        if (stopped.code !== 0) throw new SpacePublicationError('PUBLICATION_STOP_FAILED', 'Funnel stop failed.');
      } else if (route) {
        throw new SpacePublicationError(
          'PUBLICATION_ROUTE_NOT_OWNED',
          'HII will not remove a provider route that this process cannot prove it owns.'
        );
      }
      return updateSpace(spaceId, {
        hosting: 'local-only',
        publication: { state: 'unpublished', endpoint: undefined, provider: undefined, error: undefined }
      });
    }

    const status = await this.currentFunnelStatus();
    const route = funnelRoute(status, active.externalPort);
    if (route && !routeOwnedBy(status, active.externalPort, active.listener.port)) {
      throw new SpacePublicationError(
        'PUBLICATION_ROUTE_NOT_OWNED',
        'HII refused to remove a provider route whose loopback target changed.'
      );
    }
    if (route) {
      const stopped = await this.run(this.binary, funnelStopArgs(active.externalPort));
      if (stopped.code !== 0) {
        throw new SpacePublicationError(
          'PUBLICATION_STOP_FAILED',
          'Funnel stop failed.'
        );
      }
    }
    await active.listener.stop();
    this.active.delete(spaceId);
    return updateSpace(spaceId, {
      hosting: 'local-only',
      publication: { state: 'unpublished', endpoint: undefined, provider: undefined, error: undefined }
    });
  }
}
