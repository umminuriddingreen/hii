// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importLocalModel, normalizeModelCommand, readImportedModels, removeImportedModel } from "./imported.mjs";
import { discoverCachedMlxModels } from "./installed.mjs";
import { discoverGgufModels } from "./llama.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hii-model-import-"));
  return { root, modelHome: path.join(root, "models"), hfCache: path.join(root, "models", "huggingface", "hub"), source: path.join(root, "source") };
}

test("imports GGUF by reference and removes only HII's link", () => {
  const f = fixture();
  try {
    const source = path.join(f.root, "qwen.gguf");
    fs.writeFileSync(source, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(12, 1)]));
    const imported = importLocalModel(source, { modelHome: f.modelHome, hfCache: f.hfCache });
    assert.equal(fs.lstatSync(imported.referencePath).isSymbolicLink(), true);
    assert.equal(discoverGgufModels([path.join(f.modelHome, "gguf-imports")])[0].id, "qwen");
    assert.equal(fs.readFileSync(source).subarray(0, 4).toString(), "GGUF");
    const removed = removeImportedModel("qwen", { modelHome: f.modelHome });
    assert.equal(removed.sourcePreserved, true);
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.existsSync(imported.referencePath), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("imports a complete MLX directory into a canonical HF cache reference and removes it safely", () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.source, { recursive: true });
    fs.writeFileSync(path.join(f.source, "config.json"), JSON.stringify({ quantization: { bits: 4, group_size: 64 } }));
    fs.writeFileSync(path.join(f.source, "model.safetensors"), Buffer.alloc(8, 7));
    const imported = importLocalModel(f.source, { modelHome: f.modelHome, hfCache: f.hfCache, model: "mlx-community/test-model" });
    const discovered = discoverCachedMlxModels(f.hfCache, { imported: readImportedModels(f.modelHome) });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].model, "mlx-community/test-model");
    assert.equal(discovered[0].modelPath, imported.referencePath);
    const removed = removeImportedModel(imported.model, { modelHome: f.modelHome });
    assert.equal(removed.sourcePreserved, true);
    assert.equal(fs.existsSync(f.source), true);
    assert.equal(fs.existsSync(path.dirname(path.dirname(imported.referencePath))), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("marks an imported snapshot inside the HF cache only once and preserves import provenance", () => {
  const f = fixture();
  try {
    const source = path.join(f.hfCache, "models--source--snapshot", "snapshots", "revision");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({ quantization: { bits: 4, group_size: 64 } }));
    fs.writeFileSync(path.join(source, "model.safetensors"), Buffer.alloc(4, 5));
    const imported = importLocalModel(source, { modelHome: f.modelHome, hfCache: f.hfCache, model: "local-import/cache-model" });
    const discovered = discoverCachedMlxModels(f.hfCache, { imported: readImportedModels(f.modelHome) });
    assert.equal(discovered.filter((entry) => entry.model === imported.model).length, 1);
    assert.equal(discovered.find((entry) => entry.model === imported.model).source, "local-import");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects invalid weights, duplicate names, malformed registry, and a busy registry", () => {
  const f = fixture();
  try {
    const bad = path.join(f.root, "bad.gguf");
    fs.writeFileSync(bad, "nope");
    assert.throws(() => importLocalModel(bad, { modelHome: f.modelHome, hfCache: f.hfCache }), /GGUF header/);
    const good = path.join(f.root, "same.gguf");
    fs.writeFileSync(good, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(8, 1)]));
    assert.throws(() => importLocalModel(good, { modelHome: f.modelHome, hfCache: f.hfCache, existingModels: ["same"] }), /already exists/);
    fs.mkdirSync(f.source, { recursive: true });
    fs.writeFileSync(path.join(f.source, "config.json"), JSON.stringify({ quantization: { bits: 4, group_size: 64 } }));
    fs.writeFileSync(path.join(f.source, "model-00001-of-00002.safetensors"), "one");
    fs.writeFileSync(path.join(f.source, "model.safetensors.index.json"), JSON.stringify({ weight_map: { a: "model-00001-of-00002.safetensors", b: "model-00002-of-00002.safetensors" } }));
    assert.throws(() => importLocalModel(f.source, { modelHome: f.modelHome, hfCache: f.hfCache, model: "mlx-community/partial" }), /missing.*shards/);
    fs.mkdirSync(f.modelHome, { recursive: true });
    fs.writeFileSync(path.join(f.modelHome, "imports.json"), "broken");
    assert.throws(() => importLocalModel(bad, { modelHome: f.modelHome, hfCache: f.hfCache }), /cannot read HII model import registry/);
    fs.unlinkSync(path.join(f.modelHome, "imports.json"));
    fs.mkdirSync(path.join(f.modelHome, "imports.json.lock"));
    assert.throws(() => importLocalModel(bad, { modelHome: f.modelHome, hfCache: f.hfCache }), /in progress/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("removes a broken imported reference without requiring its source to exist", () => {
  const f = fixture();
  try {
    const source = path.join(f.root, "lost.gguf");
    fs.writeFileSync(source, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(8, 1)]));
    const imported = importLocalModel(source, { modelHome: f.modelHome, hfCache: f.hfCache });
    fs.unlinkSync(source);
    const removed = removeImportedModel("lost", { modelHome: f.modelHome });
    assert.equal(removed.sourcePreserved, false);
    assert.equal(fs.existsSync(imported.referencePath), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("model list, install, load, unload, status, serve, and remove aliases preserve arguments", () => {
  assert.deepEqual(normalizeModelCommand(["list", "--json"]), ["installed", "--json"]);
  assert.deepEqual(normalizeModelCommand(["ls"]), ["installed"]);
  assert.deepEqual(normalizeModelCommand(["pull", "mlx-community/model"]), ["install", "mlx-community/model"]);
  assert.deepEqual(normalizeModelCommand(["load", "mlx-community/model"]), ["use", "mlx-community/model"]);
  assert.deepEqual(normalizeModelCommand(["ps"]), ["status"]);
  assert.deepEqual(normalizeModelCommand(["serve", "--model", "mlx-community/model"]), ["start", "--model", "mlx-community/model"]);
  assert.deepEqual(normalizeModelCommand(["rm", "model", "--yes"]), ["remove", "model", "--yes"]);
  assert.deepEqual(normalizeModelCommand(["unload"]), ["stop"]);
  assert.throws(() => normalizeModelCommand(["unload", "model"]), /choose models/);
});
