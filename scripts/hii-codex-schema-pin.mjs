#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.homedir(), "hii");
const pinned = path.join(os.homedir(), ".local", "bin", "codex");
const codex = process.env.HII_CODEX_BIN || (fs.existsSync(pinned) ? pinned : "codex");
const versionText = execFileSync(codex, ["--version"], { encoding: "utf8" }).trim();
const version = versionText.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1];
if (!version) throw new Error(`Could not parse Codex version from: ${versionText}`);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hii-codex-schema-"));
const destination = path.join(root, "runtime", "codex", "schema", version);
try {
  execFileSync(codex, ["app-server", "generate-json-schema", "--out", temporary], { stdio: "inherit" });
  fs.mkdirSync(destination, { recursive: true });
  const source = path.join(temporary, "codex_app_server_protocol.v2.schemas.json");
  const target = path.join(destination, "codex_app_server_protocol.v2.schemas.json");
  fs.copyFileSync(source, target);
  const sha256 = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  const manifest = {
    schemaVersion: 1,
    codexVersion: version,
    codexVersionText: versionText,
    generatedAt: new Date().toISOString(),
    generator: `${codex} app-server generate-json-schema`,
    protocol: "v2",
    file: path.basename(target),
    sha256
  };
  fs.writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, destination, ...manifest }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
