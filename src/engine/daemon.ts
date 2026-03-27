/**
 * HII Persistence Engine — Self-Healing Unix Daemon
 *
 * Runs as a background process. Monitors child workers via heartbeat.
 * If a worker dies, it restarts. If the daemon itself dies, launchd/cron
 * can restart it (see hii daemon install).
 *
 * Design: minimal, unix-native. PID files, signals, stdout logs.
 * No heavy frameworks. Every byte earns its place.
 */

import { fork, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const PID_FILE = path.join(HII_DIR, 'daemon.pid');
const LOG_FILE = path.join(HII_DIR, 'daemon.log');
const HEARTBEAT_INTERVAL = 10_000; // 10s
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_BASE = 2_000; // 2s * attempt

export interface WorkerSpec {
  id: string;
  script: string;        // path to .js file to fork
  args?: string[];
  env?: Record<string, string>;
  restartOnCrash: boolean;
}

interface WorkerState {
  spec: WorkerSpec;
  process: ChildProcess | null;
  pid: number | null;
  restarts: number;
  lastStart: number;
  healthy: boolean;
}

export class Daemon extends EventEmitter {
  private workers = new Map<string, WorkerState>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor() {
    super();
    fs.mkdirSync(HII_DIR, { recursive: true });
  }

  /** Write PID, start heartbeat, register signal handlers */
  start(): void {
    if (this.running) return;
    this.running = true;

    fs.writeFileSync(PID_FILE, String(process.pid));
    this.log(`daemon started pid=${process.pid}`);

    // Self-healing: handle signals gracefully
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
      this.log(`uncaught: ${err.message}`);
      // Don't die — log and continue
    });

    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL);
    this.emit('started');
  }

  shutdown(reason: string): void {
    this.log(`shutdown reason=${reason}`);
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    // Kill all workers
    for (const [id, state] of this.workers) {
      if (state.process && !state.process.killed) {
        state.process.kill('SIGTERM');
        this.log(`killed worker=${id} pid=${state.pid}`);
      }
    }

    // Clean PID file
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }

  /** Register and spawn a worker */
  spawn(spec: WorkerSpec): void {
    if (this.workers.has(spec.id)) {
      this.log(`worker ${spec.id} already registered, restarting`);
      this.killWorker(spec.id);
    }

    const state: WorkerState = {
      spec,
      process: null,
      pid: null,
      restarts: 0,
      lastStart: 0,
      healthy: false,
    };
    this.workers.set(spec.id, state);
    this.startWorker(state);
  }

  private startWorker(state: WorkerState): void {
    if (!this.running) return;

    const { spec } = state;
    this.log(`spawning worker=${spec.id} script=${spec.script}`);

    const child = fork(spec.script, spec.args || [], {
      env: { ...process.env, ...spec.env, HII_WORKER_ID: spec.id },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });

    state.process = child;
    state.pid = child.pid ?? null;
    state.lastStart = Date.now();
    state.healthy = true;

    child.stdout?.on('data', (d) => this.log(`[${spec.id}] ${d.toString().trim()}`));
    child.stderr?.on('data', (d) => this.log(`[${spec.id}:err] ${d.toString().trim()}`));

    child.on('exit', (code, signal) => {
      state.healthy = false;
      state.process = null;
      this.log(`worker=${spec.id} exited code=${code} signal=${signal}`);

      if (spec.restartOnCrash && this.running) {
        state.restarts++;
        if (state.restarts <= MAX_RESTART_ATTEMPTS) {
          const delay = RESTART_BACKOFF_BASE * state.restarts;
          this.log(`restarting worker=${spec.id} attempt=${state.restarts}/${MAX_RESTART_ATTEMPTS} in ${delay}ms`);
          setTimeout(() => this.startWorker(state), delay);
        } else {
          this.log(`worker=${spec.id} exceeded max restarts, giving up`);
          this.emit('worker-failed', spec.id);
        }
      }
    });

    // Reset restart counter if worker survives 60s
    setTimeout(() => {
      if (state.healthy && state.process && !state.process.killed) {
        state.restarts = 0;
      }
    }, 60_000);

    this.emit('worker-spawned', spec.id, child.pid);
  }

  killWorker(id: string): void {
    const state = this.workers.get(id);
    if (state?.process && !state.process.killed) {
      state.spec.restartOnCrash = false; // prevent restart loop
      state.process.kill('SIGTERM');
    }
    this.workers.delete(id);
  }

  /** Heartbeat: check all workers alive */
  private heartbeat(): void {
    for (const [id, state] of this.workers) {
      if (!state.process || state.process.killed) {
        if (state.spec.restartOnCrash && state.restarts <= MAX_RESTART_ATTEMPTS) {
          this.log(`heartbeat: worker=${id} dead, triggering restart`);
          this.startWorker(state);
        }
      }
    }
  }

  status(): { pid: number; workers: { id: string; pid: number | null; healthy: boolean; restarts: number }[] } {
    return {
      pid: process.pid,
      workers: [...this.workers.entries()].map(([id, s]) => ({
        id,
        pid: s.pid,
        healthy: s.healthy,
        restarts: s.restarts,
      })),
    };
  }

  log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
  }
}

/** Check if daemon is running by reading PID file */
export function isDaemonRunning(): { running: boolean; pid?: number } {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
    // Check if process exists
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/** Read daemon logs */
export function readLogs(lines = 50): string {
  try {
    const all = fs.readFileSync(LOG_FILE, 'utf-8').split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(no logs)';
  }
}
