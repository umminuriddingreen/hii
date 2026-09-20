import fs from "node:fs";
import os from "node:os";
import { supportsPlatform } from "./platform.mjs";

export function totalMemoryGiB() {
  return Math.round(os.totalmem() / (1024 ** 3));
}

export function selectConsumerModelProfile(
  profilesFile,
  memoryGiB = totalMemoryGiB(),
  platform = process.platform,
  arch = process.arch
) {
  const profiles = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
  const selected = profiles.tiers.find(
    (tier) => supportsPlatform(tier, platform, arch)
      && (tier.memoryGiBMax === null || memoryGiB <= tier.memoryGiBMax)
  );
  if (!selected) {
    throw new Error(`no native model profile matches ${platform}/${arch} with ${memoryGiB} GiB`);
  }
  return {
    tier: selected.name,
    model: selected.model,
    quant: selected.quantization,
    localClass: selected.localClass,
    backend: selected.backend,
    platforms: selected.platforms
  };
}
