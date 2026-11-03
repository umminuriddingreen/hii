import { RegistryAgent, RegistryProvider, RegistrySecretRef } from "../types";
import { fileExists, homePath, readTextIfExists } from "../local-files";

function matchYamlScalar(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n#]+)["']?`, "m");
  return text.match(re)?.[1]?.trim();
}

export function scanHermes(machineId: string): {
  agent: RegistryAgent;
  providers: RegistryProvider[];
  secrets: RegistrySecretRef[];
} {
  const configPath = homePath(".hermes", "config.yaml");
  const authPath = homePath(".hermes", "auth.json");
  const config = readTextIfExists(configPath);
  const warnings: string[] = [];

  if (!config) warnings.push("Hermes config.yaml not found");

  const model = config ? matchYamlScalar(config, "default") : undefined;
  const provider = config ? matchYamlScalar(config, "provider") : undefined;
  const baseUrl = config ? matchYamlScalar(config, "base_url") : undefined;

  const providerId = provider ? `hermes-${provider}` : undefined;

  return {
    agent: {
      id: "hermes-default",
      kind: "hermes",
      machineId,
      profile: "default",
      configPath,
      status: config ? "configured" : "missing",
      modelRef: model,
      providerRef: providerId,
      memoryBackend: "hermes-local",
      warnings
    },
    providers: providerId
      ? [{
          id: providerId,
          kind: provider || "unknown",
          baseUrl,
          machineId,
          visibility: baseUrl?.includes("127.0.0.1") ? "local_only" : "private",
          status: "configured"
        }]
      : [],
    secrets: [{
      id: "hermes-auth-json",
      kind: "oauth",
      location: "local_file",
      path: authPath,
      syncPolicy: "do_not_sync_secret",
      status: fileExists(authPath) ? "present" : "missing"
    }]
  };
}
