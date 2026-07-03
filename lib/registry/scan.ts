import { RegistrySnapshot } from "./types";
import { scanMachine } from "./scanners/machine";
import { scanHermes } from "./scanners/hermes";
import { scanCodex } from "./scanners/codex";
import { scanOllama } from "./scanners/ollama";

export function scanRegistry(): RegistrySnapshot {
  const machine = scanMachine();
  const hermes = scanHermes(machine.id);
  const codex = scanCodex(machine.id);
  const ollama = scanOllama(machine.id);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    machine,
    agents: [hermes.agent, codex.agent],
    providers: [...hermes.providers, ...codex.providers, ...ollama.providers],
    models: [...ollama.models],
    mcpServers: [],
    secrets: [...hermes.secrets, ...codex.secrets],
    warnings: [...ollama.warnings]
  };
}
