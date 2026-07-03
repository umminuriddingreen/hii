import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRegistry } from "./hii-registry-scan.mjs";

const outputDir = path.join(os.homedir(), ".hii", "registry");
const outputPath = path.join(outputDir, "snapshot.json");
const snapshot = scanRegistry();

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${outputPath}\n`);
