import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ASSET_BYTES = 250 * 1024 * 1024;
const STAGING_PARENT = ".hii-run-context";
const MARKER = ".hii-staging.json";

function cleanId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256File(file) {
  const digest = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

function stagingDirectory(workspaceRoot, intentId) {
  return path.join(workspaceRoot, STAGING_PARENT, intentId);
}

function markerValue(intentId, fingerprint) {
  return {
    schemaVersion: 1,
    kind: "hii.workspace-run-staging",
    intentId,
    fingerprint
  };
}

function readMarker(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, MARKER), "utf8"));
  } catch {
    return null;
  }
}

function removeEmptyParent(workspaceRoot) {
  try {
    fs.rmdirSync(path.join(workspaceRoot, STAGING_PARENT));
  } catch {
    // Another run or an operator-owned file still uses the parent.
  }
}

export function stageWorkspaceRunContext(input) {
  const intentId = cleanId(input.intentId);
  const fingerprint = String(input.contextPreview?.fingerprint || "");
  const previewRunId = cleanId(input.contextPreview?.runId);
  if (!intentId || previewRunId !== intentId || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("AII rejected a local asset staging request without a matching reviewed run manifest.");
  }
  const workspaceRoot = fs.realpathSync(String(input.workspaceRoot || ""));
  const runtimeRoot = String(input.runtimeRoot || path.join(os.homedir(), ".hii"));
  const items = Array.isArray(input.contextPreview?.items)
    ? input.contextPreview.items.filter((item) => item?.access === "staged-local-asset")
    : [];
  if (!items.length) {
    return {
      schemaVersion: 1,
      required: false,
      intentId,
      fingerprint,
      files: [],
      cleanupPolicy: "No disposable run-context copy was created."
    };
  }
  const managedAssets = fs.realpathSync(path.join(runtimeRoot, "workspace", "assets"));

  const directory = stagingDirectory(workspaceRoot, intentId);
  const directoryRelativePath = path.relative(workspaceRoot, directory);
  const expectedMarker = markerValue(intentId, fingerprint);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, MARKER), `${JSON.stringify(expectedMarker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    const existingMarker = readMarker(directory);
    if (
      !existingMarker
      || existingMarker.intentId !== intentId
      || existingMarker.fingerprint !== fingerprint
    ) {
      throw new Error(`AII will not reuse an unowned staging directory at ${directoryRelativePath}.`, {
        cause: error
      });
    }
  }

  const files = [];
  try {
    for (const item of items) {
      const source = fs.realpathSync(String(item.source || ""));
      if (!inside(managedAssets, source)) {
        throw new Error("AII rejected a staged source outside HII-managed asset storage.");
      }
      const details = fs.statSync(source);
      if (!details.isFile() || details.size > MAX_ASSET_BYTES) {
        throw new Error("AII rejected a staged source that is not a bounded regular file.");
      }
      const expectedSha256 = String(item.sha256 || "");
      if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256File(source) !== expectedSha256) {
        throw new Error("A selected local asset changed after context approval.");
      }
      const relativePath = String(item.stagedRelativePath || "");
      const expectedPrefix = `${STAGING_PARENT}${path.sep}${intentId}${path.sep}`;
      if (
        !relativePath.startsWith(expectedPrefix)
        || !path.basename(relativePath).startsWith(expectedSha256)
      ) {
        throw new Error("AII rejected a staged destination outside the reviewed per-run path.");
      }
      const destination = path.resolve(workspaceRoot, relativePath);
      if (!inside(directory, destination)) {
        throw new Error("AII rejected a staged destination outside its owned run directory.");
      }
      try {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code !== "EEXIST" || sha256File(destination) !== expectedSha256) throw error;
      }
      fs.chmodSync(destination, 0o400);
      if (sha256File(destination) !== expectedSha256) {
        throw new Error("AII failed to verify the disposable staged copy.");
      }
      files.push({
        source,
        relativePath,
        sha256: expectedSha256,
        byteSize: details.size,
        provenance: item.provenance
      });
    }
  } catch (error) {
    const marker = readMarker(directory);
    if (marker?.intentId === intentId && marker?.fingerprint === fingerprint) {
      fs.rmSync(directory, { recursive: true, force: true });
      removeEmptyParent(workspaceRoot);
    }
    throw error;
  }

  return {
    schemaVersion: 1,
    required: true,
    intentId,
    fingerprint,
    directory: directoryRelativePath,
    preparedAt: new Date().toISOString(),
    files,
    cleanupPolicy: "AII removes only this marked disposable copy after terminal state; the immutable HII-managed source remains."
  };
}

export function cleanupWorkspaceRunContext(input) {
  const intentId = cleanId(input.intentId);
  const fingerprint = String(input.staging?.fingerprint || "");
  if (!input.staging?.required) {
    return {
      ...(input.staging || {}),
      cleanupStatus: "not-required",
      cleanedAt: new Date().toISOString()
    };
  }
  const workspaceRoot = fs.realpathSync(String(input.workspaceRoot || ""));
  const directory = stagingDirectory(workspaceRoot, intentId);
  const expectedRelativePath = path.relative(workspaceRoot, directory);
  if (input.staging.directory !== expectedRelativePath) {
    return {
      ...input.staging,
      cleanupStatus: "skipped-unowned",
      cleanupError: "The recorded staging directory does not match this run."
    };
  }
  const marker = readMarker(directory);
  if (marker?.intentId !== intentId || marker?.fingerprint !== fingerprint) {
    return {
      ...input.staging,
      cleanupStatus: "skipped-unowned",
      cleanupError: "The staging ownership marker is missing or does not match this run."
    };
  }
  fs.rmSync(directory, { recursive: true, force: true });
  removeEmptyParent(workspaceRoot);
  return {
    ...input.staging,
    cleanupStatus: "removed",
    cleanedAt: new Date().toISOString()
  };
}
