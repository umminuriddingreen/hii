// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModelHome, scanModelFolder } from "./model-folder.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hii-model-folder-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function mlxModel(directory, { config = { model_type: "qwen2", quantization: { bits: 4, group_size: 64 }, _name_or_path: "mlx-community/Qwen-Test-4bit" }, indexed = false, tokenizer = true, shards = null } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
  if (tokenizer) fs.writeFileSync(path.join(directory, "tokenizer.json"), "{}");
  if (indexed) {
    const indexedShards = shards || ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"];
    for (const shard of indexedShards) fs.writeFileSync(path.join(directory, shard), "weights");
    fs.writeFileSync(path.join(directory, "model.safetensors.index.json"), JSON.stringify({ weight_map: { a: indexedShards[0], b: indexedShards[1] } }));
  } else if (shards) {
    for (const shard of shards) fs.writeFileSync(path.join(directory, shard), "weights");
  } else {
    fs.writeFileSync(path.join(directory, "model.safetensors"), "weights");
  }
}

test("resolves an explicit model home, custom runtime, and user models default", () => {
  assert.equal(resolveModelHome({ env: { HII_MODEL_HOME: "~/weights" }, home: "/Users/example" }), "/Users/example/weights");
  assert.equal(resolveModelHome({ env: {}, home: "/Users/example", runtime: "/var/tmp/hii" }), "/var/tmp/hii/models");
  assert.equal(resolveModelHome({ env: {}, home: "/Users/example" }), "/Users/example/models");
});

test("finds standalone MLX folders and GGUF files and skips HF cache duplicates and image models", () => {
  const f = fixture();
  try {
    const standalone = path.join(f.root, "exo", "mlx-community--Qwen-Test-4bit");
    mlxModel(standalone, { indexed: true });
    const image = path.join(f.root, "image-model");
    mlxModel(image, { config: { model_type: "stable-diffusion", quantization: { bits: 4, group_size: 64 } } });
    const noTokenizer = path.join(f.root, "partial");
    mlxModel(noTokenizer, { tokenizer: false });

    const gguf = path.join(f.root, "gguf", "Qwen-Test-Q4_K_M.gguf");
    fs.mkdirSync(path.dirname(gguf), { recursive: true });
    fs.writeFileSync(gguf, Buffer.concat([Buffer.from("GGUF"), Buffer.from("data")]));
    fs.writeFileSync(path.join(f.root, "gguf", "invalid-magic.gguf"), "not-a-gguf");
    fs.writeFileSync(path.join(f.root, "gguf", "mmproj-model.gguf"), Buffer.from("GGUF-projector"));

    // Hub cache snapshots are discovered by the existing cache scanner; this folder
    // scanner must leave those aliases and blob content to that API.
    const hub = path.join(f.root, "huggingface", "hub", "models--mlx-community--cached", "snapshots", "abc");
    mlxModel(hub);

    const found = scanModelFolder(f.root);
    assert.deepEqual(found.map((entry) => entry.format).sort(), ["gguf", "mlx-safetensors"]);
    const mlx = found.find((entry) => entry.backend === "mlx");
    assert.equal(mlx.model, "mlx-community/Qwen-Test-4bit");
    assert.equal(mlx.modelPath, fs.realpathSync(standalone));
    assert.equal(mlx.sizeBytes, 14);
    assert.equal(mlx.source, "model-folder");
    const foundGguf = found.find((entry) => entry.format === "gguf");
    assert.equal(foundGguf.model, "Qwen-Test-Q4_K_M");
    assert.equal(foundGguf.modelPath, fs.realpathSync(gguf));
    assert.equal(foundGguf.sizeBytes, 8);
  } finally { f.cleanup(); }
});

test("bounds traversal, avoids symlink cycles, and validates shard indexes", () => {
  const f = fixture();
  try {
    const nested = path.join(f.root, "one", "two");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "bounded.gguf"), Buffer.from("GGUF"));
    try { fs.symlinkSync(f.root, path.join(nested, "cycle"), "dir"); } catch {}
    const broken = path.join(f.root, "broken-index");
    mlxModel(broken, { indexed: true });
    fs.writeFileSync(path.join(broken, "model.safetensors.index.json"), JSON.stringify({ weight_map: { a: "missing.safetensors" } }));

    assert.deepEqual(scanModelFolder(f.root, { maxDepth: 1 }), []);
    assert.deepEqual(scanModelFolder(f.root, { maxDirs: 1 }), []);
    const found = scanModelFolder(f.root);
    assert.deepEqual(found.map((entry) => entry.model), ["bounded"]);
  } finally { f.cleanup(); }
});

test("accepts complete numbered shard sets and mlx-community bf16 folders without quantization metadata", () => {
  const f = fixture();
  try {
    const modelName = "mlx-community--gemma-test-bf16";
    const config = { model_type: "gemma4", architectures: ["Gemma4ForConditionalGeneration"] };
    const complete = path.join(f.root, modelName);
    mlxModel(complete, {
      config,
      shards: ["model-00001-of-00003.safetensors", "model-00002-of-00003.safetensors", "model-00003-of-00003.safetensors"]
    });
    const missing = path.join(f.root, "mlx-community--missing-shard");
    mlxModel(missing, { config, shards: ["model-00001-of-00003.safetensors", "model-00003-of-00003.safetensors"] });
    const mismatched = path.join(f.root, "mlx-community--mismatched-shards");
    mlxModel(mismatched, { config, shards: ["model-00001-of-00002.safetensors", "model-00002-of-00003.safetensors"] });

    const found = scanModelFolder(f.root);
    assert.equal(found.length, 1);
    assert.equal(found[0].model, "mlx-community/gemma-test-bf16");
    assert.equal(found[0].sizeBytes, 21);
  } finally { f.cleanup(); }
});
