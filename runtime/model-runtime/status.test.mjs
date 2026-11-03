// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { observeModelRuntime } from "./status.mjs";

test("execution machine follows remote endpoints and recognizes IPv6 loopback", async () => {
  for (const [endpoint, expected] of [["http://hii-pc:6127", "hii-pc"], ["http://[::1]:11435", "mac"]]) {
    const status = await observeModelRuntime({ endpoint, executionMachine: "mac", fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(status.executionMachine, expected);
    assert.equal(status.loadedModel, null);
  }
});

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test("failed health never reuses a previously cached loaded model", async () => {
  const status = await observeModelRuntime({
    endpoint: "http://127.0.0.1:11435",
    selectedModel: "org/model-27b",
    executionMachine: "mac",
    fetchImpl: async () => response({}, false)
  });
  assert.equal(status.loadedModel, null);
  assert.deepEqual(status.advertisedModels, []);
  assert.equal(status.selectionMatchesLoaded, null);
  assert.equal(status.executionMachine, "mac");
});

test("reports a selected and freshly loaded model mismatch", async () => {
  const status = await observeModelRuntime({
    endpoint: "http://127.0.0.1:11435",
    selectedModel: "org/model-27b",
    fetchImpl: async (url) => url.endsWith("/health")
      ? response({ loaded_model: "org/model-9b" })
      : response({ data: [{ id: "org/model-9b" }] })
  });
  assert.equal(status.loadedModel, "org/model-9b");
  assert.equal(status.selectionMatchesLoaded, false);
});

test("discovers the fresh llama.cpp model from the advertised model list", async () => {
  const paths = [];
  const status = await observeModelRuntime({
    endpoint: "http://127.0.0.1:11435/",
    backend: "llama.cpp",
    selectedModel: "Qwen_Qwen3.5-9B-Q4_K_M.gguf",
    executionMachine: "example-mac",
    fetchImpl: async (url) => {
      paths.push(url);
      return url.endsWith("/health")
        ? response({})
        : response({ data: [{ id: "Qwen_Qwen3.5-9B-Q4_K_M.gguf" }] });
    }
  });
  assert.deepEqual(paths.sort(), ["http://127.0.0.1:11435/health", "http://127.0.0.1:11435/v1/models"]);
  assert.deepEqual(status.advertisedModels, ["Qwen_Qwen3.5-9B-Q4_K_M.gguf"]);
  assert.equal(status.loadedModel, "Qwen_Qwen3.5-9B-Q4_K_M.gguf");
  assert.equal(status.selectionMatchesLoaded, true);
  assert.equal(status.executionMachine, "example-mac");
});

test("does not treat a multi-model catalog as proof of the loaded model", async () => {
  const status = await observeModelRuntime({
    endpoint: "http://127.0.0.1:11435",
    backend: "llama.cpp",
    selectedModel: "Qwen-27B",
    fetchImpl: async (url) => url.endsWith("/health")
      ? response(null)
      : response({ data: [{ id: "Qwen-9B" }, { id: "Qwen-27B" }] })
  });
  assert.deepEqual(status.advertisedModels, ["Qwen-9B", "Qwen-27B"]);
  assert.equal(status.loadedModel, null);
  assert.equal(status.selectionMatchesLoaded, null);
});

test("does not infer a loaded MLX model from its catalog", async () => {
  const status = await observeModelRuntime({
    endpoint: "http://127.0.0.1:11435",
    backend: "mlx",
    fetchImpl: async (url) => url.endsWith("/health")
      ? response({})
      : response({ data: [{ id: "org/model-9b" }] })
  });
  assert.equal(status.loadedModel, null);
  assert.deepEqual(status.advertisedModels, ["org/model-9b"]);
});

test("keeps catalog evidence when health is unavailable and tolerates null JSON", async () => {
  const status = await observeModelRuntime({
    endpoint: "http://127.0.0.1:11435",
    backend: "llama.cpp",
    fetchImpl: async (url) => url.endsWith("/health")
      ? response(null, false)
      : response({ data: [{ id: "Qwen-27B" }] })
  });
  assert.equal(status.state, "unreachable");
  assert.deepEqual(status.advertisedModels, ["Qwen-27B"]);
  assert.equal(status.loadedModel, null);
  assert.equal(status.selectionMatchesLoaded, null);
});

test("compares model identifiers with case preserved", async () => {
  const status = await observeModelRuntime({
    endpoint: "http://127.0.0.1:11435",
    selectedModel: "Qwen-9B",
    fetchImpl: async (url) => url.endsWith("/health")
      ? response({ loadedModel: "qwen-9b" })
      : response(null)
  });
  assert.equal(status.selectionMatchesLoaded, false);
});
