import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMacGguf } from "./llama.mjs";

const models = [
  { id: "qwen-27b", modelPath: "/models/qwen-27b.gguf" },
  { id: "qwen-9b", modelPath: "/models/qwen-9b.gguf" }
];

test("saved GGUF selection wins over the sorted default", () => {
  assert.equal(
    selectMacGguf(models, { llamaAvailable: true, preferredModel: "qwen-9b" }),
    models[1]
  );
});

test("an explicit model overrides a stale saved GGUF preference", () => {
  assert.equal(
    selectMacGguf(models, {
      llamaAvailable: true,
      requestedModel: "qwen-27b",
      preferredModel: "removed-model"
    }),
    models[0]
  );
});

test("an explicit non-GGUF model does not fall back to another GGUF", () => {
  assert.equal(
    selectMacGguf(models, {
      llamaAvailable: true,
      requestedModel: "Qwen3.8-MLX-27B",
      preferredModel: "qwen-9b"
    }),
    null
  );
});

test("explicit preference resolves without a server so startup can report the missing binary", () => {
  assert.equal(
    selectMacGguf(models, { llamaAvailable: false, preferredModel: "qwen-9b" }),
    models[1]
  );
  assert.equal(selectMacGguf(models, { llamaAvailable: false }), null);
});
