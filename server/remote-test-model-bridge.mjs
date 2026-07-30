import { spawn } from 'node:child_process';
import http from 'node:http';

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('model request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function localCompletion({ ollamaUrl, body }) {
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: body.model,
      messages: body.messages,
      stream: false,
      think: false,
      options: { temperature: 0.1, num_ctx: 32768, repeat_penalty: 1.1, repeat_last_n: 256 }
    })
  });
  if (!response.ok) throw new Error(`local model HTTP ${response.status}`);
  const value = await response.json();
  return {
    text: value.message?.content ?? '',
    usage: {
      prompt_tokens: value.prompt_eval_count ?? 0,
      completion_tokens: value.eval_count ?? 0,
      total_tokens: (value.prompt_eval_count ?? 0) + (value.eval_count ?? 0)
    }
  };
}

async function codexCompletion({ codexBinary, workspace, body }) {
  const prompt = [
    'Act only as the language-model completion engine for HII.',
    'Do not call tools, inspect files, or narrate this wrapper.',
    'Follow the supplied conversation messages and return only the next assistant message.',
    body.response_format ? 'The assistant message must be one valid JSON object.' : '',
    JSON.stringify(body.messages ?? [])
  ].filter(Boolean).join('\n\n');
  return await new Promise((resolve, reject) => {
    const child = spawn(codexBinary, [
      '-m', 'gpt-5.5',
      '-a', 'never',
      '-s', 'read-only',
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--json',
      '-'
    ], {
      cwd: workspace,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(prompt);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`GPT-5.5 provider exited ${code}: ${stderr.trim().slice(-500)}`));
      const events = stdout.trim().split('\n').flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const text = events
        .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
        .map((event) => event.item.text)
        .at(-1);
      if (!text) return reject(new Error('GPT-5.5 provider returned no assistant message'));
      const usage = events.findLast((event) => event.type === 'turn.completed')?.usage ?? {};
      resolve({
        text,
        usage: {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        }
      });
    });
  });
}

export async function startModelBridge({
  port,
  workspace,
  codexBinary = 'codex',
  ollamaUrl = 'http://127.0.0.1:11434',
  localModel = 'qwen3.6:35b-mlx'
}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        return sendJson(res, 200, {
          data: [
            { id: localModel, object: 'model' },
            { id: 'gpt-5.5', object: 'model' }
          ]
        });
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        return sendJson(res, 404, { error: { message: 'not found' } });
      }
      const body = await readJson(req);
      if (![localModel, 'gpt-5.5'].includes(body.model)) {
        return sendJson(res, 400, { error: { message: `unknown model: ${body.model}` } });
      }
      const result = body.model === 'gpt-5.5'
        ? await codexCompletion({ codexBinary, workspace, body })
        : await localCompletion({ ollamaUrl, body });
      return sendJson(res, 200, {
        id: `hii-${Date.now()}`,
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage: result.usage
      });
    } catch (error) {
      return sendJson(res, 502, { error: { message: error.message } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
