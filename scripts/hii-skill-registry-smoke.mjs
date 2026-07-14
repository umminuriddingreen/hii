#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hii-skills-"));
process.env.HII_RUNTIME_DIR = temporary;

const { reportAgentAction, runSkillCommand, skillRegistryPaths } = await import("../aii/skills/registry.mjs");

function capture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

try {
  const first = reportAgentAction({
    agent: { id: "codex", kind: "codex", model: "test-model" },
    project: { id: "hii", root: "/tmp/example" },
    intent: "Make a workflow reusable",
    summary: "Verify a HII build and preserve a receipt",
    commands: ["TOKEN=private-value npm run build"],
    files: ["package.json"],
    outcome: "completed",
    verification: {
      status: "verified",
      checks: ["npm run build"],
      proof: ["build completed"]
    },
    risk: {
      tier: "change",
      permissions: ["edit approved repository"],
      sideEffects: ["writes build output"]
    },
    repeatable: true,
    skillHint: {
      id: "verify-hii-build",
      name: "Verify HII Build",
      description: "Build HII and preserve reviewable verification evidence."
    }
  });

  assert.equal(first.receipt.kind, "hii.agent-action-receipt");
  assert.equal(first.receipt.commands[0], "TOKEN=[redacted] npm run build");
  assert.equal(first.proposal.id, "verify-hii-build");
  assert.ok(fs.existsSync(skillRegistryPaths().registry));
  assert.ok(fs.existsSync(path.join(skillRegistryPaths().proposed, "verify-hii-build", "SKILL.md")));

  capture(() => runSkillCommand([
    "create",
    "verify-hii-build",
    "--description",
    "Build HII and preserve reviewable verification evidence.",
    "--instructions",
    "Inspect the worktree, run the approved HII build, capture the result, and report the receipt.",
    "--verify",
    "npm run build",
    "--permissions",
    "read and build the approved HII repository",
    "--side-effects",
    "writes local build output",
    "--from-report",
    first.receipt.id
  ]));

  const registeredOutput = capture(() => runSkillCommand([
    "register",
    "verify-hii-build",
    "--reviewed-by",
    "test-operator"
  ]));
  assert.match(registeredOutput, /registered verify-hii-build/);

  const registry = JSON.parse(fs.readFileSync(skillRegistryPaths().registry, "utf8"));
  assert.equal(registry.skills.length, 1);
  assert.equal(registry.skills[0].trustLevel, "operator-reviewed");
  assert.ok(fs.existsSync(path.join(registry.skills[0].path, "manifest.json")));

  capture(() => runSkillCommand([
    "export",
    "verify-hii-build",
    "--include-provenance",
    "--price-cents",
    "2500",
    "--currency",
    "usd"
  ]));
  const exported = fs.readdirSync(skillRegistryPaths().exports)
    .find((file) => file.endsWith(".hii-skill.json"));
  assert.ok(exported);
  const skillPackage = JSON.parse(fs.readFileSync(path.join(skillRegistryPaths().exports, exported), "utf8"));
  assert.equal(skillPackage.exportKind, "hii.skill-package");
  assert.equal(skillPackage.localOnly, true);
  assert.equal(skillPackage.distribution.price.amountCents, 2500);
  assert.equal(skillPackage.distribution.published, false);
  assert.equal(skillPackage.provenance.receipts.length, 1);

  const doctorOutput = capture(() => runSkillCommand(["doctor"]));
  assert.match(doctorOutput, /status:\s+ok/);

  const unverified = reportAgentAction({
    agent: "claude",
    summary: "An unverified repeatable action",
    repeatable: true,
    skillId: "unverified-action"
  });
  assert.ok(unverified.proposal);
  assert.throws(
    () => capture(() => runSkillCommand(["register", "unverified-action", "--reviewed-by", "test-operator"])),
    /verification command or a verified source receipt/
  );

  console.log("HII skill registry smoke");
  console.log("status:       ok");
  console.log("receipts:    2");
  console.log("registered:  1");
  console.log("draft gate:  verified");
  console.log("export:      local portable package verified");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
