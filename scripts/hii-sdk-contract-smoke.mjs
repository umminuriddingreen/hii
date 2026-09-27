#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.HII_ROOT
  ? path.resolve(process.env.HII_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = path.join(ROOT, "runtime", "capabilities", "registry.json");
const JOBS = path.join(ROOT, ".hii", "capability-jobs.jsonl");
const CAPABILITY_READER = path.join(ROOT, "lib", "capabilities", "index.ts");
const CLI = path.join(ROOT, "scripts", "hii-cli.mjs");

const allowed = {
  runtime: new Set([
    "next-route",
    "local-cli",
    "local-process",
    "managed-operator",
    "trusted-runner",
    "supabase-flow",
    "chrome-extension",
    "ollama",
    "cloudflare-worker",
    "webgl"
  ]),
  visibility: new Set(["local", "authenticated", "public"]),
  status: new Set(["ready", "partial", "blocked", "planned"]),
  trustLevel: new Set(["first-party", "operator-reviewed", "experimental"]),
  jobStatus: new Set(["queued", "running", "waiting_approval", "completed", "failed", "cancelled"]),
  proofKind: new Set(["log", "screenshot", "download", "receipt", "link", "json"]),
  ledgerType: new Set([
    "credit_topup",
    "quote",
    "reservation",
    "approval",
    "compute_cost",
    "platform_fee",
    "proof",
    "refund",
    "reconciliation"
  ])
};

const requiredCapabilityFields = [
  "id",
  "name",
  "owner",
  "runtime",
  "summary",
  "inputs",
  "outputs",
  "permissions",
  "visibility",
  "costModel",
  "evidence",
  "status",
  "trustLevel"
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return { value: JSON.parse(line), line: index + 1 };
        } catch (error) {
          return { error, line: index + 1 };
        }
      });
  } catch {
    return [];
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function pushIssue(issues, where, message) {
  issues.push({ where, message });
}

function validateCapabilities(registry) {
  const issues = [];
  if (!Array.isArray(registry)) {
    pushIssue(issues, "registry", "registry must be a JSON array");
    return issues;
  }

  const ids = new Set();
  for (const capability of registry) {
    const where = capability?.id || "capability";
    for (const field of requiredCapabilityFields) {
      if (!(field in capability)) pushIssue(issues, where, `missing required field ${field}`);
    }
    if (!isNonEmptyString(capability.id)) pushIssue(issues, where, "id must be a non-empty string");
    if (ids.has(capability.id)) pushIssue(issues, where, "duplicate capability id");
    ids.add(capability.id);
    if (!isNonEmptyString(capability.name)) pushIssue(issues, where, "name must be a non-empty string");
    if (!allowed.runtime.has(capability.runtime)) pushIssue(issues, where, `runtime ${capability.runtime} is not allowed`);
    if (!allowed.visibility.has(capability.visibility)) pushIssue(issues, where, `visibility ${capability.visibility} is not allowed`);
    if (!allowed.status.has(capability.status)) pushIssue(issues, where, `status ${capability.status} is not allowed`);
    if (!allowed.trustLevel.has(capability.trustLevel)) pushIssue(issues, where, `trustLevel ${capability.trustLevel} is not allowed`);
    for (const field of ["inputs", "outputs", "permissions", "evidence"]) {
      if (!hasStringArray(capability[field])) pushIssue(issues, where, `${field} must be a non-empty string array`);
    }
    if (!capability.costModel || typeof capability.costModel !== "object" || !isNonEmptyString(capability.costModel.type)) {
      pushIssue(issues, where, "costModel.type is required");
    }
  }
  return issues;
}

function validateJobs(jobRows, registry) {
  const issues = [];
  const capabilityIds = new Set(registry.map((capability) => capability.id));
  for (const row of jobRows) {
    if (row.error) {
      pushIssue(issues, `jobs:${row.line}`, "invalid JSONL row");
      continue;
    }
    const job = row.value;
    const where = `jobs:${row.line}:${job?.id || "job"}`;
    if (!isNonEmptyString(job.id)) pushIssue(issues, where, "id must be a non-empty string");
    if (!capabilityIds.has(job.capabilityId)) pushIssue(issues, where, `unknown capabilityId ${job.capabilityId}`);
    if (!allowed.jobStatus.has(job.status)) pushIssue(issues, where, `status ${job.status} is not allowed`);
    for (const proof of job.proofArtifacts ?? []) {
      if (!allowed.proofKind.has(proof.kind)) pushIssue(issues, where, `proof kind ${proof.kind} is not allowed`);
      if (!isNonEmptyString(proof.id) || !isNonEmptyString(proof.label) || !isNonEmptyString(proof.createdAt)) {
        pushIssue(issues, where, "proof artifacts require id, label, and createdAt");
      }
    }
    for (const entry of job.ledger ?? []) {
      if (!allowed.ledgerType.has(entry.type)) pushIssue(issues, where, `ledger type ${entry.type} is not allowed`);
    }
  }
  return issues;
}

function validateStaticParity() {
  const issues = [];
  const capabilityReader = fs.readFileSync(CAPABILITY_READER, "utf8");
  const cli = fs.readFileSync(CLI, "utf8");
  if (!capabilityReader.includes("listCapabilities")) {
    pushIssue(issues, "lib/capabilities", "reader should expose listCapabilities()");
  }
  if (!cli.includes("CAPABILITY_REGISTRY")) {
    pushIssue(issues, "hii-cli", "CLI should read CAPABILITY_REGISTRY");
  }
  return issues;
}

function latestJobs(jobRows) {
  const latest = new Map();
  for (const row of jobRows) {
    if (!row.value?.id) continue;
    latest.set(row.value.id, row.value);
  }
  return Array.from(latest.values());
}

function summarize(registry, jobRows, issues) {
  const jobs = latestJobs(jobRows);
  return {
    ok: issues.length === 0,
    capabilities: registry.length,
    jobs: jobs.length,
    capabilityStatuses: Array.from(new Set(registry.map((capability) => capability.status))).sort(),
    jobStatuses: Array.from(new Set(jobs.map((job) => job.status))).sort(),
    proofKinds: Array.from(new Set(jobs.flatMap((job) => (job.proofArtifacts ?? []).map((proof) => proof.kind)))).sort(),
    issues
  };
}

const json = process.argv.includes("--json");
const registry = readJson(REGISTRY);
const jobRows = readJsonl(JOBS);
const issues = [
  ...validateCapabilities(registry),
  ...validateJobs(jobRows, registry),
  ...validateStaticParity()
];
const summary = summarize(registry, jobRows, issues);

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("HII SDK contract smoke\n");
  console.log(`capabilities: ${summary.capabilities}`);
  console.log(`jobs:         ${summary.jobs}`);
  console.log(`cap states:   ${summary.capabilityStatuses.join(", ") || "-"}`);
  console.log(`job states:   ${summary.jobStatuses.join(", ") || "-"}`);
  console.log(`proof kinds:  ${summary.proofKinds.join(", ") || "-"}`);
  console.log(`status:       ${summary.ok ? "ok" : "failed"}`);
  if (issues.length) {
    console.log("\nIssues:");
    for (const issue of issues) console.log(`  ${issue.where}: ${issue.message}`);
  }
}

process.exit(summary.ok ? 0 : 1);
