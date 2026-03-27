import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../config.js';
import { lmStudioChat, lmStudioTranscribe } from '../clients/lmstudio.js';

type AudioNoteOptions = {
  title?: string;
  outputDir?: string;
  chatModel?: string;
  transcribeModel?: string;
  keepTranscript?: boolean;
  baseUrl?: string;
  apiKey?: string;
};

type AudioNoteResult = {
  transcript: string;
  markdown: string;
  notePath: string;
  transcriptPath?: string;
};

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}

export async function createAudioNote(cfg: Config, audioPath: string, options?: AudioNoteOptions): Promise<AudioNoteResult> {
  const resolvedAudio = path.resolve(audioPath);
  const baseUrl = options?.baseUrl || cfg.lmStudioUrl;
  const apiKey = options?.apiKey || cfg.lmStudioApiKey;
  const transcribeModel = options?.transcribeModel || cfg.lmStudioTranscribeModel;
  const chatModel = options?.chatModel || cfg.lmStudioChatModel;
  const outputDir = path.resolve(options?.outputDir || cfg.notesPath || path.join(cfg.workspacePath, 'notes'));

  if (!fs.existsSync(resolvedAudio)) throw new Error(`Audio file not found: ${resolvedAudio}`);

  const transcript = await lmStudioTranscribe(transcribeModel, resolvedAudio, { baseUrl, apiKey });

  const title = options?.title?.trim() || `${path.basename(audioPath, path.extname(audioPath)) || 'Audio Note'} ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const filename = `${slugify(title)}.md`;
  ensureDir(outputDir);
  const notePath = path.join(outputDir, filename);

  const system = 'You are a meticulous note-taking assistant. Turn transcripts into concise Markdown notes with sorted ideas and actionable structure.';
  const userPrompt = `Create a Markdown note from the transcript. Include sections: Summary, Key Points, Decisions (if any), Action Items (markdown checkboxes), Ideas & Thoughts (group ideas by theme and order by importance), Open Questions. Keep bullets short.\n\nTranscript:\n${transcript}`;
  const markdownBody = await lmStudioChat(chatModel, [
    { role: 'system', content: system },
    { role: 'user', content: userPrompt }
  ], { baseUrl, apiKey, temperature: 0.35 });

  const header = [
    '---',
    `title: ${title}`,
    `source_audio: ${path.basename(audioPath)}`,
    `transcribed_at: ${new Date().toISOString()}`,
    `transcription_model: ${transcribeModel}`,
    `note_model: ${chatModel}`,
    '---',
    ''
  ].join('\n');

  const markdown = `${header}${markdownBody.trim()}`;
  fs.writeFileSync(notePath, markdown);

  let transcriptPath: string | undefined;
  if (options?.keepTranscript) {
    transcriptPath = path.join(outputDir, `${slugify(title)}.transcript.md`);
    const transcriptContent = [`# Transcript for ${title}`, '', transcript].join('\n');
    fs.writeFileSync(transcriptPath, transcriptContent);
  }

  return { transcript, markdown, notePath, transcriptPath };
}
