import { scanRegistry } from "./hii-registry-scan.mjs";

function formatRegistryDoctor(snapshot) {
  const lines = [];
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

process.stdout.write(formatRegistryDoctor(scanRegistry()));
