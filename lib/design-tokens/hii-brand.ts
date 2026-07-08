export const hiiBrandTokens = {
  color: {
    warmWhite: '#fbfaf5',
    graphite: '#171717',
    softBlue: '#cfe8ff',
    softGreen: '#dff7d7',
    silver: '#d7dce0',
    chrome: '#eff3f5',
    electricBlue: '#176bff',
    acidGreen: '#a8ff3e',
    violet: '#7d5cff'
  },
  typography: {
    product: 'clean sans, high legibility',
    status: 'mono for commands, receipts, state chips, and source labels',
    pixel: 'micro-labels and marketing only'
  },
  radius: {
    control: 6,
    panel: 8,
    card: 8
  },
  motion: {
    aliveBarsMs: 900,
    transitionMs: 180,
    reducedMotion: 'freeze activity indicators and preserve state text'
  },
  approvalState: {
    prepared: 'HII has drafted the next move',
    needsYou: 'user approval is required before execution',
    working: 'agent is gathering or transforming context',
    blocked: 'HII cannot proceed without permission, auth, or missing context',
    done: 'artifact or receipt is complete'
  },
  workSurfaces: {
    todayDesk: ['calm shell', 'alive systems', 'next-action cards'],
    localRuntime: ['browser windows', 'folders', 'state labels'],
    codexTrust: ['receipts', 'source context', 'approval gates'],
    proofLayer: ['logs', 'artifacts', 'verification transitions']
  },
  proofRecommender: {
    privacyRule: 'scan locally; require approval before export, upload, sync, or publish',
    inputs: ['repo status', 'jobs', 'board tasks', 'capability registry'],
    outputs: ['next action', 'verification plan', 'receipt draft', 'proof artifact']
  }
} as const;

export type HiiBrandTokens = typeof hiiBrandTokens;
