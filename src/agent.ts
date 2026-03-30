import type { ChatMessage } from './clients/chat.js';
import type { Config } from './config.js';
import { orchestrateIntent, type OrchestratorOptions } from './orchestrator.js';

export type AgentLoopOptions = OrchestratorOptions;

export type AgentTurnResult = {
  text: string;
  messages: ChatMessage[];
  usedTools: string[];
};

export async function agentTurn(cfg: Config, prompt: string, opts?: AgentLoopOptions): Promise<AgentTurnResult> {
  const result = await orchestrateIntent(cfg, prompt, opts);
  return {
    text: result.text,
    messages: result.messages,
    usedTools: result.usedTools,
  };
}

export async function agentLoop(cfg: Config, prompt: string, opts?: AgentLoopOptions): Promise<string> {
  const result = await orchestrateIntent(cfg, prompt, opts);
  return result.text;
}
