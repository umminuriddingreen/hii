import overview from '../../README.md?raw';
import activationApi from '../../docs/activation-api-contract.md?raw';
import agentAccess from '../../docs/agent-access.md?raw';
import boundary from '../../docs/aii-hii-boundary.md?raw';
import authentication from '../../docs/auth-providers.md?raw';
import capabilityTerminal from '../../docs/capability-terminal-v1.md?raw';
import codexIntegration from '../../docs/codex-app-server-integration.md?raw';
import sparkAgents from '../../docs/codex-spark-agents-plan.md?raw';
import masterContext from '../../docs/HII_AII_MASTER_CONTEXT.md?raw';
import brandDna from '../../docs/hii-brand-dna-v0.1.md?raw';
import sdkContracts from '../../docs/hii-sdk-contracts.md?raw';
import install from '../../docs/INSTALL.md?raw';
import launch from '../../docs/LAUNCH_AND_MONETIZATION.md?raw';
import rustCli from '../../docs/rust-cli.md?raw';
import skillGrowth from '../../docs/skill-growth-contract.md?raw';
import knowledgeWorkspace from '../../docs/decisions/001-hii-knowledge-workspace.md?raw';

export type HiiDocEntry = {
  slug: string;
  title: string;
  description: string;
  section: 'Start here' | 'Use HII' | 'Build HII' | 'Operate HII' | 'Decisions';
  source: string;
  status: 'canonical' | 'current' | 'reference' | 'release-gated';
};

export const hiiDocsCatalog: HiiDocEntry[] = [
  { slug:'overview', title:'HII overview', description:'Product definition, coordinates, development, and verification.', section:'Start here', source:'README.md', status:'canonical' },
  { slug:'master-context', title:'HII / AII master context', description:'Founder thesis, system boundary, product scope, and definition of done.', section:'Start here', source:'docs/HII_AII_MASTER_CONTEXT.md', status:'canonical' },
  { slug:'launch', title:'Launch and monetization', description:'Founder-beta offer, activation event, economics, and launch gates.', section:'Start here', source:'docs/LAUNCH_AND_MONETIZATION.md', status:'current' },
  { slug:'install', title:'Install HII on Mac', description:'Signed application and local bootstrap instructions.', section:'Use HII', source:'docs/INSTALL.md', status:'release-gated' },
  { slug:'agent-access', title:'Agent access', description:'The safe, canonical way for agents to inspect and operate HII.', section:'Use HII', source:'docs/agent-access.md', status:'current' },
  { slug:'rust-cli', title:'HII command line', description:'Conversational and bounded local workflows through the HII CLI.', section:'Use HII', source:'docs/rust-cli.md', status:'current' },
  { slug:'activation-api', title:'Activation API', description:'Frozen local endpoint contract for the founder-beta activation loop.', section:'Build HII', source:'docs/activation-api-contract.md', status:'current' },
  { slug:'hii-aii-boundary', title:'HII / AII boundary', description:'Ownership, dependency direction, and runtime-state contract.', section:'Build HII', source:'docs/aii-hii-boundary.md', status:'canonical' },
  { slug:'sdk-contracts', title:'SDK contracts', description:'Capabilities, jobs, quotes, ledger entries, and proof artifacts.', section:'Build HII', source:'docs/hii-sdk-contracts.md', status:'current' },
  { slug:'codex-integration', title:'Codex integration', description:'Supported app-server integration and HII-owned lifecycle.', section:'Build HII', source:'docs/codex-app-server-integration.md', status:'reference' },
  { slug:'authentication', title:'Account providers', description:'Supabase, email, Google, and Apple authentication configuration.', section:'Operate HII', source:'docs/auth-providers.md', status:'reference' },
  { slug:'capability-terminal', title:'Capability terminal', description:'Registry, execution ownership, jobs, budgets, and proof.', section:'Operate HII', source:'docs/capability-terminal-v1.md', status:'reference' },
  { slug:'skill-growth', title:'Skill growth', description:'How verified work becomes a reviewed, reusable local skill.', section:'Operate HII', source:'docs/skill-growth-contract.md', status:'current' },
  { slug:'spark-agents', title:'Bounded agent probes', description:'Preflight and safety rules for short-lived supporting agents.', section:'Operate HII', source:'docs/codex-spark-agents-plan.md', status:'reference' },
  { slug:'brand-dna', title:'Brand DNA', description:'Positioning, language, interaction principles, and visual direction.', section:'Decisions', source:'docs/hii-brand-dna-v0.1.md', status:'current' },
  { slug:'knowledge-workspace', title:'Knowledge workspace decision', description:'Accepted architecture decision for the first-party knowledge surface.', section:'Decisions', source:'docs/decisions/001-hii-knowledge-workspace.md', status:'canonical' }
];

const compiledMarkdown: Record<string, string> = {
  'README.md': overview,
  'docs/activation-api-contract.md': activationApi,
  'docs/agent-access.md': agentAccess,
  'docs/aii-hii-boundary.md': boundary,
  'docs/auth-providers.md': authentication,
  'docs/capability-terminal-v1.md': capabilityTerminal,
  'docs/codex-app-server-integration.md': codexIntegration,
  'docs/codex-spark-agents-plan.md': sparkAgents,
  'docs/HII_AII_MASTER_CONTEXT.md': masterContext,
  'docs/hii-brand-dna-v0.1.md': brandDna,
  'docs/hii-sdk-contracts.md': sdkContracts,
  'docs/INSTALL.md': install,
  'docs/LAUNCH_AND_MONETIZATION.md': launch,
  'docs/rust-cli.md': rustCli,
  'docs/skill-growth-contract.md': skillGrowth,
  'docs/decisions/001-hii-knowledge-workspace.md': knowledgeWorkspace
};

export function listHiiDocs() {
  return hiiDocsCatalog.map(({ source, ...entry }) => ({ ...entry, source }));
}

export function readHiiDoc(slug: string) {
  const entry = hiiDocsCatalog.find((candidate) => candidate.slug === slug);
  if (!entry) return null;
  return {
    ...entry,
    markdown: compiledMarkdown[entry.source],
    compiledAt: '2026-07-29'
  };
}
