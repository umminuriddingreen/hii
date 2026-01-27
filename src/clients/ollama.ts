import fetch from 'node-fetch';

export type OllamaMessage = { role: 'system'|'user'|'assistant'|'tool'; content: string; tool_calls?: any[] };

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

export async function chat(model: string, messages: OllamaMessage[], options?: {stream?: boolean; temperature?: number; tools?: any[]}): Promise<{text: string}> {
  const body: any = {
    model,
    messages,
    stream: false,
    options: { temperature: options?.temperature ?? 0.2 },
  };
  if (options?.tools) body.tools = options.tools;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Ollama chat error: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const text: string = data?.message?.content ?? '';
  return { text };
}

export async function embed(model: string, input: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input })
  });
  if (!res.ok) throw new Error(`Ollama embed error: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  return data.embeddings as number[][];
}

