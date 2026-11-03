#!/usr/bin/env node
// Deterministic stand-in for an Ollama server, so the agent loop can be tested
// without a live model. Speaks the subset of the Ollama API that `cli/src/ollama.rs`
// actually uses: GET /api/tags, POST /api/show, POST /api/chat (NDJSON stream).
//
// Point the CLI at it with HII_MODEL_URL=http://127.0.0.1:<port>.
//
// The scripted step index is derived from the number of assistant turns in the
// incoming request rather than from server state, so the fixture stays correct
// across sequential runs and concurrent sessions without needing a reset.
//
// Usage: node fake_model.mjs [--scenario NAME] [--port N]
//   Prints "PORT=<n>" on stdout once listening.

import http from 'node:http';

const MODEL_NAME = 'fake-model';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
}

const scenarioName = flag('scenario', process.env.FAKE_MODEL_SCENARIO || 'happy_calc');
const port = Number(flag('port', process.env.FAKE_MODEL_PORT || '0'));

const action = (value) => JSON.stringify(value);

/** The fix the agent is expected to land in the calc_repo fixture. */
const CALC_SCRIPT = [
  action({ type: 'read', path: 'calc.py' }),
  action({
    type: 'edit',
    path: 'calc.py',
    old: 'return a - b',
    new: 'return a + b',
  }),
  action({ type: 'verify', command: 'python3 -m unittest -q' }),
  action({
    type: 'final',
    summary: 'add() returned a - b; corrected to a + b and the unit tests pass.',
    next: 'none',
  }),
];

// A block long enough to trip ollama.rs's RepetitionGuard: it needs >=128 new
// chars and the trailing 28-word window repeated three times.
const REPEATED_BLOCK = `I will now inspect the workspace and determine which file contains the defective addition helper before making any change at all to the source tree here. `;

const scenarios = {
  happy_calc: { steps: CALC_SCRIPT },

  // Step 1 is unparseable; the loop should feed a protocol error back and recover.
  malformed_action: {
    steps: ['{"type":"edit","path":"calc.py","old":"x"},"new":"y"}', ...CALC_SCRIPT],
  },

  // Never emits `final`. Each step is a distinct successful action so the
  // rejected-action loop guard stays quiet and the step ceiling is what stops it.
  never_finalizes: {
    step(index) {
      return action({ type: 'read', path: `calc.py`, offset: index + 1, limit: 1 });
    },
  },

  // One response that repeats the same block, tripping the stream-level guard.
  repeats_block: { steps: [REPEATED_BLOCK.repeat(4)] },

  // Emits a token per second forever; nothing ever completes.
  slow_dribble: { dribble: true },

  transport_500: { status: 500 },
};

const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`unknown scenario: ${scenarioName}`);
  console.error(`known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function chunk(content, { thinking = '' } = {}) {
  return `${JSON.stringify({
    model: MODEL_NAME,
    message: { role: 'assistant', content, thinking },
    done: false,
    prompt_eval_count: 100,
    eval_count: 20,
    prompt_eval_duration: 1_000_000,
    eval_duration: 1_000_000,
    total_duration: 2_000_000,
  })}\n`;
}

/** Which scripted step this request is asking for. */
function stepIndex(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.filter((message) => message?.role === 'assistant').length;
}

function responseFor(body) {
  const index = stepIndex(body);
  if (typeof scenario.step === 'function') return scenario.step(index);
  const steps = scenario.steps || [];
  // Past the end of the script, repeat the last entry so the run terminates the
  // same way it would with a stuck model rather than hanging on an empty reply.
  return steps[index] ?? steps[steps.length - 1] ?? '';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: MODEL_NAME }] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/show') {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ capabilities: [] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const raw = await readBody(req);

    if (scenario.status && scenario.status !== 200) {
      res.writeHead(scenario.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'fake model failure' }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson' });

    if (scenario.dribble) {
      // One chunk per second until the client gives up. Verifies that the CLI
      // can abort an in-flight generation instead of waiting on socket reads
      // that keep resetting their timeout.
      const timer = setInterval(() => {
        if (!res.writableEnded) res.write(chunk('.'));
      }, 1000);
      const stop = () => clearInterval(timer);
      req.on('close', stop);
      res.on('close', stop);
      return;
    }

    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // Fall through with an empty body; stepIndex() then reports step 0.
    }

    const text = responseFor(body);
    // Split into several chunks so streaming consumers see more than one delta.
    for (let at = 0; at < text.length; at += 64) {
      res.write(chunk(text.slice(at, at + 64)));
    }
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
