#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STORE_DIR = path.join(ROOT, ".hii");
const POSTS_PATH = path.join(STORE_DIR, "link-posts.jsonl");
const CACHE_INDEX_PATH = path.join(STORE_DIR, "link-cache.jsonl");
const CACHE_DIR = path.join(STORE_DIR, "link-cache");
const MAX_HTML_BYTES = Number(process.env.HII_LINKS_MAX_HTML_BYTES ?? 2_000_000);
const OLLAMA_MODEL = process.env.HII_LINKS_OLLAMA_MODEL || "fast-local";
const OLLAMA_URL = process.env.HII_OLLAMA_URL || "http://127.0.0.1:11434/api/generate";

const seedPosts = [
  {
    id: "seed-hii-runner-proof",
    url: "/termite",
    title: "Durable HII runner proof",
    note: "A paid Termite capability job was quoted, reserved, claimed by a local runner, completed, and returned ledger/proof artifacts.",
    tags: ["hii", "proof", "termite"],
    source: "local proof",
    createdAt: "2026-07-05T10:17:19.662Z"
  },
  {
    id: "seed-capability-terminal",
    url: "/terminal",
    title: "Capability terminal",
    note: "The agent OS surface shows processes, capabilities, jobs, terminal sessions, and proof receipts from one local command layer.",
    tags: ["agent-os", "terminal"],
    source: "hii",
    createdAt: "2026-07-05T09:44:07.595Z"
  },
  {
    id: "seed-exchange-spine",
    url: "/upload",
    title: "Exchange spine",
    note: "The older asset flow still supports upload, exchange links, Stripe checkout, signed downloads, and download proof.",
    tags: ["exchange", "links"],
    source: "hii",
    createdAt: "2026-06-30T09:16:31.000Z"
  }
];

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function safeName(post) {
  const slug = String(post.title || post.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "link";
  const hash = createHash("sha256").update(`${post.id}:${post.url}`).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|article|section|header|footer|main|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "user-agent": "hii-link-cache/0.1 local-offline-feed"
    }
  });
  if (!response.ok) throw new Error(`fetch failed with ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HTML_BYTES) throw new Error(`page exceeds ${MAX_HTML_BYTES} byte cache limit`);
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function summarizeWithOllama({ post, text }) {
  if (!text.trim()) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const prompt = [
      "Summarize this cached browser link for an offline personal feed.",
      "Return one compact paragraph under 70 words.",
      "Mention why it may be useful. Do not invent details.",
      "",
      `Title: ${post.title}`,
      `URL: ${post.url}`,
      `Note: ${post.note || ""}`,
      "",
      text.slice(0, 12_000)
    ].join("\n");
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `ollama failed with ${response.status}`);
    return String(data.response || "").replace(/\s+/g, " ").trim().slice(0, 700) || undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function cachePost(post) {
  const cachedAt = new Date().toISOString();
  if (!isHttpUrl(post.url)) {
    return {
      id: randomUUID(),
      postId: post.id,
      url: post.url,
      status: "failed",
      error: "local app route; no remote HTML cached",
      cachedAt
    };
  }

  const name = safeName(post);
  const htmlPath = path.join(CACHE_DIR, `${name}.html`);
  const textPath = path.join(CACHE_DIR, `${name}.txt`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const html = await fetchHtml(post.url);
  const text = stripHtml(html).slice(0, 200_000);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(textPath, `${text}\n`);
  let summary;
  let ollamaError;
  try {
    summary = await summarizeWithOllama({ post, text });
  } catch (error) {
    ollamaError = error instanceof Error ? error.message : String(error);
  }
  return {
    id: randomUUID(),
    postId: post.id,
    url: post.url,
    status: "cached",
    htmlPath,
    textPath,
    summary,
    error: ollamaError ? `cached; ollama summary unavailable: ${ollamaError}` : undefined,
    cachedAt
  };
}

async function main() {
  const recache = process.argv.includes("--recache");
  const posts = [...readJsonl(POSTS_PATH), ...seedPosts]
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const existing = readJsonl(CACHE_INDEX_PATH);
  const cachedPostIds = new Set(existing.filter((entry) => entry.status === "cached").map((entry) => entry.postId));
  const pending = recache ? posts : posts.filter((post) => !cachedPostIds.has(post.id));
  if (pending.length === 0) {
    console.log("No uncached links.");
    return;
  }

  let cached = 0;
  let failed = 0;
  for (const post of pending) {
    try {
      const entry = await cachePost(post);
      appendJsonl(CACHE_INDEX_PATH, entry);
      if (entry.status === "cached") cached += 1;
      else failed += 1;
      console.log(`${entry.status}: ${post.title}`);
    } catch (error) {
      failed += 1;
      const entry = {
        id: randomUUID(),
        postId: post.id,
        url: post.url,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        cachedAt: new Date().toISOString()
      };
      appendJsonl(CACHE_INDEX_PATH, entry);
      console.log(`failed: ${post.title} (${entry.error})`);
    }
  }
  console.log(`done: cached=${cached} failed=${failed} index=${CACHE_INDEX_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
