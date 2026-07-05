import 'server-only';

type LocalLlmResult = {
  text: string;
  model: string;
  available: boolean;
};

const defaultModel = process.env.HII_LOCAL_INSTALLER_MODEL ?? 'fast-local:latest';

export async function askLocalInstallerModel(prompt: string): Promise<LocalLlmResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: defaultModel,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You are the local HII installer assistant. Give one concise next step. Never suggest arbitrary shell commands. Only refer to the whitelisted installer actions shown in the UI.'
          },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json();
    const text = String(data?.message?.content ?? '').trim();
    return {
      text: text || 'Use the next whitelisted installer action shown in the HII terminal.',
      model: defaultModel,
      available: true
    };
  } catch {
    return {
      text:
        'Local model unavailable. Use the installer actions in order: build, stage release, install Rhino bridge, open Rhino, run StartTermiteBridge, then doctor.',
      model: defaultModel,
      available: false
    };
  } finally {
    clearTimeout(timeout);
  }
}

