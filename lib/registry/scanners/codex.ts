import { RegistryAgent, RegistryProvider, RegistrySecretRef } from "../types";
import { fileExists, homePath, readTextIfExists } from "../local-files";

function matchTomlScalar(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m");
  return text.match(re)?.[1]?.trim();
}

export function scanCodex(machineId: string): {
  agent: RegistryAgent;
  providers: RegistryProvider[];
  secrets: RegistrySecretRef[];
} {
  const configPath = homePath(".codex", "config.toml");
  const authPath = homePath(".codex", "auth.json");
  const memoryPath = homePath(".codex", "memories", "MEMORY.md");
  const config = readTextIfExists(configPath);
  const warnings: string[] = [];

  if (!config) warnings.push("Codex config.toml not found");

  const model = config ? matchTomlScalar(config, "model") : undefined;
  const provider = config ? matchTomlScalar(config, "model_provider") : undefined;
  const providerId = provider ? `codex-${provider}` : undefined;

  return {
    agent: {
      id: "codex-local",
      kind: "codex",
      machineId,
      configPath,
      status: config ? "configured" : "missing",
      modelRef: model,
      providerRef: providerId,
      memoryBackend: fileExists(memoryPath) ? "codex-local-memory" : undefined,
      warnings
    },
    providers: providerId
      ? [{
          id: providerId,
          kind: provider || "unknown",
          machineId,
          visibility: "private",
          status: "configured"
        }]
      : [],
    secrets: [{
      id: "codex-auth-json",
      kind: "oauth",
      location: "local_file",
      path: authPath,
      syncPolicy: "do_not_sync_secret",
      status: fileExists(authPath) ? "present" : "missing"
    }]
  };
}
