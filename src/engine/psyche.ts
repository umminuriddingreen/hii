/**
 * HII Psyche Layer — User Profile Extraction & Modeling
 *
 * Builds a persistent, evolving model of the user's:
 * - Communication patterns (vocabulary, tone, priorities)
 * - Decision patterns (what they approve/reject, preferences)
 * - Knowledge graph (domains, skills, interests)
 * - Intent patterns (common requests, workflows)
 *
 * This is the core of HII: writing an executable copy of
 * someone's thought patterns onto a system.
 *
 * Storage: ~/.hii/psyche.json — append-only with periodic compaction
 */

import fs from 'node:fs';
import path from 'node:path';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const PSYCHE_FILE = path.join(HII_DIR, 'psyche.json');

export interface PsycheProfile {
  identity: {
    name: string;
    roles: string[];
    domains: string[];
  };
  patterns: {
    communication: CommunicationPattern[];
    decisions: DecisionPattern[];
    workflows: WorkflowPattern[];
  };
  knowledge: KnowledgeNode[];
  values: string[];
  goals: Goal[];
  interactions: InteractionLog[];
  lastUpdated: string;
}

export interface CommunicationPattern {
  trait: string;        // e.g. "direct", "uses metaphors", "thinks in systems"
  confidence: number;   // 0-1
  evidence: string;     // what observation led to this
}

export interface DecisionPattern {
  context: string;      // e.g. "choosing tools", "architecture decisions"
  tendency: string;     // e.g. "prefers unix-native over frameworks"
  confidence: number;
}

export interface WorkflowPattern {
  trigger: string;      // what initiates this workflow
  steps: string[];      // ordered sequence
  frequency: string;    // daily, weekly, etc.
}

export interface KnowledgeNode {
  domain: string;
  depth: 'surface' | 'working' | 'deep' | 'expert';
  related: string[];
}

export interface Goal {
  description: string;
  timeframe: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'active' | 'completed' | 'paused';
}

export interface InteractionLog {
  timestamp: string;
  type: 'observation' | 'correction' | 'preference' | 'decision';
  content: string;
  source: string;       // which subsystem observed this
}

function defaultProfile(): PsycheProfile {
  return {
    identity: { name: '', roles: [], domains: [] },
    patterns: { communication: [], decisions: [], workflows: [] },
    knowledge: [],
    values: [],
    goals: [],
    interactions: [],
    lastUpdated: new Date().toISOString(),
  };
}

export function loadPsyche(): PsycheProfile {
  try {
    return JSON.parse(fs.readFileSync(PSYCHE_FILE, 'utf-8'));
  } catch {
    return defaultProfile();
  }
}

export function savePsyche(profile: PsycheProfile): void {
  fs.mkdirSync(HII_DIR, { recursive: true });
  profile.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PSYCHE_FILE, JSON.stringify(profile, null, 2));
}

/** Record an observation about the user */
export function observe(type: InteractionLog['type'], content: string, source: string): void {
  const p = loadPsyche();
  p.interactions.push({
    timestamp: new Date().toISOString(),
    type,
    content,
    source,
  });
  // Keep last 500 interactions
  if (p.interactions.length > 500) {
    p.interactions = p.interactions.slice(-500);
  }
  savePsyche(p);
}

/** Update identity fields */
export function setIdentity(name: string, roles: string[], domains: string[]): void {
  const p = loadPsyche();
  p.identity = { name, roles, domains };
  savePsyche(p);
}

/** Add a communication pattern */
export function addCommPattern(trait: string, confidence: number, evidence: string): void {
  const p = loadPsyche();
  // Update if exists, else add
  const existing = p.patterns.communication.find(c => c.trait === trait);
  if (existing) {
    existing.confidence = Math.min(1, (existing.confidence + confidence) / 2);
    existing.evidence = evidence;
  } else {
    p.patterns.communication.push({ trait, confidence, evidence });
  }
  savePsyche(p);
}

/** Add a decision pattern */
export function addDecisionPattern(context: string, tendency: string, confidence: number): void {
  const p = loadPsyche();
  const existing = p.patterns.decisions.find(d => d.context === context);
  if (existing) {
    existing.tendency = tendency;
    existing.confidence = Math.min(1, (existing.confidence + confidence) / 2);
  } else {
    p.patterns.decisions.push({ context, tendency, confidence });
  }
  savePsyche(p);
}

/** Add or update knowledge node */
export function addKnowledge(domain: string, depth: KnowledgeNode['depth'], related: string[] = []): void {
  const p = loadPsyche();
  const existing = p.knowledge.find(k => k.domain === domain);
  if (existing) {
    existing.depth = depth;
    existing.related = [...new Set([...existing.related, ...related])];
  } else {
    p.knowledge.push({ domain, depth, related });
  }
  savePsyche(p);
}

/** Add a goal */
export function addGoal(description: string, timeframe: string, priority: Goal['priority']): void {
  const p = loadPsyche();
  p.goals.push({ description, timeframe, priority, status: 'active' });
  savePsyche(p);
}

/** Set core values */
export function setValues(values: string[]): void {
  const p = loadPsyche();
  p.values = [...new Set([...p.values, ...values])];
  savePsyche(p);
}

/** Export psyche as a system prompt fragment for injecting into agent context */
export function psycheToSystemPrompt(): string {
  const p = loadPsyche();
  if (!p.identity.name) return '';

  const lines: string[] = [
    `You are acting on behalf of ${p.identity.name}.`,
  ];

  if (p.identity.roles.length) lines.push(`Roles: ${p.identity.roles.join(', ')}`);
  if (p.identity.domains.length) lines.push(`Domains: ${p.identity.domains.join(', ')}`);
  if (p.values.length) lines.push(`Core values: ${p.values.join(', ')}`);

  if (p.patterns.communication.length) {
    lines.push('Communication style:');
    for (const c of p.patterns.communication.filter(x => x.confidence > 0.5)) {
      lines.push(`  - ${c.trait}`);
    }
  }

  if (p.patterns.decisions.length) {
    lines.push('Decision patterns:');
    for (const d of p.patterns.decisions.filter(x => x.confidence > 0.5)) {
      lines.push(`  - In ${d.context}: ${d.tendency}`);
    }
  }

  if (p.goals.filter(g => g.status === 'active').length) {
    lines.push('Active goals:');
    for (const g of p.goals.filter(g => g.status === 'active')) {
      lines.push(`  - [${g.priority}] ${g.description} (${g.timeframe})`);
    }
  }

  return lines.join('\n');
}

/** Get a compact summary for token-efficient contexts */
export function psycheSummary(): string {
  const p = loadPsyche();
  return JSON.stringify({
    name: p.identity.name,
    roles: p.identity.roles,
    values: p.values.slice(0, 5),
    goals: p.goals.filter(g => g.status === 'active').map(g => g.description).slice(0, 3),
    interactions: p.interactions.length,
  });
}
