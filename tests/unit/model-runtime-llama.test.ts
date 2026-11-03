import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMacLlamaLaunchPlan, discoverGgufModels, isLlamaServerCommand, resolveGgufModel, resolveMacLlamaServerBin, selectDefaultMacGguf } from "../../runtime/model-runtime/llama.mjs";

const temporary = [];
function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hii-gguf-"));
  temporary.push(directory);
  return directory;
}
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("Mac llama.cpp baseline helpers", () => {
  it("discovers installed GGUF files without assuming a model ID", () => {
    const models = tempDirectory();
    fs.mkdirSync(path.join(models, "nested"));
    fs.writeFileSync(path.join(models, "nested", "selected-model.Q4_K_M.GGUF"), "weights");
    const discovered = discoverGgufModels([models]);
    expect(discovered).toEqual([expect.objectContaining({
      id: "selected-model.Q4_K_M",
      modelPath: path.join(models, "nested", "selected-model.Q4_K_M.GGUF"),
      sizeBytes: 7
    })]);
    expect(resolveGgufModel(discovered, "selected-model.Q4_K_M")).toEqual(discovered[0]);
    expect(discoverGgufModels([path.join(models, "missing")])).toEqual([]);
  });

  it("disambiguates duplicate filenames by their relative model paths", () => {
    const models = tempDirectory();
    for (const directory of ["one", "two"]) {
      fs.mkdirSync(path.join(models, directory));
      fs.writeFileSync(path.join(models, directory, "model.gguf"), directory);
    }
    expect(discoverGgufModels([models]).map((model) => model.id)).toEqual(["one__model", "two__model"]);
  });

  it("defaults to the first installed GGUF only when llama.cpp is available", () => {
    const models = tempDirectory();
    for (const id of ["zeta", "alpha"]) fs.writeFileSync(path.join(models, `${id}.gguf`), id);
    const discovered = discoverGgufModels([models]);
    expect(selectDefaultMacGguf(discovered, true)).toEqual(discovered[0]);
    expect(discovered[0].id).toBe("alpha");
    expect(selectDefaultMacGguf(discovered, false)).toBeNull();
    expect(selectDefaultMacGguf([], true)).toBeNull();
  });

  it("builds a loopback llama-server plan using the discovered model path", () => {
    const plan = buildMacLlamaLaunchPlan({
      binary: "/opt/homebrew/bin/llama-server",
      modelPath: "/models/user-choice.gguf",
      modelId: "user-choice",
      endpoint: "http://127.0.0.1:11435"
    });
    expect(plan.args).toEqual(expect.arrayContaining([
      "--model", "/models/user-choice.gguf", "--alias", "user-choice",
      "--host", "127.0.0.1", "--port", "11435", "--n-gpu-layers", "999"
    ]));
    expect(plan.backend).toBe("llama.cpp");
    expect(() => buildMacLlamaLaunchPlan({ binary: "llama-server", modelPath: "/x.gguf", modelId: "x", endpoint: "http://0.0.0.0:11435" })).toThrow(/loopback/);
  });

  it("recognizes the managed server process by its executable name", () => {
    expect(isLlamaServerCommand("/opt/homebrew/bin/llama-server --model /private/model.gguf")).toBe(true);
    expect(isLlamaServerCommand("/tmp/not-llama-server-helper --model x")).toBe(false);
  });

  it("prefers a configured binary, then HII's bundle, then PATH", () => {
    const root = tempDirectory();
    const configured = path.join(root, "configured");
    const bundled = path.join(root, "bundle", "llama-server");
    const pathBinary = path.join(root, "path", "llama-server");
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.mkdirSync(path.dirname(pathBinary), { recursive: true });
    for (const binary of [configured, bundled, pathBinary]) fs.writeFileSync(binary, "binary");

    expect(resolveMacLlamaServerBin({ configuredPath: configured, bundledPath: bundled, pathPath: pathBinary })).toBe(configured);
    expect(resolveMacLlamaServerBin({ bundledPath: bundled, pathPath: pathBinary })).toBe(bundled);
    expect(resolveMacLlamaServerBin({ pathPath: pathBinary })).toBe(pathBinary);
    expect(resolveMacLlamaServerBin({ bundledPath: path.join(root, "missing") })).toBeNull();
  });
});
