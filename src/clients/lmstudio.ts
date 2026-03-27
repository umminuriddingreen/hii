import fetch, { Blob, FormData } from 'node-fetch';
import fs from 'node:fs';
import path from 'node:path';

export type LMStudioMessage = { role: 'system'|'user'|'assistant'; content: string };

function buildUrl(baseUrl: string | undefined, route: string): string {
  const base = (baseUrl || process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
  return `${base}${route}`;
}

function authHeader(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function lmStudioChat(model: string, messages: LMStudioMessage[], opts?: { baseUrl?: string; temperature?: number; apiKey?: string }): Promise<string> {
  const url = buildUrl(opts?.baseUrl, '/chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(opts?.apiKey) },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? 0.25
    })
  });
  if (!res.ok) throw new Error(`LM Studio chat error: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const text: string | undefined = data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error('LM Studio chat returned empty response');
  return text.trim();
}

export async function lmStudioTranscribe(model: string, filePath: string, opts?: { baseUrl?: string; prompt?: string; temperature?: number; language?: string; apiKey?: string }): Promise<string> {
  if (!fs.existsSync(filePath)) throw new Error(`Audio file not found: ${filePath}`);
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  const blob = new Blob([buffer]);
  form.append('file', blob, path.basename(filePath));
  form.append('model', model);
  if (opts?.prompt) form.append('prompt', opts.prompt);
  if (opts?.temperature !== undefined) form.append('temperature', String(opts.temperature));
  if (opts?.language) form.append('language', opts.language);

  const url = buildUrl(opts?.baseUrl, '/audio/transcriptions');
  const res = await fetch(url, { method: 'POST', headers: authHeader(opts?.apiKey), body: form as any });
  if (!res.ok) throw new Error(`LM Studio transcription error: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const text: string | undefined = data?.text || data?.text?.content || data?.data?.text;
  if (!text || !text.trim()) throw new Error('LM Studio transcription returned empty response');
  return text.trim();
}
