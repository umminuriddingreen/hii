import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

function signature(failures = []) {
  return [...new Set(failures)]
    .slice(0, 3)
    .join(' | ')
    .replace(/\b(?:\/Users|\/private|\/var)\/[^\s"'<>]+/g, '<local-path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

async function appendJsonl(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function createImprovementRecorder({ root, layout }) {
  const failures = new Map();
  const globalLessons = path.join(root, 'verified-lessons.jsonl');
  const sessionLessons = path.join(layout.runtime, 'verified-lessons.txt');
  const proposals = path.join(root, 'improvement-proposals');

  async function refreshContext() {
    let rows = [];
    try {
      rows = (await fsp.readFile(globalLessons, 'utf8')).trim().split('\n').filter(Boolean);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const lessons = rows.slice(-12).flatMap((row) => {
      try {
        const lesson = JSON.parse(row);
        return [`- ${lesson.task}: avoid ${lesson.failure}; require ${lesson.proof}.`];
      } catch {
        return [];
      }
    });
    await fsp.writeFile(
      sessionLessons,
      lessons.length ? `Verified reusable lessons:\n${lessons.join('\n')}\n` : '',
      { mode: 0o600 }
    );
  }

  async function failed(relativePath, verification) {
    const issue = signature(verification?.failures);
    if (!issue) return;
    const history = failures.get(relativePath) ?? [];
    if (history.at(-1)?.issue === issue) return;
    history.push({ issue, at: new Date().toISOString() });
    failures.set(relativePath, history);
  }

  async function passed(relativePath, verification) {
    const history = failures.get(relativePath) ?? [];
    if (history.length === 0) return;
    const issue = history.at(-1).issue;
    const lesson = {
      schema: 'hii.runtime-lesson/1',
      at: new Date().toISOString(),
      task: path.extname(relativePath).toLowerCase() === '.html' ? 'web artifact' : 'artifact',
      failure: issue,
      repairAttempts: history.length,
      proof: `Chrome acceptance: HTTP ${verification.httpStatus}, no required-asset or JavaScript failures, visible DOM/canvas, screenshot`,
      sourceSession: layout.id
    };
    await appendJsonl(globalLessons, lesson);
    await refreshContext();
    failures.delete(relativePath);

    const sameIssueCount = fs.existsSync(globalLessons)
      ? fs.readFileSync(globalLessons, 'utf8').split('\n').filter((row) => row.includes(JSON.stringify(issue).slice(1, -1))).length
      : 0;
    if (sameIssueCount >= 3) {
      const proposal = {
        schema: 'hii.harness-proposal/1',
        status: 'operator-review',
        observed: issue,
        evidence: { verifiedRepairs: sameIssueCount },
        proposed: 'Add the smallest runtime policy, tool-schema, prompt, or regression-test change that prevents this failure.',
        replay: { required: true, historicalTasks: sameIssueCount, result: 'pending' },
        installAutomatically: false,
        hierarchy: [
          'verified lesson',
          'workspace convention',
          'skill draft',
          'runtime policy',
          'tool schema',
          'system prompt',
          'source patch'
        ]
      };
      await fsp.mkdir(proposals, { recursive: true, mode: 0o700 });
      await fsp.writeFile(
        path.join(proposals, `${Date.now()}-${Buffer.from(issue).toString('hex').slice(0, 12)}.json`),
        `${JSON.stringify(proposal, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' }
      );
    }
  }

  return { sessionLessons, refreshContext, failed, passed };
}
