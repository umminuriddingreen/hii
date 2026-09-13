#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.hii.save_to_hii";
const EXTENSION_ID_PLACEHOLDER = "PUT_UNPACKED_EXTENSION_ID_HERE";

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function platformPaths(root) {
  if (process.platform === "win32") {
    return {
      launcher: resolve(root, "extensions/chrome-link-capture/native-host/hii-chrome-native-host.cmd"),
      manifest: resolve(root, "extensions/chrome-link-capture/native-host/com.hii.save_to_hii.windows.json")
    };
  }
  return {
    launcher: resolve(root, "extensions/chrome-link-capture/native-host/hii-chrome-native-host"),
    manifest: resolve(root, "extensions/chrome-link-capture/native-host/com.hii.save_to_hii.json")
  };
}

function launcherContent(root) {
  const host = resolve(root, "scripts/hii-chrome-native-host.mjs");
  if (process.platform === "win32") {
    return `@echo off\r\nnode "${host}"\r\n`;
  }
  return `#!/usr/bin/env sh\nexec node '${host.replaceAll("'", "'\\''")}'\n`;
}

function manifestContent(launcher) {
  const manifest = {
    name: HOST_NAME,
    description: "Local Save to HII native messaging host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID_PLACEHOLDER}/`]
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main() {
  const root = repoRoot();
  const paths = platformPaths(root);
  await mkdir(dirname(paths.launcher), { recursive: true });
  await writeFile(paths.launcher, launcherContent(root));
  await chmod(paths.launcher, 0o755).catch(() => {});
  await writeFile(paths.manifest, manifestContent(paths.launcher));
  console.log(JSON.stringify({
    hostName: HOST_NAME,
    launcher: paths.launcher,
    manifest: paths.manifest,
    next: process.platform === "win32"
      ? `Register ${HOST_NAME} under HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME} with default value ${paths.manifest}`
      : `Copy or symlink ${paths.manifest} into Chrome's NativeMessagingHosts directory after replacing the extension ID placeholder.`
  }, null, 2));
}

await main();
