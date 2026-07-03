export type RegistryVisibility = "global" | "tailnet" | "local_only" | "private";

export type AgentKind = "hermes" | "codex" | "ollama" | "mcp" | "hii" | "unknown";

export interface RegistryMachine {
  id: string;
  hostname: string;
  os: string;
  home: string;
  role?: string;
  tailnetName?: string;
  paths: Record<string, string>;
}

export interface RegistryProvider {
  id: string;
  kind: string;
  baseUrl?: string;
  machineId: string;
  visibility: RegistryVisibility;
  status: "unknown" | "reachable" | "unreachable" | "configured";
}

export interface RegistryModel {
  id: string;
  providerId: string;
  name: string;
  size?: string;
  capabilities: string[];
  recommendedFor: string[];
}

export interface RegistryAgent {
  id: string;
  kind: AgentKind;
  machineId: string;
  configPath?: string;
  profile?: string;
  status: "unknown" | "active" | "configured" | "missing" | "error";
  modelRef?: string;
  providerRef?: string;
  memoryBackend?: string;
  toolsets?: string[];
  mcpServers?: string[];
  warnings: string[];
}

export interface RegistryMcpServer {
  id: string;
  command?: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  machineId: string;
  scope?: string;
  status: "unknown" | "configured" | "installed" | "missing" | "error";
  permissions: string[];
}

export interface RegistrySecretRef {
  id: string;
  kind: "oauth" | "api_key" | "token" | "env" | "unknown";
  owner?: string;
  location: "local_file" | "env" | "vault" | "unknown";
  path?: string;
  envVar?: string;
  syncPolicy: "do_not_sync_secret" | "vault_only" | "local_only";
  status: "unknown" | "present" | "missing";
}

export interface RegistrySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  machine: RegistryMachine;
  agents: RegistryAgent[];
  providers: RegistryProvider[];
  models: RegistryModel[];
  mcpServers: RegistryMcpServer[];
  secrets: RegistrySecretRef[];
  warnings: string[];
}
