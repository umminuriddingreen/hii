// SPDX-License-Identifier: LicenseRef-BSL-1.1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_TOKEN_BUDGET = 800;
const MAX_TOKEN_BUDGET = 4_096;
const MAX_MEMORY_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_CHARS = 2_400;
const MAX_SELECTED_CHUNKS = 4;
const STOP_WORDS = new Set([
  "about", "after", "again", "agent", "before", "build", "codex", "could", "from",
  "have", "hii", "implement", "into", "more", "please", "should", "that", "their",
  "them", "then", "this", "through", "ummi", "users", "using", "want", "with", "would"
]);

export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? ""), "utf8") / 4);
}

export function codexMemoryTokenBudget(value = process.env.HII_CODEX_MEMORY_TOKEN_BUDGET) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_TOKEN_BUDGET), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TOKEN_BUDGET;
  if (parsed === 0) return 0;
  return Math.max(128, Math.min(parsed, MAX_TOKEN_BUDGET));
}

function terms(value) {
  return [...new Set(String(value ?? "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term));
}

function queryTerms(value) {
  const direct = new Set(terms(value));
  const expanded = new Set();
  if (["efficient", "faster", "token", "tokens"].some((term) => direct.has(term))) {
    for (const term of ["budget", "compaction", "discipline", "saving", "waste"]) expanded.add(term);
  }
  if (["memory", "pipeline", "retrieval"].some((term) => direct.has(term))) {
    for (const term of ["context", "retrieval"]) expanded.add(term);
  }
  for (const term of direct) expanded.delete(term);
  return { direct: [...direct], expanded: [...expanded] };
}

function redactMemory(value) {
  return String(value ?? "")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

function memoryChunks(source) {
  const lines = source.split(/\r?\n/);
  const sections = [];
  let parentTitle = "Memory";
  let title = parentTitle;
  let start = 1;
  let body = [];

  const flushSection = () => {
    if (body.some((line) => line.trim())) sections.push({ title, start, lines: body });
    body = [];
  };

  lines.forEach((line, index) => {
    const heading = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flushSection();
      if (heading[1].length === 1) parentTitle = heading[2];
      title = heading[1].length === 1 ? parentTitle : `${parentTitle} / ${heading[2]}`;
      start = index + 1;
    }
    body.push(line);
  });
  flushSection();

  const chunks = [];
  for (const section of sections) {
    let chunkLines = [];
    let chunkStart = section.start;
    section.lines.forEach((line, offset) => {
      const nextSize = chunkLines.join("\n").length + line.length + 1;
      if (chunkLines.length && nextSize > MAX_CHUNK_CHARS) {
        chunks.push({
          title: section.title,
          lineStart: chunkStart,
          lineEnd: section.start + offset - 1,
          lines: chunkLines
        });
        chunkLines = [];
        chunkStart = section.start + offset;
      }
      chunkLines.push(line);
    });
    if (chunkLines.some((line) => line.trim())) {
      chunks.push({
        title: section.title,
        lineStart: chunkStart,
        lineEnd: chunkStart + chunkLines.length - 1,
        lines: chunkLines
      });
    }
  }
  return chunks;
}

function rankedChunks(source, prompt, coordinate) {
  const selectedTerms = queryTerms(`${prompt} ${coordinate}`);
  if (!selectedTerms.direct.length) return [];
  const coordinateText = String(coordinate ?? "").toLowerCase();
  const coordinatePattern = coordinateText
    ? new RegExp(`${coordinateText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|[\\s),]|$)`)
    : null;
  const seen = new Set();

  const ranked = memoryChunks(source)
    .map((chunk) => {
      const text = chunk.lines.join("\n");
      const fingerprint = text.toLowerCase().replace(/\s+/g, " ").trim();
      if (!fingerprint || seen.has(fingerprint)) return null;
      seen.add(fingerprint);
      const titleTerms = new Set(terms(chunk.title));
      const contentTerms = new Set(terms(text));
      const directMatches = selectedTerms.direct.filter((term) => contentTerms.has(term));
      const expandedMatches = selectedTerms.expanded.filter((term) => contentTerms.has(term));
      let score = directMatches.length * 2 + expandedMatches.length;
      score += selectedTerms.direct.filter((term) => titleTerms.has(term)).length * 6;
      score += selectedTerms.expanded.filter((term) => titleTerms.has(term)).length * 2;
      if (coordinatePattern?.test(text.toLowerCase())) score += 3;
      return score > 0 ? { ...chunk, text, score, matches: directMatches.length + expandedMatches.length } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.matches - left.matches || left.lineStart - right.lineStart);
  const scoreFloor = ranked.length ? Math.max(2, Math.ceil(ranked[0].score / 2)) : 2;
  return ranked.filter((chunk) => chunk.score >= scoreFloor);
}

function fitCandidate(candidate, prefix, suffix, tokenBudget) {
  const lines = redactMemory(candidate.text).split("\n");
  for (let length = lines.length; length > 0; length -= 1) {
    const lineEnd = candidate.lineStart + length - 1;
    const adjustedLabel = `### MEMORY.md:L${candidate.lineStart}-L${lineEnd} — ${candidate.title}`;
    const block = `${adjustedLabel}\n${lines.slice(0, length).join("\n").trim()}\n`;
    if (estimateTokens(`${prefix}${block}${suffix}`) <= tokenBudget) {
      return { block, lineEnd };
    }
  }
  return null;
}

export function buildCodexMemoryPack({
  prompt,
  coordinate,
  memoryFile = process.env.HII_CODEX_MEMORY_FILE || path.join(os.homedir(), ".codex", "memories", "MEMORY.md"),
  tokenBudget = codexMemoryTokenBudget(),
  maxMemoryBytes = MAX_MEMORY_BYTES
} = {}) {
  const budget = codexMemoryTokenBudget(tokenBudget);
  if (budget === 0) {
    return { ok: false, reason: "hii-memory-disabled", source: memoryFile, tokenBudget: budget };
  }
  let stat;
  try {
    stat = fs.statSync(memoryFile);
  } catch {
    return { ok: false, reason: "memory-file-missing", source: memoryFile, tokenBudget: budget };
  }
  if (!stat.isFile()) return { ok: false, reason: "memory-source-not-file", source: memoryFile, tokenBudget: budget };
  if (stat.size > maxMemoryBytes) {
    return { ok: false, reason: "memory-file-over-limit", source: memoryFile, sourceBytes: stat.size, tokenBudget: budget };
  }

  let source;
  try {
    source = fs.readFileSync(memoryFile, "utf8");
  } catch {
    return { ok: false, reason: "memory-file-unreadable", source: memoryFile, tokenBudget: budget };
  }
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const candidates = rankedChunks(source, prompt, coordinate);
  if (!candidates.length) {
    return { ok: false, reason: "no-relevant-memory", source: memoryFile, sourceBytes: stat.size, sourceSha256, tokenBudget: budget };
  }

  const header = [
    '<HII_MEMORY_CONTEXT version="1">',
    "Focused read-only memory selected deterministically by HII. Current user intent and live evidence override it.",
    `source=${memoryFile}`,
    `source_sha256=${sourceSha256}`,
    `token_budget=${budget}`,
    ""
  ].join("\n");
  const footer = "</HII_MEMORY_CONTEXT>";
  let text = header;
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= MAX_SELECTED_CHUNKS) break;
    const fitted = fitCandidate(candidate, text, footer, budget);
    if (!fitted) continue;
    text += fitted.block;
    selected.push({
      lineStart: candidate.lineStart,
      lineEnd: fitted.lineEnd,
      title: candidate.title,
      score: candidate.score
    });
  }
  text += footer;
  if (!selected.length) {
    return { ok: false, reason: "budget-too-small", source: memoryFile, sourceBytes: stat.size, sourceSha256, tokenBudget: budget };
  }

  return {
    ok: true,
    reason: "focused-memory-ready",
    strategy: "hii-focused-memory-v1",
    source: memoryFile,
    sourceBytes: stat.size,
    sourceSha256,
    tokenBudget: budget,
    estimatedTokens: estimateTokens(text),
    selected,
    text
  };
}

export function codexExecInvocation({ prompt, coordinate, memoryPack }) {
  const args = ["exec"];
  let effectivePrompt = String(prompt ?? "");
  if (memoryPack?.ok && memoryPack.text) {
    args.push("--disable", "memories");
    effectivePrompt += `\n\n${memoryPack.text}`;
  }
  args.push("--skip-git-repo-check", "--cd", coordinate, effectivePrompt);
  return { args, effectivePrompt, usesHiiMemory: Boolean(memoryPack?.ok && memoryPack.text) };
}
