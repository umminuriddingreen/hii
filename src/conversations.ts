import fs from 'node:fs';
import path from 'node:path';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const CONVERSATIONS_DIR = path.join(HII_DIR, 'conversations');
const LEDGER_FILE = path.join(CONVERSATIONS_DIR, 'bridge.jsonl');
const TRANSCRIPTS_DIR = path.join(CONVERSATIONS_DIR, 'transcripts');

export type ConversationEntry = {
  timestamp: string;
  from: string;
  to: string;
  type: string;
  content: string;
};

export type ConversationSummary = {
  ledgerPath: string;
  transcriptDir: string;
  ledgerEntries: number;
  transcriptFiles: string[];
  latestTimestamp?: string;
};

function ensureDirs(): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

function appendJsonl(entry: ConversationEntry): void {
  ensureDirs();
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n');
}

function appendTranscriptBlock(transcriptPath: string, header: string, body: string): void {
  const exists = fs.existsSync(transcriptPath);
  const prefix = exists ? '' : `---\ncreated: ${new Date().toISOString()}\n---\n\n# Bridge Transcript ${path.basename(transcriptPath, '.md')}\n`;
  fs.appendFileSync(transcriptPath, prefix + header + body);
}

export function conversationPaths() {
  ensureDirs();
  return {
    root: CONVERSATIONS_DIR,
    ledger: LEDGER_FILE,
    transcripts: TRANSCRIPTS_DIR,
  };
}

export function readConversationLedger(): ConversationEntry[] {
  ensureDirs();
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const entries: ConversationEntry[] = [];
  const lines = fs.readFileSync(LEDGER_FILE, 'utf-8').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push({
        timestamp: String(parsed.timestamp || ''),
        from: String(parsed.from || 'unknown'),
        to: String(parsed.to || 'all'),
        type: String(parsed.type || 'message'),
        content: String(parsed.content || ''),
      });
    } catch {
      continue;
    }
  }
  return entries;
}

export function readRecentConversationEntries(limit = 20): ConversationEntry[] {
  const entries = readConversationLedger();
  return entries.slice(-Math.max(1, limit));
}

export function conversationSummary(): ConversationSummary {
  ensureDirs();
  const entries = readConversationLedger();
  const transcriptFiles = fs.existsSync(TRANSCRIPTS_DIR)
    ? fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => name.endsWith('.md')).sort()
    : [];
  return {
    ledgerPath: LEDGER_FILE,
    transcriptDir: TRANSCRIPTS_DIR,
    ledgerEntries: entries.length,
    transcriptFiles,
    latestTimestamp: entries.length ? entries[entries.length - 1].timestamp : undefined,
  };
}

export function appendConversationTurn(input: {
  source: string;
  prompt: string;
  answer: string;
  tools?: string[];
}): void {
  const ts = new Date().toISOString();
  const dayFile = path.join(TRANSCRIPTS_DIR, `${ts.slice(0, 10)}.md`);
  const userEntry: ConversationEntry = {
    timestamp: ts,
    from: input.source,
    to: 'hii',
    type: 'prompt',
    content: input.prompt,
  };
  const assistantEntry: ConversationEntry = {
    timestamp: ts,
    from: 'hii',
    to: input.source,
    type: 'answer',
    content: input.answer,
  };
  appendJsonl(userEntry);
  appendJsonl(assistantEntry);
  const toolLine = input.tools && input.tools.length ? `\n- tools: ${input.tools.join(', ')}\n` : '';
  appendTranscriptBlock(
    dayFile,
    `\n## ${ts}\n- from: ${input.source}\n- to: hii\n- type: prompt\n\n`,
    `${input.prompt}\n\n## ${ts}\n- from: hii\n- to: ${input.source}\n- type: answer\n\n${input.answer}${toolLine}`,
  );
}

export function listConversationTranscripts(): string[] {
  ensureDirs();
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return [];
  return fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => name.endsWith('.md')).sort().reverse();
}

export function readConversationTranscript(fileName: string): string {
  ensureDirs();
  const filePath = path.resolve(TRANSCRIPTS_DIR, fileName);
  if (!filePath.startsWith(TRANSCRIPTS_DIR)) {
    throw new Error('invalid transcript name');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`transcript not found: ${fileName}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export function formatConversationEntries(entries: ConversationEntry[]): string {
  if (!entries.length) return 'No conversation entries found.';
  return entries.map((entry) => {
    const head = `${entry.timestamp} ${entry.from} -> ${entry.to} | ${entry.type}`;
    return `${head}\n${entry.content}`;
  }).join('\n\n---\n\n');
}
