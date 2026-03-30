/**
 * HII Agent Delegator
 *
 * RULE: Local models are DUMB. They execute predetermined scripts ONLY.
 * Never send free-form reasoning to local models.
 *
 * Agent types:
 * - 'runner': executes a shell script/command and returns output
 * - 'watcher': monitors a file/process/URL and reports changes
 * - 'syncer': runs sync operations (git pull, obsidian sync, etc.)
 *
 * All agents are managed by the daemon. They are child processes
 * that run a script, report back, and exit (or loop for watchers).
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chatWithConfig } from '../clients/chat.js';
import { loadConfig } from '../config.js';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const AGENTS_FILE = path.join(HII_DIR, 'agents.json');

export type AgentType = 'runner' | 'watcher' | 'syncer';

export interface AgentSpec {
  id: string;
  name: string;
  type: AgentType;
  /** The EXACT command to run. No interpretation. */
  command: string;
  args?: string[];
  /** For watchers: interval in ms */
  interval?: number;
  /** Working directory */
  cwd?: string;
  active: boolean;
  createdAt: string;
}

export interface AgentResult {
  agentId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: string;
}

function loadAgents(): AgentSpec[] {
  try {
    return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveAgents(agents: AgentSpec[]): void {
  fs.mkdirSync(HII_DIR, { recursive: true });
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

export function registerAgent(spec: Omit<AgentSpec, 'id' | 'createdAt' | 'active'>): AgentSpec {
  const agents = loadAgents();
  const agent: AgentSpec = {
    ...spec,
    id: Math.random().toString(36).slice(2, 10),
    active: true,
    createdAt: new Date().toISOString(),
  };
  agents.push(agent);
  saveAgents(agents);
  return agent;
}

export function listAgents(filter?: { type?: AgentType; active?: boolean }): AgentSpec[] {
  let agents = loadAgents();
  if (filter?.type) agents = agents.filter(a => a.type === filter.type);
  if (filter?.active !== undefined) agents = agents.filter(a => a.active === filter.active);
  return agents;
}

export function deactivateAgent(id: string): void {
  const agents = loadAgents();
  const agent = agents.find(a => a.id === id);
  if (agent) agent.active = false;
  saveAgents(agents);
}

/** Run an agent's command synchronously and return result */
export function runAgent(spec: AgentSpec): Promise<AgentResult> {
  return new Promise((resolve) => {
    const proc = spawn(spec.command, spec.args || [], {
      cwd: spec.cwd || process.cwd(),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000, // 1 min max for runners
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({
        agentId: spec.id,
        stdout: stdout.slice(0, 10_000), // cap output
        stderr: stderr.slice(0, 5_000),
        exitCode: code,
        timestamp: new Date().toISOString(),
      });
    });

    proc.on('error', (err) => {
      resolve({
        agentId: spec.id,
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/**
 * Format agent result for local model consumption.
 * Local models get structured output to parse — no thinking required.
 */
export async function localModelSummarize(model: string, agentResult: AgentResult): Promise<string> {
  // Only use local model for FORMATTING, not reasoning
  const prompt = `Format this command output as a brief status report. Do not analyze or interpret, just summarize what happened:\n\nExit code: ${agentResult.exitCode}\nStdout: ${agentResult.stdout.slice(0, 2000)}\nStderr: ${agentResult.stderr.slice(0, 500)}`;

  try {
    const cfg = { ...loadConfig(), baseModel: model };
    const { text } = await chatWithConfig(cfg, [
      { role: 'system', content: 'You are a formatter. Output brief status reports. No analysis. No opinions. Just facts.' },
      { role: 'user', content: prompt },
    ], { temperature: 0 });
    return text;
  } catch {
    // Fallback: just return raw output if local model is down
    return `exit=${agentResult.exitCode} out=${agentResult.stdout.slice(0, 500)}`;
  }
}
