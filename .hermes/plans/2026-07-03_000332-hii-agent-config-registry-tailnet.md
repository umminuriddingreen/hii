# HII Agent Config Registry + Tailnet Sync Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build the first read-only HII Agent Config Registry: a structured local control plane that scans Hermes, Codex, Ollama, MCP, and machine config into one normalized snapshot, with a path toward tailnet-only sync later.

**Architecture:** Start with a read-only registry inside the existing `/Users/ummi/hii` Next.js/TypeScript repo. Add a small TypeScript registry module and CLI scripts that inspect local config files without syncing secrets or mutating external tools. Persist snapshots under `.hii/registry/` or `~/.hii/registry/` only after dry-run/read-only output is validated.

**Tech Stack:** Next.js 14 / TypeScript / Node.js scripts, JSON snapshots, existing `npm` workflow. Future tailnet service can be FastAPI or Next.js route handlers, but v1 should be local read-only scanning.

---

## Current Context / Assumptions

- Canonical HII repo: `/Users/ummi/hii`
- Current branch: `nextjs`
- Existing stack: Next.js 14, React 18, TypeScript, npm, Supabase, Stripe, R2.
- Existing scripts: `dev`, `build`, `start`, `lint`.
- No Python project is currently configured in this repo.
- Hermes config path: `/Users/ummi/.hermes/config.yaml`
- Codex config path: `/Users/ummi/.codex/config.toml`
- Codex auth exists, but raw auth files must not be copied into registry snapshots.
- Ollama OpenAI-compatible endpoint appears to be `http://127.0.0.1:11434/v1`.
- Product goal: HII becomes the consistent operator surface, not another fragmented agent window.

## Non-Goals for v1

- Do not sync raw secrets.
- Do not overwrite Hermes/Codex configs.
- Do not start a daemon yet.
- Do not expose public ports.
- Do not build a full dashboard before the CLI/snapshot spine works.
- Do not recreate Hermes internals; index and normalize them.

## Proposed v1 Shape

Commands to add eventually:

```bash
npm run hii:registry:scan
npm run hii:registry:doctor
npm run hii:registry:export
```

Generated snapshot shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-03T00:00:00.000Z",
  "machine": {
    "id": "ummi-macbook",
    "hostname": "...",
    "os": "macos",
    "home": "/Users/ummi"
  },
  "agents": [],
  "providers": [],
  "models": [],
  "mcpServers": [],
  "secrets": [],
  "warnings": []
}
```

---

# Step-by-Step Plan

### Task 1: Add registry TypeScript types

**Objective:** Define the normalized HII registry schema without implementing scanning yet.

**Files:**
- Create: `lib/registry/types.ts`
- Test: `lib/registry/types.ts` typecheck via `npx tsc -p tsconfig.json --noEmit`

**Step 1: Create the type file**

Add:

```ts
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
```

**Step 2: Run typecheck**

Run:

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 3: Commit**

```bash
git add lib/registry/types.ts
git commit -m "feat: add HII registry schema types"
```

---

### Task 2: Add safe file helpers for local config discovery

**Objective:** Add minimal read-only helpers for checking config file existence and reading text safely.

**Files:**
- Create: `lib/registry/local-files.ts`

**Step 1: Add helper module**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function homePath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function readTextIfExists(filePath: string): string | null {
  if (!fileExists(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

export function redactPath(input: string): string {
  return input.replace(os.homedir(), "~");
}
```

**Step 2: Run typecheck**

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 3: Commit**

```bash
git add lib/registry/local-files.ts
git commit -m "feat: add registry file discovery helpers"
```

---

### Task 3: Add machine scanner

**Objective:** Normalize host/machine metadata into the registry schema.

**Files:**
- Create: `lib/registry/scanners/machine.ts`

**Step 1: Implement machine scanner**

```ts
import os from "node:os";
import { RegistryMachine } from "../types";
import { homePath } from "../local-files";

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function scanMachine(): RegistryMachine {
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
```

**Step 2: Run typecheck**

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 3: Commit**

```bash
git add lib/registry/scanners/machine.ts
git commit -m "feat: add machine registry scanner"
```

---

### Task 4: Add Hermes scanner

**Objective:** Detect Hermes config/auth/skills without copying secrets.

**Files:**
- Create: `lib/registry/scanners/hermes.ts`

**Step 1: Implement simple regex/YAML-light scanner**

Avoid adding a YAML dependency in v1. Read only high-signal fields with defensive regex.

```ts
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
```

**Step 2: Typecheck**

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 3: Commit**

```bash
git add lib/registry/scanners/hermes.ts
git commit -m "feat: add Hermes registry scanner"
```

---

### Task 5: Add Codex scanner

**Objective:** Detect Codex config/auth/memory files without copying secrets.

**Files:**
- Create: `lib/registry/scanners/codex.ts`

**Step 1: Implement TOML-light scanner**

```ts
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
```

**Step 2: Typecheck**

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 3: Commit**

```bash
git add lib/registry/scanners/codex.ts
git commit -m "feat: add Codex registry scanner"
```

---

### Task 6: Add Ollama scanner via CLI command

**Objective:** Detect installed local Ollama models in a non-fatal way.

**Files:**
- Create: `lib/registry/scanners/ollama.ts`

**Step 1: Implement scanner**

```ts
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
```

**Step 2: Typecheck**

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 3: Commit**

```bash
git add lib/registry/scanners/ollama.ts
git commit -m "feat: add Ollama registry scanner"
```

---

### Task 7: Compose full registry scan

**Objective:** Combine machine, Hermes, Codex, and Ollama scanners into one snapshot.

**Files:**
- Create: `lib/registry/scan.ts`

**Step 1: Implement composer**

```ts
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
```

**Step 2: Typecheck**

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 3: Commit**

```bash
git add lib/registry/scan.ts
git commit -m "feat: compose HII registry snapshot"
```

---

### Task 8: Add CLI script for registry scan

**Objective:** Add a Node/TypeScript entrypoint that prints the registry snapshot as JSON.

**Files:**
- Create: `scripts/hii-registry-scan.ts`
- Modify: `package.json`

**Step 1: Add script file**

```ts
import { scanRegistry } from "../lib/registry/scan";

const snapshot = scanRegistry();
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
```

**Step 2: Add package script**

Modify `package.json` scripts:

```json
"hii:registry:scan": "tsx scripts/hii-registry-scan.ts"
```

If `tsx` is not installed, add it as a dev dependency only after user approval if required. Alternative without new dependency: compile through `tsc` or implement the first CLI as plain JS. Because Ummi prefers no third-party installs without consent, prefer plain JS or use existing TypeScript build path unless explicit install approval is given.

Safer v1 option: create `scripts/hii-registry-scan.mjs` and avoid `tsx`.

Recommended implementation for no new dependency:
- Create compiled-compatible JS scanner later, or add a small `scripts/hii-registry-scan.mjs` that shells out to `node` APIs directly.
- If using TypeScript script is important, ask Ummi before installing `tsx`.

**Step 3: Typecheck**

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 4: Run scan**

```bash
cd /Users/ummi/hii
npm run hii:registry:scan
```

Expected: JSON printed with machine, Hermes, Codex, Ollama sections.

**Step 5: Commit**

```bash
git add package.json scripts/hii-registry-scan.ts
 git commit -m "feat: add HII registry scan command"
```

---

### Task 9: Add registry doctor summary

**Objective:** Produce human-readable status from the snapshot.

**Files:**
- Create: `lib/registry/doctor.ts`
- Create: `scripts/hii-registry-doctor.ts` or `.mjs`
- Modify: `package.json`

**Step 1: Add doctor formatter**

```ts
import { RegistrySnapshot } from "./types";

export function formatRegistryDoctor(snapshot: RegistrySnapshot): string {
  const lines: string[] = [];
  lines.push("HII Registry Doctor");
  lines.push("");
  lines.push(`Machine: ${snapshot.machine.id} (${snapshot.machine.os})`);
  lines.push("");
  lines.push("Agents:");
  for (const agent of snapshot.agents) {
    lines.push(`  ${agent.id}: ${agent.status}${agent.modelRef ? ` · model ${agent.modelRef}` : ""}`);
    for (const warning of agent.warnings) lines.push(`    warning: ${warning}`);
  }
  lines.push("");
  lines.push("Providers:");
  for (const provider of snapshot.providers) {
    lines.push(`  ${provider.id}: ${provider.status}${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}`);
  }
  lines.push("");
  lines.push("Models:");
  for (const model of snapshot.models) {
    lines.push(`  ${model.name}${model.size ? ` · ${model.size}` : ""}`);
  }
  lines.push("");
  lines.push("Secrets:");
  for (const secret of snapshot.secrets) {
    lines.push(`  ${secret.id}: ${secret.status} · ${secret.syncPolicy}`);
  }
  if (snapshot.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of snapshot.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}
```

**Step 2: Add CLI entrypoint**

```ts
import { formatRegistryDoctor } from "../lib/registry/doctor";
import { scanRegistry } from "../lib/registry/scan";

process.stdout.write(formatRegistryDoctor(scanRegistry()));
```

**Step 3: Add script**

```json
"hii:registry:doctor": "tsx scripts/hii-registry-doctor.ts"
```

Same dependency caveat as Task 8: do not install `tsx` without explicit approval. If avoiding dependencies, implement as `.mjs` or add a build-based command.

**Step 4: Verify**

```bash
cd /Users/ummi/hii
npm run hii:registry:doctor
```

Expected: readable summary showing Hermes, Codex, Ollama, models, and non-secret auth references.

**Step 5: Commit**

```bash
git add lib/registry/doctor.ts scripts/hii-registry-doctor.ts package.json
git commit -m "feat: add HII registry doctor command"
```

---

### Task 10: Add snapshot export with secret-safe defaults

**Objective:** Allow writing a registry snapshot without writing secrets.

**Files:**
- Create: `scripts/hii-registry-export.ts` or `.mjs`
- Modify: `package.json`
- Ensure generated output path is gitignored if needed.

**Step 1: Choose output path**

Recommended local path:

```text
/Users/ummi/.hii/registry/snapshot.json
```

Repo-local dev artifact path if needed:

```text
.hii/registry/snapshot.json
```

Prefer home runtime path for machine-specific state.

**Step 2: Add export script**

Script should:
- create `~/.hii/registry/`
- write `snapshot.json`
- print path
- never include raw secret values

**Step 3: Add package script**

```json
"hii:registry:export": "tsx scripts/hii-registry-export.ts"
```

**Step 4: Verify**

```bash
cd /Users/ummi/hii
npm run hii:registry:export
python3 -m json.tool ~/.hii/registry/snapshot.json >/dev/null
```

Expected: JSON is valid and contains no token values.

**Step 5: Secret scan**

```bash
cd /Users/ummi/hii
if test -f ~/.hii/registry/snapshot.json; then grep -E 'sk-|whsec_|service_role|access_token|refresh_token' ~/.hii/registry/snapshot.json && exit 1 || true; fi
```

Expected: no matches.

**Step 6: Commit**

```bash
git add scripts/hii-registry-export.ts package.json .gitignore
git commit -m "feat: export secret-safe registry snapshot"
```

---

## Files Likely to Change

- `lib/registry/types.ts`
- `lib/registry/local-files.ts`
- `lib/registry/scanners/machine.ts`
- `lib/registry/scanners/hermes.ts`
- `lib/registry/scanners/codex.ts`
- `lib/registry/scanners/ollama.ts`
- `lib/registry/scan.ts`
- `lib/registry/doctor.ts`
- `scripts/hii-registry-scan.ts` or `.mjs`
- `scripts/hii-registry-doctor.ts` or `.mjs`
- `scripts/hii-registry-export.ts` or `.mjs`
- `package.json`
- `.gitignore`

## Tests / Validation

Run after each task:

```bash
cd /Users/ummi/hii
npx tsc -p tsconfig.json --noEmit
```

Run before final handoff:

```bash
cd /Users/ummi/hii
npm run build
npm run hii:registry:scan
npm run hii:registry:doctor
npm run hii:registry:export
python3 -m json.tool ~/.hii/registry/snapshot.json >/dev/null
if test -f ~/.hii/registry/snapshot.json; then grep -E 'sk-|whsec_|service_role|access_token|refresh_token' ~/.hii/registry/snapshot.json && exit 1 || true; fi
git status --short
```

Expected:
- TypeScript passes.
- Next.js build passes.
- Registry scan prints valid JSON.
- Doctor prints readable status.
- Exported snapshot is valid JSON.
- Secret scan returns no matches.
- Git status only includes intentional files before commit; clean after commit.

## Risks / Tradeoffs / Open Questions

1. **Dependency choice:** TypeScript CLI scripts need a runner like `tsx`, but installing dependencies requires explicit user consent. Prefer `.mjs` scripts or existing build path unless Ummi approves `tsx`.
2. **Parsing config:** Regex/TOML-light/YAML-light parsing is fragile but acceptable for read-only v1. Later, add proper parsers if needed.
3. **Secrets:** Never copy auth files. Only track secret reference presence/status.
4. **Tailnet:** Do not expose service yet. Tailnet sync should come after local registry snapshots are stable.
5. **Source of truth:** HII should index existing configs first. Write-back should be a later phase with dry-run diffs.
6. **Next.js vs Python:** Repo is Next.js today. Python/FastAPI may be better for a future daemon, but v1 should avoid introducing another runtime unless necessary.

## Future Phase: Tailnet Service

After v1 registry scan/doctor/export works:

1. Add `~/.hii/registry/registry.db` SQLite store.
2. Add append-only `sync_events` table.
3. Add tailnet-only server bound to Tailscale IP or localhost behind Tailscale Serve.
4. Add machine enrollment with per-machine identity.
5. Add signed snapshot upload/download.
6. Add conflict detection for model/provider/config drift.
7. Add write-back only with explicit `--dry-run` and confirmation.

## Execution Handoff

Plan complete. Implement task-by-task with frequent commits. If using Codex, give it this plan path and instruct it to start with Task 1 only, verify, commit, then proceed sequentially.

Suggested Codex prompt:

```text
We are in /Users/ummi/hii. Implement the plan at .hermes/plans/2026-07-03_000332-hii-agent-config-registry-tailnet.md task-by-task. Start with Task 1. Follow the plan exactly. Do not install new dependencies without asking. Do not read or copy raw auth token contents. Do not sync secrets. After each task, run npx tsc -p tsconfig.json --noEmit and commit the task. Keep output concise and stop if a command would require credentials or destructive changes.
```
