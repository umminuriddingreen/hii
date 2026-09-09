// SPDX-License-Identifier: LicenseRef-BSL-1.1

import type { NodeSeed } from './ingest';
import type { SpatialObjectMetadata, WorkspaceNodeType } from './types';

/**
 * Semantic types for process output.
 *
 * A shell throws away almost everything it knows. `python daylight.py` produced
 * a table, an image, and a metrics file, and the terminal reduced all three to
 * the same undifferentiated bytes, leaving the user to read paths back out and
 * open them by hand.
 *
 * Classification here is deliberately conservative. A wrong guess is worse than
 * no guess: text mistyped as a table renders as a broken grid, and a path
 * mistaken for an artifact puts a node on the canvas pointing at nothing. Every
 * rule below requires positive evidence, and anything unproven stays `text`.
 */

export type StdoutType = 'text' | 'table' | 'json' | 'image' | 'geometry' | 'artifact' | 'error';

export type StdoutChunk = {
  type: StdoutType;
  /** The original text, always preserved — the typed view never replaces the log. */
  raw: string;
  /** Parsed form, when the type carries one. */
  value?: unknown;
  /** Filesystem path or URL, for `image`, `geometry`, and `artifact`. */
  path?: string;
};

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?)$/i;
const GEOMETRY_EXT = /\.(glb|gltf|obj|stl|ply|fbx|usdz?|usdc|3dm|step|stp|iges|igs|dxf|dwg)$/i;
const DATA_EXT = /\.(csv|tsv|json|jsonl|ndjson|parquet|xlsx?|pdf|md|txt|log|ya?ml|toml)$/i;

/** A line that is only a path, optionally quoted — the shape a script prints when it saved something. */
const BARE_PATH = /^\s*["']?((?:[.~]{0,2}\/|\/)?(?:[\w .+-]+\/)*[\w .+-]+\.[A-Za-z0-9]{1,8})["']?\s*$/;

/** `wrote: out.csv`, `saved -> heatmap.png`, `output = metrics.json`. */
const LABELED_PATH =
  /^\s*(?:wrote|saved|written|created|generated|output|exported|rendering|rendered)\b[^\S\n]*[:=]?[^\S\n]*(?:to[^\S\n]+)?(?:->[^\S\n]*)?["']?((?:[.~]{0,2}\/|\/)?(?:[\w .+-]+\/)*[\w .+-]+\.[A-Za-z0-9]{1,8})["']?\s*$/i;

const ERROR_SIGNAL =
  /^\s*(?:Traceback \(most recent call last\)|[A-Za-z_][\w.]*(?:Error|Exception)\b|error\b|fatal\b|panic\b|command not found|No such file or directory)/im;

export function stripAnsi(value: string) {
  return String(value ?? '').replace(ANSI, '');
}

function pathType(path: string): StdoutType | null {
  if (IMAGE_EXT.test(path)) return 'image';
  if (GEOMETRY_EXT.test(path)) return 'geometry';
  if (DATA_EXT.test(path)) return 'artifact';
  return null;
}

/**
 * Detect a delimiter-separated table.
 *
 * Requires at least two rows and a *consistent* column count, because a run of
 * prose containing commas is not a table and rendering it as one is how a
 * terminal starts lying about its output.
 */
function tableFrom(lines: string[]): { rows: string[][]; delimiter: string } | null {
  for (const delimiter of ['\t', ',', '|']) {
    const rows = lines.map((line) =>
      delimiter === '|'
        ? line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
        : line.split(delimiter).map((cell) => cell.trim())
    );
    const width = rows[0]?.length ?? 0;
    if (width < 2) continue;
    // Markdown separator rows (---|---) are structure, not data.
    const data = rows.filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
    if (data.length < 2) continue;
    if (!data.every((row) => row.length === width)) continue;
    if (data.some((row) => row.every((cell) => !cell))) continue;
    return { rows: data, delimiter };
  }
  return null;
}

function jsonFrom(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed) || !/[\]}]$/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Classify one chunk of process output.
 *
 * `stream` is the honest signal for errors — a program that wrote to stderr said
 * so itself, and that beats pattern-matching its prose.
 */
export function classifyStdout(raw: string, stream: 'stdout' | 'stderr' = 'stdout'): StdoutChunk {
  const text = stripAnsi(raw);
  const trimmed = text.trim();
  if (!trimmed) return { type: 'text', raw };

  if (stream === 'stderr' || ERROR_SIGNAL.test(trimmed)) return { type: 'error', raw, value: trimmed };

  const lines = trimmed.split('\n').map((line) => line.trimEnd()).filter(Boolean);

  if (lines.length === 1) {
    const match = lines[0].match(LABELED_PATH) || lines[0].match(BARE_PATH);
    const path = match?.[1];
    const type = path ? pathType(path) : null;
    if (path && type) return { type, raw, path };
  }

  const parsed = jsonFrom(trimmed);
  if (parsed !== undefined) return { type: 'json', raw, value: parsed };

  const table = tableFrom(lines);
  if (table) return { type: 'table', raw, value: table.rows };

  return { type: 'text', raw, value: trimmed };
}

/**
 * Every artifact a run announced, in order, de-duplicated by path.
 *
 * This is what turns `python daylight.py` into three objects instead of three
 * lines of text the user has to open by hand.
 */
export function artifactsFromOutput(raw: string): StdoutChunk[] {
  const seen = new Set<string>();
  const found: StdoutChunk[] = [];
  for (const line of stripAnsi(raw).split('\n')) {
    const match = line.match(LABELED_PATH) || line.match(BARE_PATH);
    const path = match?.[1];
    if (!path || seen.has(path)) continue;
    const type = pathType(path);
    if (!type) continue;
    seen.add(path);
    found.push({ type, raw: line, path });
  }
  return found;
}

const SEED_SHAPE: Record<StdoutType, { type: WorkspaceNodeType; w: number; h: number }> = {
  image: { type: 'image', w: 380, h: 300 },
  geometry: { type: 'model', w: 420, h: 340 },
  artifact: { type: 'file', w: 320, h: 200 },
  table: { type: 'document', w: 520, h: 320 },
  json: { type: 'document', w: 440, h: 300 },
  text: { type: 'note', w: 380, h: 220 },
  error: { type: 'note', w: 420, h: 240 }
};

/**
 * Turn typed output into canvas objects.
 *
 * Provenance is not optional here. Each seed records the run that produced it
 * and the command that was executed, because an artifact whose origin is
 * unknown is exactly the kind of object a later agent should not trust — and
 * this is the moment the origin is still known.
 */
export function seedsFromRunOutput(input: {
  output: string;
  command?: string;
  runId?: string;
  receiptPath?: string;
}): NodeSeed[] {
  const chunks = artifactsFromOutput(input.output);
  const at = new Date().toISOString();
  const source = input.command ? `stdout of \`${input.command}\`` : 'run output';

  return chunks.map((chunk) => {
    const shape = SEED_SHAPE[chunk.type];
    const object: SpatialObjectMetadata = {
      kind: 'artifact',
      owner: 'agent',
      status: 'ready',
      source,
      runId: input.runId,
      proofRefs: input.receiptPath ? [input.receiptPath] : undefined,
      audit: [{ ts: at, actor: 'hii', action: 'captured run artifact', note: chunk.path }]
    };
    return {
      type: shape.type,
      w: shape.w,
      h: shape.h,
      object,
      payload: {
        name: chunk.path?.split('/').pop() || 'artifact',
        path: chunk.path,
        stdoutType: chunk.type,
        producedBy: input.command,
        runId: input.runId
      }
    };
  });
}
