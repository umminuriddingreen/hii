import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMFYUI_APP = '/Applications/ComfyUI.app';
const COMFYUI_URL = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8000';
const COMFYUI_LOG = path.join(os.homedir(), 'Library', 'Logs', 'ComfyUI', 'comfyui.log');
const MCP_SERVER_DIR = '/Volumes/JBDRIVE/hii/comfyui-mcp-server';
const MCP_PORT = 9000;
const HII_DIR = path.join(os.homedir(), '.hii');
const PID_FILE = path.join(HII_DIR, 'comfyui-mcp.pid');
const MCP_LOG = path.join(HII_DIR, 'comfyui-mcp.log');

function ensureDir() { fs.mkdirSync(HII_DIR, { recursive: true }); }

function readPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function httpGet(url: string, ms = 4000): Promise<{ ok: boolean; status: number; body?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
  } catch { return { ok: false, status: 0 }; }
}

function findPython(): string {
  for (const b of ['python3', 'python']) {
    try { execSync(`which ${b}`, { stdio: 'pipe' }); return b; } catch {}
  }
  throw new Error('python3 not found');
}

// ── status ────────────────────────────────────────────────────────────────────

export async function comfyuiStatus(): Promise<void> {
  console.log('\n── ComfyUI status ─────────────────────────────────────────');

  const r = await httpGet(`${COMFYUI_URL}/system_stats`);
  if (r.ok) {
    try {
      const d = JSON.parse(r.body ?? '{}');
      const dev = d?.devices?.[0];
      const free = dev ? `  VRAM ${(dev.vram_free / 1e9).toFixed(1)}GB free / ${(dev.vram_total / 1e9).toFixed(1)}GB total` : '';
      console.log(`✅ ComfyUI (local)    ${COMFYUI_URL}${free}`);
    } catch { console.log(`✅ ComfyUI (local)    ${COMFYUI_URL}`); }
  } else {
    console.log(`⬜ ComfyUI (local)    ${COMFYUI_URL} — not running`);
    console.log(`   Start with: hii comfyui start`);
  }

  const pid = readPid();
  if (pid && isRunning(pid)) {
    const mcp = await httpGet(`http://127.0.0.1:${MCP_PORT}/mcp`);
    console.log(`✅ MCP server         pid ${pid}  :${MCP_PORT}  ${mcp.ok ? 'up' : 'starting…'}`);
  } else {
    console.log(`⬜ MCP server         not running`);
    if (pid) fs.rmSync(PID_FILE, { force: true });
  }

  if (fs.existsSync(COMFYUI_LOG)) console.log(`   ComfyUI log → ${COMFYUI_LOG}`);
  if (fs.existsSync(MCP_LOG))     console.log(`   MCP log     → ${MCP_LOG}`);
  console.log();
}

// ── start ─────────────────────────────────────────────────────────────────────

export async function comfyuiStart(opts: { noMcp?: boolean } = {}): Promise<void> {
  ensureDir();

  // 1. Check if ComfyUI is already running
  const alive = await httpGet(`${COMFYUI_URL}/system_stats`);
  if (alive.ok) {
    try {
      const dev = JSON.parse(alive.body ?? '{}')?.devices?.[0];
      const mem = dev ? ` — ${(dev.vram_free / 1e9).toFixed(1)}GB VRAM free` : '';
      console.log(`✅ ComfyUI already running at ${COMFYUI_URL}${mem}`);
    } catch { console.log(`✅ ComfyUI already running at ${COMFYUI_URL}`); }
  } else {
    // 2. Launch the app
    if (!fs.existsSync(COMFYUI_APP)) {
      console.error(`❌ ${COMFYUI_APP} not found.`);
      process.exit(1);
    }
    console.log(`🚀 Launching ComfyUI…`);
    execSync(`open -a "${COMFYUI_APP}"`, { stdio: 'ignore' });

    // 3. Wait for it to come up (up to 30s)
    process.stdout.write('   Waiting for ComfyUI');
    let up = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      process.stdout.write('.');
      const check = await httpGet(`${COMFYUI_URL}/system_stats`, 1500);
      if (check.ok) { up = true; break; }
    }
    console.log();
    if (!up) {
      console.warn(`⚠️  ComfyUI didn't respond within 30s — may still be loading.`);
      console.warn(`   Check: open http://127.0.0.1:8000`);
    } else {
      console.log(`✅ ComfyUI is up at ${COMFYUI_URL}`);
    }
  }

  if (opts.noMcp) return;

  // 4. Start MCP server
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`ℹ️  MCP server already running (pid ${existingPid})`);
    return;
  }

  if (!fs.existsSync(MCP_SERVER_DIR)) {
    console.warn(`⚠️  MCP server not found at ${MCP_SERVER_DIR} — skipping.`);
    return;
  }

  const python = findPython();
  try {
    execSync(`${python} -c "import mcp, requests"`, { stdio: 'pipe' });
  } catch {
    console.log('Installing MCP server deps…');
    execSync(`${python} -m pip install -r ${path.join(MCP_SERVER_DIR, 'requirements.txt')} -q`, {
      stdio: 'inherit', cwd: MCP_SERVER_DIR,
    });
  }

  const logFd = fs.openSync(MCP_LOG, 'a');
  const child = spawn(python, ['server.py'], {
    cwd: MCP_SERVER_DIR,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, COMFYUI_URL, PORT: String(MCP_PORT) },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  fs.closeSync(logFd);
  console.log(`🚀 MCP server started  pid ${child.pid}  :${MCP_PORT}`);
  console.log(`   Logs → ${MCP_LOG}`);
}

// ── stop ──────────────────────────────────────────────────────────────────────

export function comfyuiStop(): void {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log('MCP server is not running.');
    if (pid) fs.rmSync(PID_FILE, { force: true });
    return;
  }
  process.kill(pid, 'SIGTERM');
  fs.rmSync(PID_FILE, { force: true });
  console.log(`✅ Stopped MCP server (pid ${pid})`);
}

// ── logs ──────────────────────────────────────────────────────────────────────

export function comfyuiLogs(lines = 80, target: 'comfyui' | 'mcp' = 'comfyui'): void {
  const file = target === 'comfyui' ? COMFYUI_LOG : MCP_LOG;
  if (!fs.existsSync(file)) { console.log(`No log yet: ${file}`); return; }
  const out = execSync(`tail -n ${lines} "${file}"`, { encoding: 'utf8' });
  console.log(out);
}

// ── models ────────────────────────────────────────────────────────────────────

export async function comfyuiModels(): Promise<void> {
  const res = await httpGet(`${COMFYUI_URL}/object_info`, 6000);
  if (!res.ok) { console.error(`❌ ComfyUI unreachable — ${COMFYUI_URL}`); return; }
  const models: string[] = JSON.parse(res.body ?? '{}')?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  if (!models.length) { console.log('No checkpoint models found.'); return; }
  console.log(`\n${models.length} checkpoint model(s):`);
  models.forEach(m => console.log(`  ${m}`));
  console.log();
}
