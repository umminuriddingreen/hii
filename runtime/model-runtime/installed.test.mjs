// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCachedMlxModels, mergeInstalledModels } from "./installed.mjs";

function cacheFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hii-model-cache-"));
  const repo = path.join(root, "models--mlx-community--Qwen3.8-27B-4bit");
  const blobDir = path.join(repo, "blobs");
  fs.mkdirSync(blobDir, { recursive: true });
  return { root, repo, blobDir };
}

function snapshot(fixture, revision, { indexed = false, omitShard = null, config = { quantization: { bits: 4, group_size: 64 } } } = {}) {
  const directory = path.join(fixture.repo, "snapshots", revision);
  fs.mkdirSync(directory, { recursive: true });
  if (config !== null) {
    fs.writeFileSync(path.join(fixture.blobDir, `${revision}-config`), JSON.stringify(config));
    fs.symlinkSync(path.join(fixture.blobDir, `${revision}-config`), path.join(directory, "config.json"));
  }
  const names = indexed ? ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"] : ["model.safetensors"];
  for (const name of names) {
    if (name === omitShard) continue;
    const blob = path.join(fixture.blobDir, `${revision}-${name}`);
    fs.writeFileSync(blob, "weights");
    fs.symlinkSync(blob, path.join(directory, name));
  }
  if (indexed) {
    fs.writeFileSync(path.join(directory, "model.safetensors.index.json"), JSON.stringify({
      weight_map: { a: names[0], b: names[1] }
    }));
  }
  return directory;
}

test("merges GGUF and cached MLX inventory rows with canonical model IDs", () => {
  const models = mergeInstalledModels(
    [
      { id: "Qwen-9B.gguf", backend: "llama.cpp", installed: true },
      { model: "Qwen-9B.gguf", backend: "llama.cpp", installed: true }
    ],
    [{ model: "mlx-community/Qwen3.8-27B-4bit", backend: "mlx", installed: true }]
  );
  assert.deepEqual(models.map((entry) => entry.model), ["Qwen-9B.gguf", "mlx-community/Qwen3.8-27B-4bit"]);
  assert.equal(models[0].id, "Qwen-9B.gguf");
  assert.equal(models[1].backend, "mlx");
});

test("discovers a complete referenced MLX snapshot and deduplicates revisions", () => {
  const fixture = cacheFixture();
  try {
    snapshot(fixture, "aaa111");
    const current = snapshot(fixture, "bbb222", { indexed: true });
    fs.mkdirSync(path.join(fixture.repo, "refs"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repo, "refs", "main"), "bbb222\n");
    const found = discoverCachedMlxModels(fixture.root);
    assert.equal(found.length, 1);
    assert.equal(found[0].model, "mlx-community/Qwen3.8-27B-4bit");
    assert.equal(found[0].backend, "mlx");
    assert.equal(found[0].format, "mlx-safetensors");
    assert.equal(found[0].modelPath, current);
    assert.equal(found[0].sizeBytes, 14);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ignores missing, incomplete, and unquantized safetensors snapshots", () => {
  const fixture = cacheFixture();
  try {
    snapshot(fixture, "missing-config", { config: null });
    snapshot(fixture, "partial-shards", { indexed: true, omitShard: "model-00002-of-00002.safetensors" });
    const missingWeights = path.join(fixture.repo, "snapshots", "missing-weights");
    fs.mkdirSync(missingWeights, { recursive: true });
    fs.writeFileSync(path.join(missingWeights, "config.json"), JSON.stringify({ quantization: { bits: 4, group_size: 64 } }));
    const genericRepo = path.join(fixture.root, "models--org--generic-model");
    const genericSnapshot = path.join(genericRepo, "snapshots", "revision");
    fs.mkdirSync(genericSnapshot, { recursive: true });
    fs.writeFileSync(path.join(genericSnapshot, "config.json"), JSON.stringify({ model_type: "llama", quantization_config: { bits: 4, group_size: 64 } }));
    fs.writeFileSync(path.join(genericSnapshot, "model.safetensors"), "weights");
    assert.deepEqual(discoverCachedMlxModels(fixture.root), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
