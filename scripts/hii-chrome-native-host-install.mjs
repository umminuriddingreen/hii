#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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

export function manifestContent(launcher, extensionId = EXTENSION_ID_PLACEHOLDER) {
  const manifest = {
    name: HOST_NAME,
    description: "Local Save to HII native messaging host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function nativeHostDirectory(browser, home = homedir()) {
  if (browser === "helium") return resolve(home, "Library/Application Support/net.imput.helium/NativeMessagingHosts");
  if (browser === "chrome") return resolve(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts");
  throw new Error("unsupported browser");
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
    if (value.startsWith("--") && args[index + 1] && !args[index + 1].startsWith("--")) pairs.push([value.slice(2), args[index + 1]]);
    return pairs;
  }, []));
  if (options.browser && !["chrome", "helium"].includes(options.browser)) throw new Error("--browser must be chrome or helium");
  if (options["extension-id"] && !/^[a-p]{32}$/.test(options["extension-id"])) throw new Error("--extension-id must be a 32-character Chromium extension ID");
  const root = repoRoot();
  const paths = platformPaths(root);
  await mkdir(dirname(paths.launcher), { recursive: true });
  await writeFile(paths.launcher, launcherContent(root));
  await chmod(paths.launcher, 0o755).catch(() => {});
  await writeFile(paths.manifest, manifestContent(paths.launcher, options["extension-id"]));
  let registered = null;
  if (process.platform === "darwin" && options.browser && options["extension-id"]) {
    const target = resolve(nativeHostDirectory(options.browser), `${HOST_NAME}.json`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, manifestContent(paths.launcher, options["extension-id"]));
    registered = target;
  }
  console.log(JSON.stringify({
    hostName: HOST_NAME,
    launcher: paths.launcher,
    manifest: paths.manifest,
    registered,
    next: process.platform === "win32"
      ? `Register ${HOST_NAME} under HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME} with default value ${paths.manifest}`
      : registered ? `Restart ${options.browser} and check the native host in extension Options.`
        : `Pass --browser chrome|helium --extension-id ID to register the native host on macOS.`
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
