import fs from "node:fs";
import os from "node:os";

export function totalMemoryGiB() {
  return Math.round(os.totalmem() / (1024 ** 3));
}

export function selectConsumerModelProfile(profilesFile, memoryGiB = totalMemoryGiB()) {
  const profiles = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
  const selected = profiles.tiers.find(
    (tier) => tier.memoryGiBMax === null || memoryGiB <= tier.memoryGiBMax
  );
  if (!selected) throw new Error(`no native model profile matches ${memoryGiB} GiB`);
  return {
    tier: selected.name,
    model: selected.model,
    quant: selected.quantization,
    localClass: selected.localClass
  };
}
