import { spawn } from 'node:child_process';

export async function runShell(cmd: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>{
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

