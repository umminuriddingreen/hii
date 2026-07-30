import fs from 'node:fs/promises';
import path from 'node:path';

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function transcriptFiles(sessionDir) {
  const files = [path.join(sessionDir, 'transcript.log')];
  const history = path.join(sessionDir, 'history');
  try {
    for (const entry of await fs.readdir(history, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(history, entry.name, 'transcript.log'));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return files;
}

async function conversationFiles(sessionDir) {
  const runtimeRoots = [path.join(sessionDir, 'runtime')];
  const history = path.join(sessionDir, 'history');
  try {
    for (const entry of await fs.readdir(history, { withFileTypes: true })) {
      if (entry.isDirectory()) runtimeRoots.push(path.join(history, entry.name, 'runtime'));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const files = [];
  for (const runtime of runtimeRoots) {
    const directory = path.join(runtime, 'conversations', 'cli');
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(directory, entry.name));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return files;
}

async function transcriptText(sessionDir) {
  const chunks = [];
  for (const file of await transcriptFiles(sessionDir)) {
    try {
      chunks.push(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return chunks
    .join('\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function thinkingRepetition(entries) {
  const tokens = entries
    .filter((entry) => entry.kind === 'model.thinking')
    .flatMap((entry) => String(entry.data?.content ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const windowSize = 8;
  if (tokens.length < windowSize) return { windows: 0, repeated: 0 };
  const seen = new Set();
  let repeated = 0;
  let windows = 0;
  for (let index = 0; index <= tokens.length - windowSize; index += 1) {
    const window = tokens.slice(index, index + windowSize).join(' ');
    if (seen.has(window)) repeated += 1;
    else seen.add(window);
    windows += 1;
  }
  return { windows, repeated };
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function inputBursts(events) {
  const times = events
    .filter((event) => event.type === 'terminal-input')
    .map((event) => Date.parse(event.at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let bursts = 0;
  let previous = null;
  for (const time of times) {
    if (previous === null || time - previous > 2000) bursts += 1;
    previous = time;
  }
  return bursts;
}

export async function analyzeRemoteTests(root) {
  let directories = [];
  try {
    directories = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9-]{20,80}$/.test(entry.name))
      .map((entry) => path.join(root, entry.name));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const sessions = [];
  const verificationChecks = [];
  const firstArtifactTimes = [];
  let repeatedActions = 0;
  let modelLoops = 0;
  let interruptions = 0;
  let weakHtmlChecks = 0;
  let testerInputs = 0;
  const conversations = [];

  for (const sessionDir of directories) {
    const manifest = await readJson(path.join(sessionDir, 'manifest.json'));
    const events = await readJsonl(path.join(sessionDir, 'events.jsonl'));
    const transcript = await transcriptText(sessionDir);
    const checks = events.filter((event) => event.type === 'artifact-verified');
    verificationChecks.push(...checks.map((event) => ({ sessionDir, ...event })));
    repeatedActions += occurrences(transcript, /\bREPEATED_ACTION\b/g);
    modelLoops += occurrences(transcript, /\bMODEL LOOP DETECTED\b/g);
    interruptions += occurrences(transcript, /(?:\bINTERRUPTED\b|Response interrupted)/g);
    weakHtmlChecks += occurrences(transcript, /\btest\s+-s\s+[^\n]*\.html\b/g);
    const inputs = inputBursts(events);
    testerInputs += inputs;
    for (const file of await conversationFiles(sessionDir)) {
      const entries = await readJsonl(file);
      const userMessages = entries.filter((entry) => entry.kind === 'user.message');
      if (userMessages.length === 0) continue;
      const actions = entries.filter((entry) => entry.kind === 'model.action');
      const assistants = entries.filter((entry) => entry.kind === 'assistant.message');
      const firstUserAt = Number(userMessages[0]?.ts_unix_ms);
      const firstActionAt = Number(actions[0]?.ts_unix_ms);
      const firstUsage = entries.find(
        (entry) =>
          entry.kind === 'usage.model_call' &&
          (!Number.isFinite(firstActionAt) || Number(entry.ts_unix_ms) <= firstActionAt)
      );
      const repetition = thinkingRepetition(entries);
      conversations.push({
        id: entries[0]?.conversation_id ?? path.basename(file, '.jsonl'),
        sessionId: path.basename(sessionDir),
        userMessages: userMessages.length,
        actions: actions.length,
        completed: assistants.length > 0,
        timeToFirstActionMs:
          Number.isFinite(firstUserAt) && Number.isFinite(firstActionAt) && firstActionAt >= firstUserAt
            ? firstActionAt - firstUserAt
            : null,
        promptTokensBeforeFirstAction: Number(firstUsage?.data?.prompt_tokens) || null,
        thinkingWindows: repetition.windows,
        repeatedThinkingWindows: repetition.repeated
      });
    }

    const firstInput = events.find((event) => event.type === 'terminal-input');
    const firstVerified = events.find(
      (event) => event.type === 'artifact-verified' && event.ok === true
    );
    if (firstInput && firstVerified) {
      const elapsed = Date.parse(firstVerified.at) - Date.parse(firstInput.at);
      if (Number.isFinite(elapsed) && elapsed >= 0) firstArtifactTimes.push(elapsed);
    }
    sessions.push({
      id: path.basename(sessionDir),
      model: manifest?.model ?? null,
      outcome: manifest?.outcome ?? null,
      inputBursts: inputs,
      verificationChecks: checks.length,
      verified: checks.some((event) => event.ok === true)
    });
  }

  const artifactHistories = new Map();
  for (const check of verificationChecks) {
    const key = `${path.basename(check.sessionDir)}:${check.path ?? 'unknown'}`;
    const history = artifactHistories.get(key) ?? [];
    history.push(check.ok === true);
    artifactHistories.set(key, history);
  }
  const repairedArtifacts = [...artifactHistories.values()]
    .filter((history) => history.includes(false) && history.some((ok, index) => ok && history.slice(0, index).includes(false)))
    .length;
  const failedChecks = verificationChecks.filter((check) => check.ok !== true).length;
  const passedChecks = verificationChecks.length - failedChecks;
  const sessionsWithWork = sessions.filter((session) => session.inputBursts > 0 || session.verificationChecks > 0);
  const completedSessions = sessionsWithWork.filter((session) => session.verified).length;
  const completedConversations = conversations.filter((conversation) => conversation.completed).length;
  const firstActionTimes = conversations
    .map((conversation) => conversation.timeToFirstActionMs)
    .filter(Number.isFinite);
  const promptTokensBeforeAction = conversations
    .map((conversation) => conversation.promptTokensBeforeFirstAction)
    .filter(Number.isFinite);
  const thinkingWindows = conversations.reduce((total, conversation) => total + conversation.thinkingWindows, 0);
  const repeatedThinkingWindows = conversations.reduce(
    (total, conversation) => total + conversation.repeatedThinkingWindows,
    0
  );
  const followUpUserMessages = conversations.reduce(
    (total, conversation) => total + Math.max(0, conversation.userMessages - 1),
    0
  );
  const coverageGaps = [
    'Follow-up user messages are measured, but corrections versus new requests are not yet classified.',
    'Interruptions are visible in terminal traces but are not yet linked to a conversation id.',
    'Tester acceptance and the three feedback answers are not yet stored as structured outcomes.'
  ];
  const recommendations = [];
  if (weakHtmlChecks > 0) {
    recommendations.push('Keep browser acceptance mandatory for HTML; historical traces still contain weak file-size checks.');
  }
  if (modelLoops > 0 || repeatedActions > 0) {
    recommendations.push('Retain loop detection and repeated-observation suppression as regression gates.');
  }
  if (failedChecks > 0) {
    recommendations.push('Use exact browser failures as repair input and compare repaired-artifact rate over time.');
  }
  recommendations.push('Classify follow-up intent, link interruptions to conversation ids, and store final tester acceptance.');

  return {
    schema: 'hii.harness-insights/1',
    generatedAt: new Date().toISOString(),
    root,
    metrics: {
      sessions: sessions.length,
      conversationTasks: conversations.length,
      completedConversations,
      conversationCompletionRate: conversations.length
        ? round(completedConversations / conversations.length)
        : null,
      sessionsWithWork: sessionsWithWork.length,
      completedArtifactSessions: completedSessions,
      artifactSessionCompletionRate: sessionsWithWork.length
        ? round(completedSessions / sessionsWithWork.length)
        : null,
      verificationChecks: verificationChecks.length,
      browserVerificationSuccessRate: verificationChecks.length
        ? round(passedChecks / verificationChecks.length)
        : null,
      failedBrowserChecks: failedChecks,
      uniqueArtifacts: artifactHistories.size,
      repairedArtifacts,
      testerInputBursts: testerInputs,
      repeatedActions,
      modelLoops,
      interruptions,
      weakHtmlFileChecks: weakHtmlChecks,
      medianTimeToFirstActionMs: round(median(firstActionTimes), 0),
      medianPromptTokensBeforeFirstAction: round(median(promptTokensBeforeAction), 0),
      repetitiveThinkingNgramRate: thinkingWindows
        ? round(repeatedThinkingWindows / thinkingWindows)
        : null,
      followUpUserMessages,
      medianTimeToFirstVerifiedArtifactMs: round(median(firstArtifactTimes), 0)
    },
    sessions,
    conversations,
    coverageGaps,
    recommendations,
    installsChangesAutomatically: false
  };
}

export function formatHarnessInsights(report) {
  const metric = report.metrics;
  const percent = (value) => value === null ? 'not measured' : `${Math.round(value * 100)}%`;
  return [
    'HARNESS INSIGHT',
    '',
    `Observed  ${metric.sessions} sessions · ${metric.testerInputBursts} input bursts · ${metric.uniqueArtifacts} artifacts`,
    `Outcome   ${percent(metric.conversationCompletionRate)} conversation completion · ${percent(metric.artifactSessionCompletionRate)} artifact-session completion`,
    `Browser   ${percent(metric.browserVerificationSuccessRate)} success · ${metric.failedBrowserChecks} failed checks · ${metric.repairedArtifacts} repaired artifacts`,
    `Loops     ${metric.repeatedActions} repeated actions · ${metric.modelLoops} model loops · ${metric.interruptions} interruptions`,
    `Thinking  ${percent(metric.repetitiveThinkingNgramRate)} repeated 8-word windows · ${metric.medianPromptTokensBeforeFirstAction ?? 'not measured'} median prompt tokens before action`,
    `Speed     ${metric.medianTimeToFirstActionMs === null ? 'not measured' : `${metric.medianTimeToFirstActionMs} ms median to first action`} · ${metric.medianTimeToFirstVerifiedArtifactMs === null ? 'not measured' : `${metric.medianTimeToFirstVerifiedArtifactMs} ms median to first verified artifact`}`,
    '',
    'Next evidence',
    ...report.coverageGaps.map((gap) => `- ${gap}`),
    '',
    'Proposed',
    ...report.recommendations.map((recommendation) => `- ${recommendation}`),
    '',
    'No harness source change is installed automatically.'
  ].join('\n');
}
