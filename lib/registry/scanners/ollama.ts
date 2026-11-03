import { execFileSync } from "node:child_process";
import { RegistryModel, RegistryProvider } from "../types";

export function scanOllama(machineId: string): {
  providers: RegistryProvider[];
  models: RegistryModel[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const provider: RegistryProvider = {
    id: "ollama-local",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    machineId,
    visibility: "local_only",
    status: "unknown"
  };

  try {
    const output = execFileSync("ollama", ["list"], { encoding: "utf8", timeout: 5000 });
    provider.status = "reachable";
    const lines = output.split("\n").slice(1).filter(Boolean);
    const models = lines.map((line) => {
      const columns = line.trim().split(/\s{2,}/);
      const name = columns[0];
      const size = columns[2];
      return {
        id: name.replace(/[^a-zA-Z0-9_.:-]/g, "-"),
        providerId: provider.id,
        name,
        size,
        capabilities: ["chat"],
        recommendedFor: ["private-local"]
      } satisfies RegistryModel;
    });
    return { providers: [provider], models, warnings };
  } catch (error) {
    provider.status = "unreachable";
    warnings.push(`ollama list failed: ${error instanceof Error ? error.message : String(error)}`);
    return { providers: [provider], models: [], warnings };
  }
}
