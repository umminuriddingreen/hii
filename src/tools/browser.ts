import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function hiiRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
}

export function getAgentBrowserBin(): string {
  const bin = path.resolve(hiiRoot(), 'node_modules', '.bin', 'agent-browser');
  if (!fs.existsSync(bin)) {
    throw new Error('agent-browser is not installed in this hii project. Run: npm install agent-browser');
  }
  return bin;
}

export async function runAgentBrowser(args: string[], opts?: { stdio?: 'pipe' | 'inherit'; cwd?: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bin = getAgentBrowserBin();

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts?.cwd || process.cwd(),
      stdio: opts?.stdio === 'inherit' ? 'inherit' : 'pipe',
      env: process.env,
    });

    if (opts?.stdio === 'inherit') {
      proc.on('close', (code) => resolve({ code, stdout: '', stderr: '' }));
      proc.on('error', reject);
      return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}
