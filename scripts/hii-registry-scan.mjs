import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readTextIfExists(filePath) {
  if (!fileExists(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function slug(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function matchYamlScalar(text, key) {
  const re = new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n#]+)["']?`, "m");
  return text.match(re)?.[1]?.trim();
}

function matchTomlScalar(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m");
  return text.match(re)?.[1]?.trim();
}

function scanMachine() {
  const hostname = os.hostname();
  const home = os.homedir();

  return {
    id: slug(hostname || "local-machine"),
    hostname,
    os: `${os.platform()}-${os.arch()}`,
    home,
    role: "primary-workstation",
    paths: {
      home,
      hiiRepo: homePath("hii"),
      hermesHome: homePath(".hermes"),
      codexHome: homePath(".codex"),
      hiiRuntime: homePath(".hii")
    }
  };
}

function scanHermes(machineId) {
  const configPath = homePath(".hermes", "config.yaml");
  const authPath = homePath(".hermes", "auth.json");
  const config = readTextIfExists(configPath);
  const warnings = [];

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

function scanCodex(machineId) {
  const configPath = homePath(".codex", "config.toml");
  const authPath = homePath(".codex", "auth.json");
  const memoryPath = homePath(".codex", "memories", "MEMORY.md");
  const config = readTextIfExists(configPath);
  const warnings = [];

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

function scanOllama(machineId) {
  const warnings = [];
  const provider = {
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
      };
    });
    return { providers: [provider], models, warnings };
  } catch (error) {
    provider.status = "unreachable";
    warnings.push(`ollama list failed: ${error instanceof Error ? error.message : String(error)}`);
    return { providers: [provider], models: [], warnings };
  }
}

export function scanRegistry() {
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = scanRegistry();
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}
