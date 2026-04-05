type Evidence = {
  label: string;
  url: string;
};

type Competitor = {
  name: string;
  category: string;
  wedge: string;
  strength: string;
  weakness: string;
  moat: string;
  threat: 'low' | 'medium' | 'high';
  horizonScore: number;
  evidence: Evidence[];
};

type Requirement = {
  title: string;
  whyNow: string;
  whatToBuild: string;
  moatType: string;
};

const SNAPSHOT_DATE = '2026-04-05';

const COMPETITORS: Competitor[] = [
  {
    name: 'OpenAI Codex',
    category: 'agentic coding',
    wedge: 'General-purpose coding agent with approvals, sandboxing, multi-tool execution, and cloud/task surfaces.',
    strength: 'Strong model capability, agent workflows, broad tool surface, safety and approval model.',
    weakness: 'Still centered on assisted execution rather than deep org memory, team operations, or persistent strategy.',
    moat: 'Model quality plus integrated agent platform and enterprise trust.',
    threat: 'high',
    horizonScore: 9.2,
    evidence: [
      { label: 'OpenAI Agents docs', url: 'https://platform.openai.com/docs/guides/agents' },
      { label: 'OpenAI Codex product surface', url: 'https://chatgpt.com/codex' },
    ],
  },
  {
    name: 'Anthropic Claude Code',
    category: 'terminal coding',
    wedge: 'Permission-first terminal coding agent embedded in developer workflows.',
    strength: 'Strong security posture, explicit approval model, strong reasoning reputation in code tasks.',
    weakness: 'Narrower product story around terminal coding than a full operating system for work.',
    moat: 'Trusted execution model and strong developer affinity.',
    threat: 'high',
    horizonScore: 8.9,
    evidence: [
      { label: 'Claude Code security', url: 'https://docs.anthropic.com/en/docs/claude-code/security' },
    ],
  },
  {
    name: 'Cursor',
    category: 'IDE-native coding',
    wedge: 'IDE-native AI pair programmer with agentic coding workflows inside the editor.',
    strength: 'Developer adoption, low friction, IDE integration, familiar workflow.',
    weakness: 'Still primarily editor-bound; weaker as a cross-surface operating layer for life, systems, and memory.',
    moat: 'Distribution through daily coding workflow.',
    threat: 'high',
    horizonScore: 8.6,
    evidence: [
      { label: 'Cursor official site', url: 'https://cursor.com/' },
    ],
  },
  {
    name: 'Warp',
    category: 'AI terminal',
    wedge: 'Agentic terminal with command execution, context, and task-oriented terminal workflows.',
    strength: 'Terminal UX, collaboration framing, explicit task lists and context management.',
    weakness: 'Primarily terminal-centric; less differentiated as durable memory + orchestration layer.',
    moat: 'Excellent terminal UX and fast iteration on agentic terminal workflows.',
    threat: 'medium',
    horizonScore: 8.1,
    evidence: [
      { label: 'Warp agent mode docs', url: 'https://docs.warp.dev/agents/warp-ai/agent-mode' },
    ],
  },
  {
    name: 'GitHub Copilot Coding Agent',
    category: 'repo-native agent',
    wedge: 'Agent workflows attached to repositories, IDEs, and GitHub-native development loops.',
    strength: 'Massive distribution, repository context, GitHub workflow adjacency.',
    weakness: 'Constrained by GitHub context; weaker as a local-first operating layer across the whole machine and life stack.',
    moat: 'Distribution and workflow gravity inside GitHub.',
    threat: 'high',
    horizonScore: 8.4,
    evidence: [
      { label: 'GitHub Copilot coding agent docs', url: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents' },
    ],
  },
  {
    name: 'Devin',
    category: 'autonomous software engineer',
    wedge: 'Higher-autonomy software engineering agent positioned as delegated engineering labor.',
    strength: 'Clear narrative around autonomous execution and end-to-end software tasks.',
    weakness: 'Higher trust barrier, heavier workflow, less obvious fit for always-on local personal infrastructure.',
    moat: 'Autonomy narrative and delegated engineering positioning.',
    threat: 'medium',
    horizonScore: 7.8,
    evidence: [
      { label: 'Cognition official site', url: 'https://www.cognition.ai/' },
    ],
  },
];

const REQUIREMENTS: Requirement[] = [
  {
    title: 'Persistent personal + workspace memory',
    whyNow: 'Competitors still optimize for a single task window. Durable memory across conversations, files, decisions, and routines creates compounding value.',
    whatToBuild: 'Unified memory graph, skill execution history, recall ranking, and user-teachable habits that survive model swaps.',
    moatType: 'data network effects',
  },
  {
    title: 'Cross-surface orchestration, not just code generation',
    whyNow: 'The market is converging on coding agents. The next category leader coordinates local machine, browser, notes, APIs, docs, and long-running agents.',
    whatToBuild: 'One command surface for system actions, coding, research, documents, meetings, dashboards, and remote execution.',
    moatType: 'workflow breadth',
  },
  {
    title: 'Operator-grade observability and replay',
    whyNow: 'As autonomy rises, trust depends on auditability. Enterprises will not deploy opaque agent behavior at scale.',
    whatToBuild: 'Run logs, approvals, action diffs, skill traces, cost/latency views, replayable sessions, and eval-backed policy checks.',
    moatType: 'governance trust',
  },
  {
    title: 'Composable skills marketplace',
    whyNow: 'Raw prompting does not scale across teams. Reusable skills turn one-off solutions into an operating system.',
    whatToBuild: 'Installable skills, versioning, verification, private marketplace, team distribution, and usage analytics.',
    moatType: 'ecosystem lock-in',
  },
  {
    title: 'Hybrid local/cloud execution',
    whyNow: 'Users want privacy, speed, and reach. Pure cloud loses trust; pure local loses capability.',
    whatToBuild: 'Policy-based routing between local models, cloud models, browser agents, and remote runners with graceful fallback.',
    moatType: 'cost-performance edge',
  },
  {
    title: 'Board-level ROI reporting',
    whyNow: 'Every serious buyer will ask what the agents changed, saved, prevented, or accelerated.',
    whatToBuild: 'Saved time, automation coverage, avoided tickets, deployment throughput, and strategic initiative dashboards.',
    moatType: 'enterprise budget ownership',
  },
];

function threatWeight(threat: Competitor['threat']): number {
  if (threat === 'high') return 3;
  if (threat === 'medium') return 2;
  return 1;
}

function topThreats(): Competitor[] {
  return [...COMPETITORS]
    .sort((a, b) => threatWeight(b.threat) - threatWeight(a.threat) || b.horizonScore - a.horizonScore)
    .slice(0, 3);
}

function fiveYearThesis(): string[] {
  return [
    'Winning products will stop being "coding copilots" and become operating systems for knowledge work.',
    'The durable moat will be memory + orchestration + governance, not chat quality alone.',
    'Teams will buy platforms that turn individual workflows into reusable skills, visible metrics, and controllable agent fleets.',
    'The category leader will unify local trust, cloud reach, and measurable business outcomes.',
  ];
}

function formatTable(rows: string[][]): string[] {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return rows.map((row, rowIndex) => {
    const line = row.map((cell, index) => cell.padEnd(widths[index], ' ')).join(' | ');
    if (rowIndex === 0) {
      const divider = widths.map((width) => '-'.repeat(width)).join('-|-');
      return `${line}\n${divider}`;
    }
    return line;
  });
}

export function radarAsJson() {
  return {
    snapshotDate: SNAPSHOT_DATE,
    competitors: COMPETITORS,
    fiveYearThesis: fiveYearThesis(),
    requirements: REQUIREMENTS,
    topThreats: topThreats().map((item) => item.name),
  };
}

export function radarAsMarkdown(): string {
  const lines: string[] = [];
  lines.push(`# HII Competitive Radar`);
  lines.push(``);
  lines.push(`Snapshot date: ${SNAPSHOT_DATE}`);
  lines.push(``);
  lines.push(`## Top Threats`);
  for (const item of topThreats()) {
    lines.push(`- **${item.name}** — ${item.wedge}`);
  }
  lines.push(``);
  lines.push(`## Competitor Matrix`);
  for (const item of COMPETITORS) {
    lines.push(`### ${item.name}`);
    lines.push(`- Category: ${item.category}`);
    lines.push(`- Wedge: ${item.wedge}`);
    lines.push(`- Strength: ${item.strength}`);
    lines.push(`- Weakness: ${item.weakness}`);
    lines.push(`- Moat: ${item.moat}`);
    lines.push(`- Threat: ${item.threat}`);
    lines.push(`- Horizon score: ${item.horizonScore}`);
    lines.push(`- Sources: ${item.evidence.map((source) => `[${source.label}](${source.url})`).join(', ')}`);
    lines.push(``);
  }
  lines.push(`## Five-Year Thesis`);
  for (const point of fiveYearThesis()) {
    lines.push(`- ${point}`);
  }
  lines.push(``);
  lines.push(`## What We Need To Build`);
  for (const req of REQUIREMENTS) {
    lines.push(`### ${req.title}`);
    lines.push(`- Why now: ${req.whyNow}`);
    lines.push(`- Build: ${req.whatToBuild}`);
    lines.push(`- Moat type: ${req.moatType}`);
    lines.push(``);
  }
  return lines.join('\n');
}

export function radarAsTerminal(): string {
  const rows = [
    ['Competitor', 'Category', 'Threat', 'Horizon', 'Wedge'],
    ...COMPETITORS.map((item) => [
      item.name,
      item.category,
      item.threat.toUpperCase(),
      item.horizonScore.toFixed(1),
      item.wedge,
    ]),
  ];
  const lines: string[] = [];
  lines.push(`HII Competitive Radar`);
  lines.push(`Snapshot: ${SNAPSHOT_DATE}`);
  lines.push(``);
  lines.push(`Top threats`);
  for (const item of topThreats()) {
    lines.push(`- ${item.name}: ${item.strength}`);
  }
  lines.push(``);
  lines.push(...formatTable(rows));
  lines.push(``);
  lines.push(`Five years ahead`);
  for (const point of fiveYearThesis()) {
    lines.push(`- ${point}`);
  }
  lines.push(``);
  lines.push(`Build requirements`);
  for (const req of REQUIREMENTS) {
    lines.push(`- ${req.title}: ${req.whatToBuild}`);
  }
  lines.push(``);
  lines.push(`Sources`);
  for (const item of COMPETITORS) {
    lines.push(`- ${item.name}: ${item.evidence.map((source) => `${source.label} ${source.url}`).join(' | ')}`);
  }
  return lines.join('\n');
}
