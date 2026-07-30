<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  type AgentId = 'codex' | 'claude' | 'ollama';
  type StartAgent = 'codex' | 'claude';
  type ActivationAction = 'detect' | 'inventory' | 'create' | 'start' | 'status';
  type ActivationMilestone = 'agents_detected' | 'context_previewed' | 'context_approved' | 'run_started' | 'receipt_verified' | 'run_failed';

  type AgentDetection = {
    id: AgentId;
    installed: boolean;
    authenticated: boolean | null;
    version: string | null;
    detail: string | null;
  };

  type InventoryItem = {
    sourcePath: string;
    kind: 'markdown' | 'text' | 'code' | 'config';
    format: string;
    sizeBytes: number;
    freshnessAt: string;
  };

  type Inventory = {
    rootPath: string;
    items: InventoryItem[];
    count: number;
    totalBytes: number;
  };

  type ReceiptCheck = {
    command?: string;
    name?: string;
    ok?: boolean;
    output?: string;
  };

  type Receipt = {
    summary?: string;
    outcome?: string;
    status?: string;
    verification?: string | ReceiptCheck[] | { summary?: string; checks?: ReceiptCheck[] };
    checks?: ReceiptCheck[];
    proofPaths?: string[];
    proof_paths?: string[];
    artifacts?: Array<string | { path?: string }>;
    next?: string | null;
    risk?: string | null;
  };

  type DetectionResponse = { agents: AgentDetection[] };
  type CreateResponse = { project: { id?: string; projectId?: string; name?: string }; scan: unknown };
  type StartResponse = { activationId: string; startedAt: string; runKind: 'codex-exec' | 'claude-spawn' };
  type ActivationJourney = {
    status: 'in-progress' | 'completed' | 'failed';
    elapsedSeconds: number;
    milestones: Array<{ milestone: ActivationMilestone; at: string }>;
  };
  type StatusResponse = {
    status: 'running' | 'completed' | 'failed' | 'unknown';
    receipt: Receipt | null;
    journey?: ActivationJourney | null;
    journeyWarning?: string;
  };

  const HII_ACTIVATION_MOCK = import.meta.env.VITE_ACTIVATION_MOCK === '1';
  const agents: Array<{ id: AgentId; name: string; eyebrow: string; description: string }> = [
    { id: 'codex', name: 'Codex', eyebrow: 'Recommended', description: 'Best for implementation, precise edits, and finishing the job.' },
    { id: 'claude', name: 'Claude Code', eyebrow: 'Explorer', description: 'Strong for exploration, orientation, and making sense of an unfamiliar project.' },
    { id: 'ollama', name: 'Ollama', eyebrow: 'Private + local', description: 'Keeps model work on this Mac and routes the bounded run through the local Codex profile.' }
  ];
  const taskPresets = [
    'Explain this project and one next action.',
    'Make one small reversible improvement.',
    'Verify an artifact and produce a receipt.'
  ];
  const milestoneLabels: Record<ActivationMilestone, string> = {
    agents_detected: 'Local agents detected',
    context_previewed: 'Project context previewed',
    context_approved: 'Context explicitly approved',
    run_started: 'Bounded run started',
    receipt_verified: 'Verified receipt returned',
    run_failed: 'Bounded run stopped'
  };

  let step = $state(1);
  let journeyId = $state('');
  let selectedAgent = $state<AgentId>('codex');
  let detectedAgents = $state<AgentDetection[]>([]);
  let rootPath = $state('');
  let inventory = $state<Inventory | null>(null);
  let exclusions = $state<string[]>([]);
  let approved = $state(false);
  let projectId = $state('');
  let task = $state(taskPresets[0]);
  let activationId = $state('');
  let runStatus = $state<StatusResponse['status']>('running');
  let receipt = $state<Receipt | null>(null);
  let activationJourney = $state<ActivationJourney | null>(null);
  let journeyWarning = $state('');
  let busy = $state(false);
  let errorMessage = $state('');
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let mockPollCount = 0;

  const isMock = () => HII_ACTIVATION_MOCK || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '1');

  function mockResponse(action: ActivationAction, params: Record<string, unknown>) {
    const mockStartedAt = new Date(Date.now() - 42_000).toISOString();
    const mockJourney: ActivationJourney = {
      status: 'completed',
      elapsedSeconds: 42,
      milestones: [
        { milestone: 'agents_detected', at: mockStartedAt },
        { milestone: 'context_previewed', at: new Date(Date.now() - 36_000).toISOString() },
        { milestone: 'context_approved', at: new Date(Date.now() - 31_000).toISOString() },
        { milestone: 'run_started', at: new Date(Date.now() - 27_000).toISOString() },
        { milestone: 'receipt_verified', at: new Date().toISOString() }
      ]
    };
    const fixtures = {
      detect: {
        agents: [
          { id: 'codex', installed: true, authenticated: true, version: '0.42.0', detail: 'Ready for bounded workspace runs.' },
          { id: 'claude', installed: true, authenticated: true, version: '1.0.38', detail: 'Authenticated locally.' },
          { id: 'ollama', installed: true, authenticated: null, version: '0.9.6', detail: 'qwen3.6:27b-mlx, nomic-embed-text' }
        ]
      },
      inventory: {
        rootPath: String(params.rootPath || '/Users/ummi/hii'),
        items: [
          { sourcePath: 'README.md', kind: 'markdown', format: 'md', sizeBytes: 12480, freshnessAt: new Date().toISOString() },
          { sourcePath: 'package.json', kind: 'config', format: 'json', sizeBytes: 3892, freshnessAt: new Date().toISOString() },
          { sourcePath: 'src/routes/+page.svelte', kind: 'code', format: 'svelte', sizeBytes: 18340, freshnessAt: new Date().toISOString() },
          { sourcePath: 'docs/product-context.md', kind: 'markdown', format: 'md', sizeBytes: 9172, freshnessAt: new Date().toISOString() },
          { sourcePath: '.env.example', kind: 'config', format: 'env', sizeBytes: 640, freshnessAt: new Date().toISOString() }
        ],
        count: 5,
        totalBytes: 44524
      },
      create: { project: { id: 'project_demo_local', name: 'HII demo project' }, scan: { added: 4, excluded: 1 } },
      start: { activationId: 'activation_demo_01', startedAt: new Date().toISOString(), runKind: selectedAgent === 'claude' ? 'claude-spawn' : 'codex-exec' },
      status: mockPollCount++ < 1
        ? { status: 'running', receipt: null }
        : {
            status: 'completed',
            journey: mockJourney,
            receipt: {
              summary: 'The agent learned the workspace, identified its current product boundary, and finished the approved bounded task.',
              outcome: 'One reversible documentation improvement was completed without changing runtime behavior.',
              verification: { summary: 'The edited source and repository checks passed.', checks: [
                { name: 'Svelte check', command: 'npm run check', ok: true, output: '0 errors and 0 warnings' },
                { name: 'Scoped diff', command: 'git diff --check', ok: true, output: 'No whitespace errors' }
              ] },
              proofPaths: ['docs/product-context.md', '~/.hii/runs/cli/activation_demo_01/receipt.json'],
              next: 'Review the change and keep it only if it improves the project.'
            }
          }
    } satisfies Record<ActivationAction, unknown>;
    return fixtures[action];
  }

  async function activationRequest<T>(action: ActivationAction, params: Record<string, unknown> = {}): Promise<T> {
    if (isMock()) {
      await new Promise((resolve) => setTimeout(resolve, action === 'status' ? 280 : 420));
      return mockResponse(action, params) as T;
    }

    const response = await fetch('/api/activation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, journeyId, ...params })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Activation request failed (${response.status}).`);
    if (typeof payload.journeyWarning === 'string') journeyWarning = payload.journeyWarning;
    return payload as T;
  }

  async function detectAgents() {
    errorMessage = '';
    try {
      const result = await activationRequest<DetectionResponse>('detect');
      detectedAgents = result.agents;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not inspect local agents.';
    }
  }

  function detectionFor(agentId: AgentId) {
    return detectedAgents.find((candidate) => candidate.id === agentId);
  }

  async function chooseFolder() {
    errorMessage = '';
    const tauri = (window as Window & {
      __TAURI__?: { dialog?: { open?: (options: { directory: boolean; multiple: boolean; title: string }) => Promise<string | string[] | null> } };
    }).__TAURI__;
    if (!tauri?.dialog?.open) return;
    try {
      const selected = await tauri.dialog.open({ directory: true, multiple: false, title: 'Choose a project folder' });
      if (typeof selected === 'string') rootPath = selected;
      else if (Array.isArray(selected) && selected[0]) rootPath = selected[0];
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The folder picker could not open.';
    }
  }

  function hasTauriDialog() {
    return typeof window !== 'undefined' && Boolean((window as Window & { __TAURI__?: { dialog?: unknown } }).__TAURI__?.dialog);
  }

  async function previewInventory() {
    if (!rootPath.trim()) return;
    busy = true;
    errorMessage = '';
    try {
      inventory = await activationRequest<Inventory>('inventory', { rootPath: rootPath.trim(), exclusions });
      rootPath = inventory.rootPath;
      approved = false;
      step = 3;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not preview this folder.';
    } finally {
      busy = false;
    }
  }

  function toggleExclusion(sourcePath: string) {
    exclusions = exclusions.includes(sourcePath)
      ? exclusions.filter((path) => path !== sourcePath)
      : [...exclusions, sourcePath];
    approved = false;
  }

  async function approveAndCreate() {
    if (!approved || !inventory) return;
    busy = true;
    errorMessage = '';
    try {
      const result = await activationRequest<CreateResponse>('create', {
        rootPath: inventory.rootPath,
        name: inventory.rootPath.split('/').filter(Boolean).at(-1),
        exclusions
      });
      projectId = result.project.id ?? result.project.projectId ?? '';
      if (!projectId) throw new Error('The project was created without an identifier.');
      step = 4;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not create the approved project.';
    } finally {
      busy = false;
    }
  }

  async function startActivation() {
    if (!task.trim() || !projectId) return;
    busy = true;
    errorMessage = '';
    try {
      const agent: StartAgent = selectedAgent === 'claude' ? 'claude' : 'codex';
      const result = await activationRequest<StartResponse>('start', { projectId, agent, task: task.trim() });
      activationId = result.activationId;
      runStatus = 'running';
      step = 5;
      await checkStatus();
      if (step === 5) pollTimer = setInterval(() => void checkStatus(), 3000);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not start the bounded task.';
    } finally {
      busy = false;
    }
  }

  async function checkStatus() {
    if (!activationId) return;
    try {
      const result = await activationRequest<StatusResponse>('status', { activationId });
      runStatus = result.status;
      activationJourney = result.journey ?? activationJourney;
      if (result.status === 'completed' && result.receipt) {
        receipt = result.receipt;
        stopPolling();
        step = 6;
      } else if (result.status === 'failed' || result.status === 'unknown') {
        stopPolling();
        errorMessage = result.status === 'failed' ? 'The bounded run stopped before completion.' : 'HII could not find this activation.';
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not refresh activation status.';
    }
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function receiptChecks(value: Receipt | null) {
    if (!value) return [];
    if (Array.isArray(value.checks)) return value.checks;
    if (Array.isArray(value.verification)) return value.verification;
    if (typeof value.verification === 'object' && value.verification && Array.isArray(value.verification.checks)) return value.verification.checks;
    return [];
  }

  function verificationSummary(value: Receipt | null) {
    if (!value?.verification) return 'No verification summary was included.';
    if (typeof value.verification === 'string') return value.verification;
    if (!Array.isArray(value.verification) && value.verification.summary) return value.verification.summary;
    const checks = receiptChecks(value);
    return checks.length ? `${checks.filter((check) => check.ok).length} of ${checks.length} checks passed.` : 'Verification details are recorded in the receipt.';
  }

  function proofPaths(value: Receipt | null) {
    if (!value) return [];
    const artifactPaths = value.artifacts?.map((artifact) => typeof artifact === 'string' ? artifact : artifact.path).filter((path): path is string => Boolean(path)) ?? [];
    return [...new Set([...(value.proofPaths ?? []), ...(value.proof_paths ?? []), ...artifactPaths])];
  }

  function milestoneLabel(milestone: ActivationMilestone) {
    return milestoneLabels[milestone];
  }

  function goBack() {
    errorMessage = '';
    if (step > 1 && step < 5) step -= 1;
  }

  onMount(() => {
    journeyId = crypto.randomUUID();
    void detectAgents();
  });
  onDestroy(stopPolling);
</script>

<svelte:head>
  <title>Activate HII — Meet your workspace agent</title>
  <meta name="description" content="Choose an agent, approve local project context, and finish one bounded task with proof." />
</svelte:head>

<div class="activation-page">
  <header class="activation-header">
    <a class="wordmark" href="/" aria-label="HII home">hii</a>
    <div class="progress-copy">
      <span>Activation</span>
      <strong>{step} of 6</strong>
    </div>
    <div class="progress-track" aria-label={`Step ${step} of 6`}>
      {#each Array(6) as _, index}
        <i class:active={index + 1 <= step}></i>
      {/each}
    </div>
  </header>

  <main>
    {#if step === 1}
      <section class="step-section" aria-labelledby="step-one-title">
        <p class="eyebrow"><span></span> Step one · choose your collaborator</p>
        <h1 id="step-one-title">Who should learn<br />this workspace?</h1>
        <p class="deck">HII gives one local agent a deliberate project boundary. You will review every file before anything begins.</p>

        <div class="agent-grid">
          {#each agents as agent}
            {@const detection = detectionFor(agent.id)}
            <button type="button" class="agent-card" class:selected={selectedAgent === agent.id} onclick={() => selectedAgent = agent.id} aria-pressed={selectedAgent === agent.id}>
              <span class="card-topline"><b>{agent.eyebrow}</b><i>{selectedAgent === agent.id ? 'Selected' : 'Choose'}</i></span>
              <strong>{agent.name}</strong>
              <p>{agent.description}</p>
              <span class="badges">
                {#if detection}
                  <em class:ready={detection.installed}>{detection.installed ? 'Installed' : 'Not installed'}</em>
                  <em class:ready={detection.authenticated === true} class:neutral={detection.authenticated === null}>
                    {detection.authenticated === true ? 'Authenticated' : detection.authenticated === null ? 'Auth unknown' : 'Sign-in needed'}
                  </em>
                  {#if detection.version}<em>{detection.version}</em>{/if}
                {:else}
                  <em class="neutral">Detecting…</em>
                {/if}
              </span>
              {#if detection?.detail}<small>{detection.detail}</small>{/if}
            </button>
          {/each}
        </div>

        <div class="step-actions end"><button class="primary" type="button" onclick={() => step = 2}>Continue <span>→</span></button></div>
      </section>
    {:else if step === 2}
      <section class="step-section narrow" aria-labelledby="step-two-title">
        <p class="eyebrow"><span></span> Step two · project boundary</p>
        <h1 id="step-two-title">Point HII at<br />one folder.</h1>
        <p class="deck">Nothing is uploaded. HII will prepare a read-only preview so you can decide exactly what belongs.</p>

        <form class="folder-panel" onsubmit={(event) => { event.preventDefault(); void previewInventory(); }}>
          <label for="root-path">Project folder path</label>
          <div class="path-row">
            <input id="root-path" bind:value={rootPath} placeholder="/Users/you/Projects/my-project" autocomplete="off" spellcheck="false" />
            {#if hasTauriDialog()}<button type="button" class="browse" onclick={() => void chooseFolder()}>Browse…</button>{/if}
          </div>
          <p>Use the narrowest folder that contains the work. You can exclude individual files next.</p>
          <button class="primary" disabled={!rootPath.trim() || busy}>{busy ? 'Preparing preview…' : 'Preview this folder'} <span>→</span></button>
        </form>
        <div class="step-actions"><button class="back" type="button" onclick={goBack}>← Back</button></div>
      </section>
    {:else if step === 3 && inventory}
      <section class="step-section inventory-section" aria-labelledby="step-three-title">
        <p class="eyebrow"><span></span> Step three · approve context</p>
        <div class="title-split">
          <div><h1 id="step-three-title">Review what<br />HII may read.</h1><p class="deck">Exclude anything that does not belong. Approval is explicit and applies only to this project.</p></div>
          <div class="inventory-stat"><strong>{inventory.count - exclusions.length}</strong><span>included files</span><small>{formatBytes(inventory.totalBytes)} previewed</small></div>
        </div>

        <div class="inventory-panel">
          <div class="inventory-head"><span>{inventory.rootPath}</span><span>Kind / size</span><span>Include</span></div>
          <div class="inventory-list">
            {#each inventory.items as item}
              <label class:excluded={exclusions.includes(item.sourcePath)}>
                <span class="file-name"><strong>{item.sourcePath}</strong><small>.{item.format}</small></span>
                <span class="file-meta"><em>{item.kind}</em>{formatBytes(item.sizeBytes)}</span>
                <input type="checkbox" checked={!exclusions.includes(item.sourcePath)} onchange={() => toggleExclusion(item.sourcePath)} aria-label={`Include ${item.sourcePath}`} />
              </label>
            {/each}
          </div>
        </div>

        <label class="approval-box">
          <input type="checkbox" bind:checked={approved} />
          <span><strong>I approve this project context.</strong><small>HII may index only the included files above for this bounded local workspace.</small></span>
        </label>
        <div class="step-actions"><button class="back" type="button" onclick={goBack}>← Back</button><button class="primary" type="button" disabled={!approved || busy} onclick={() => void approveAndCreate()}>{busy ? 'Creating project…' : 'Approve + continue'} <span>→</span></button></div>
      </section>
    {:else if step === 4}
      <section class="step-section narrow" aria-labelledby="step-four-title">
        <p class="eyebrow"><span></span> Step four · bounded first task</p>
        <h1 id="step-four-title">Give {selectedAgent === 'claude' ? 'Claude' : 'Codex'}<br />one clear outcome.</h1>
        <p class="deck">Start small. The best first run teaches the workspace, produces visible proof, and stays easy to reverse.</p>

        <div class="task-panel">
          <label for="bounded-task">What should happen?</label>
          <textarea id="bounded-task" bind:value={task} rows="6" placeholder="Describe one bounded, verifiable task…"></textarea>
          <div class="presets" aria-label="Task suggestions">
            {#each taskPresets as preset, index}
              <button type="button" class:selected={task === preset} onclick={() => task = preset}><span>0{index + 1}</span>{preset}</button>
            {/each}
          </div>
          {#if selectedAgent === 'ollama'}<p class="routing-note">Ollama supplies the private local model; activation runs through the bounded Codex executor in this founder beta.</p>{/if}
        </div>
        <div class="step-actions"><button class="back" type="button" onclick={goBack}>← Back</button><button class="primary acid" type="button" disabled={!task.trim() || busy} onclick={() => void startActivation()}>{busy ? 'Starting…' : 'Start bounded task'} <span>↗</span></button></div>
      </section>
    {:else if step === 5}
      <section class="step-section running-section" aria-labelledby="step-five-title">
        <div class="orbit" aria-hidden="true"><span></span><i></i><b></b></div>
        <p class="eyebrow light"><span></span> Step five · work in progress</p>
        <h1 id="step-five-title">{selectedAgent === 'claude' ? 'Claude' : 'Codex'} is learning<br />this workspace.</h1>
        <p class="deck">HII is watching the bounded run and checking for a finished receipt every three seconds.</p>
        <div class="run-card">
          <span class="live-dot"></span>
          <div><strong>{runStatus === 'running' ? 'Working locally' : runStatus}</strong><p>{task}</p></div>
          <code>{activationId}</code>
        </div>
        {#if errorMessage}<button class="retry" type="button" onclick={() => void checkStatus()}>Try status again</button>{/if}
      </section>
    {:else if step === 6 && receipt}
      <section class="step-section receipt-section" aria-labelledby="step-six-title">
        <p class="eyebrow"><span></span> Step six · verified receipt</p>
        <div class="receipt-hero"><div><h1 id="step-six-title">The work came<br />back with proof.</h1><p class="deck">Keep the outcome, checks, and evidence together. A claim becomes trustworthy when you can inspect it.</p></div><div class="receipt-stamp"><span>HII</span><strong>{receipt.status ?? 'completed'}</strong><small>Local activation receipt</small></div></div>

        <div class="receipt-grid">
          <article class="receipt-summary"><span>01 / Summary</span><h2>{receipt.summary ?? 'The bounded activation completed.'}</h2></article>
          <article><span>02 / Outcome</span><p>{receipt.outcome ?? receipt.status ?? 'Completed'}</p></article>
          <article><span>03 / Verification</span><p>{verificationSummary(receipt)}</p></article>
        </div>

        <div class="proof-grid">
          <section aria-labelledby="checks-title"><div class="section-label"><h2 id="checks-title">Checks</h2><span>{receiptChecks(receipt).length}</span></div>
            {#if receiptChecks(receipt).length}
              <div class="check-list">{#each receiptChecks(receipt) as check}<article><i class:passed={check.ok}>{check.ok ? '✓' : '!'}</i><div><strong>{check.name ?? check.command ?? 'Verification check'}</strong>{#if check.command && check.name}<code>{check.command}</code>{/if}{#if check.output}<p>{check.output}</p>{/if}</div></article>{/each}</div>
            {:else}<p class="empty-proof">No individual checks were included.</p>{/if}
          </section>
          <section aria-labelledby="proof-title"><div class="section-label"><h2 id="proof-title">Proof paths</h2><span>{proofPaths(receipt).length}</span></div>
            {#if proofPaths(receipt).length}<div class="path-list">{#each proofPaths(receipt) as path}<code>{path}</code>{/each}</div>{:else}<p class="empty-proof">No proof paths were included.</p>{/if}
          </section>
        </div>
        {#if activationJourney}
          <section class="journey-card" aria-labelledby="journey-title">
            <div class="section-label"><h2 id="journey-title">First win journey</h2><span>{activationJourney.milestones.length}</span></div>
            <div class="journey-head"><p>HII records these milestones locally so the founder cohort can improve real drop-offs without external analytics or captured task content.</p><strong>{activationJourney.elapsedSeconds}s to receipt</strong></div>
            <ol>
              {#each activationJourney.milestones as milestone}
                <li class:failed={milestone.milestone === 'run_failed'}><i>{milestone.milestone === 'run_failed' ? '!' : '✓'}</i><span><strong>{milestoneLabel(milestone.milestone)}</strong><small>{new Date(milestone.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></span></li>
              {/each}
            </ol>
          </section>
        {/if}
        {#if receipt.next}<div class="next-card"><span>Next action</span><p>{receipt.next}</p></div>{/if}
      </section>
    {/if}

    {#if errorMessage && step !== 5}<p class="error-message" role="alert">{errorMessage}</p>{/if}
    {#if journeyWarning}<p class="journey-warning" role="status">{journeyWarning}</p>{/if}
    {#if isMock()}<div class="mock-flag">Demo data · activation mock</div>{/if}
  </main>
</div>

<style>
  :global(body) { background:#f8f8f5; }
  .activation-page { --paper:#f8f8f5; --ink:#151515; --blue:#176bff; --acid:#baff34; --muted:#747a76; min-height:100vh; background:var(--paper); color:var(--ink); font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; }
  .activation-page * { box-sizing:border-box; }
  button, input, textarea { font:inherit; }
  button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible { outline:3px solid var(--acid); outline-offset:3px; }
  .activation-header { display:grid; min-height:78px; grid-template-columns:1fr auto minmax(180px,1fr); align-items:center; gap:28px; padding:0 clamp(20px,4vw,64px); border-bottom:1px solid rgba(21,21,21,.1); background:rgba(248,248,245,.9); }
  .wordmark { width:max-content; color:var(--ink); font-size:35px; font-weight:700; letter-spacing:-.09em; line-height:1; text-decoration:none; }
  .progress-copy { display:flex; gap:16px; align-items:center; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; letter-spacing:.11em; text-transform:uppercase; }
  .progress-copy span { color:var(--muted); }
  .progress-track { display:grid; grid-template-columns:repeat(6,1fr); gap:5px; justify-self:end; width:min(100%,270px); }
  .progress-track i { height:3px; background:#dfe1dd; transition:background 180ms ease; }
  .progress-track i.active { background:var(--blue); }
  main { position:relative; }
  .step-section { width:min(100%,1280px); margin:0 auto; padding:clamp(62px,8vw,118px) clamp(20px,5vw,72px) 96px; }
  .step-section.narrow { width:min(100%,1020px); }
  .eyebrow { display:flex; align-items:center; gap:10px; margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
  .eyebrow > span { width:8px; height:8px; border-radius:50%; background:var(--blue); box-shadow:0 0 0 4px rgba(23,107,255,.12); }
  h1 { margin:30px 0 0; font-size:clamp(58px,8vw,116px); font-weight:650; letter-spacing:-.075em; line-height:.84; }
  .deck { max-width:700px; margin:34px 0 0; color:#5f6561; font-size:clamp(17px,2vw,23px); letter-spacing:-.025em; line-height:1.45; }
  .agent-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:58px; }
  .agent-card { min-height:330px; border:1px solid #d9dcd8; border-radius:18px; background:white; padding:25px; color:inherit; text-align:left; transition:transform 160ms ease,border-color 160ms ease,box-shadow 160ms ease; }
  .agent-card:hover { transform:translateY(-3px); border-color:#aeb3af; box-shadow:0 18px 50px rgba(35,38,37,.1); }
  .agent-card.selected { border:2px solid var(--blue); padding:24px; box-shadow:0 20px 55px rgba(23,107,255,.14); }
  .card-topline { display:flex; justify-content:space-between; align-items:center; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; font-style:normal; letter-spacing:.11em; text-transform:uppercase; }
  .card-topline b { color:var(--blue); }
  .card-topline i { border-radius:999px; background:#f0f1ee; padding:6px 8px; font-style:normal; }
  .agent-card.selected .card-topline i { background:var(--acid); }
  .agent-card > strong { display:block; margin-top:58px; font-size:37px; letter-spacing:-.055em; }
  .agent-card > p { min-height:66px; margin:13px 0 0; color:#656a67; font-size:14px; line-height:1.55; }
  .badges { display:flex; flex-wrap:wrap; gap:6px; margin-top:22px; }
  .badges em { border-radius:999px; background:#eee; padding:6px 8px; color:#616662; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:7px; font-style:normal; letter-spacing:.07em; text-transform:uppercase; }
  .badges em.ready { background:#e5fbd0; color:#315e12; }
  .badges em.neutral { background:#f0f1ee; color:#757a76; }
  .agent-card small { display:block; margin-top:13px; color:#868b87; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; line-height:1.5; }
  .step-actions { display:flex; justify-content:space-between; align-items:center; margin-top:34px; }
  .step-actions.end { justify-content:flex-end; }
  .primary, .back, .browse, .retry { border:0; cursor:pointer; }
  .primary { display:inline-flex; min-height:50px; align-items:center; justify-content:center; gap:26px; border-radius:999px; background:var(--blue); padding:0 23px; color:white; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; font-weight:700; }
  .primary.acid { background:var(--acid); color:var(--ink); }
  .primary:disabled { cursor:not-allowed; opacity:.38; }
  .back { background:transparent; color:#686d69; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; }
  .folder-panel, .task-panel { margin-top:52px; border-radius:20px; background:white; padding:clamp(24px,4vw,42px); box-shadow:0 24px 70px rgba(35,38,37,.09); }
  .folder-panel label, .task-panel > label { display:block; margin-bottom:13px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.11em; text-transform:uppercase; }
  .path-row { display:grid; grid-template-columns:1fr auto; gap:8px; }
  .path-row input, .task-panel textarea { width:100%; border:1px solid #d7dad6; border-radius:12px; background:#fbfbf9; color:var(--ink); }
  .path-row input { min-height:56px; padding:0 17px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .browse { border-radius:12px; background:#eceeea; padding:0 18px; font-size:12px; font-weight:650; }
  .folder-panel > p { margin:13px 0 25px; color:#7a7f7b; font-size:12px; line-height:1.5; }
  .title-split, .receipt-hero { display:grid; grid-template-columns:1fr auto; gap:55px; align-items:end; }
  .inventory-stat { display:flex; min-width:210px; flex-direction:column; border-left:1px solid #d5d8d4; padding-left:25px; }
  .inventory-stat strong { color:var(--blue); font-size:64px; letter-spacing:-.07em; line-height:1; }
  .inventory-stat span, .inventory-stat small { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; letter-spacing:.09em; text-transform:uppercase; }
  .inventory-stat small { margin-top:12px; color:var(--muted); }
  .inventory-panel { margin-top:54px; overflow:hidden; border-radius:18px; background:white; box-shadow:0 22px 65px rgba(35,38,37,.08); }
  .inventory-head, .inventory-list label { display:grid; grid-template-columns:1fr 180px 65px; align-items:center; gap:20px; }
  .inventory-head { min-height:45px; padding:0 20px; background:var(--ink); color:#b8bdb9; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; letter-spacing:.08em; text-transform:uppercase; }
  .inventory-head span:last-child { text-align:center; }
  .inventory-list label { min-height:67px; padding:11px 20px; border-bottom:1px solid #eceeeb; cursor:pointer; transition:opacity 120ms ease; }
  .inventory-list label:last-child { border:0; }
  .inventory-list label.excluded { opacity:.4; }
  .file-name strong { display:block; overflow:hidden; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
  .file-name small { color:#8b908c; font-size:9px; }
  .file-meta { display:flex; align-items:center; gap:12px; color:#727773; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; }
  .file-meta em { border-radius:999px; background:#edf2ff; padding:5px 7px; color:var(--blue); font-size:7px; font-style:normal; text-transform:uppercase; }
  .inventory-list input, .approval-box input { width:18px; height:18px; accent-color:var(--blue); justify-self:center; }
  .approval-box { display:grid; grid-template-columns:auto 1fr; gap:15px; align-items:start; margin-top:22px; border:1px solid #cdd1cc; border-radius:14px; background:white; padding:19px; cursor:pointer; }
  .approval-box input { margin-top:2px; }
  .approval-box strong, .approval-box small { display:block; }
  .approval-box strong { font-size:14px; }
  .approval-box small { margin-top:5px; color:#747a76; font-size:11px; line-height:1.45; }
  .task-panel textarea { min-height:160px; resize:vertical; padding:17px; font-size:18px; line-height:1.5; }
  .presets { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:13px; }
  .presets button { min-height:108px; border:1px solid #dfe1de; border-radius:11px; background:#f7f8f5; padding:14px; color:#565b57; font-size:11px; line-height:1.45; text-align:left; }
  .presets button.selected { border-color:var(--blue); background:#edf3ff; color:var(--ink); }
  .presets button span { display:block; margin-bottom:12px; color:var(--blue); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; }
  .routing-note { margin:20px 0 0; border-left:3px solid var(--acid); padding-left:13px; color:#686d69; font-size:12px; line-height:1.5; }
  .running-section { position:relative; min-height:calc(100vh - 78px); overflow:hidden; background:var(--ink); color:white; }
  .running-section .deck { color:#aeb3b0; }
  .eyebrow.light > span, .live-dot { background:var(--acid); box-shadow:0 0 0 4px rgba(186,255,52,.12); }
  .orbit { position:absolute; right:-5vw; bottom:-18vw; width:58vw; height:58vw; border:1px solid rgba(255,255,255,.08); border-radius:50%; animation:rotate 18s linear infinite; }
  .orbit::before, .orbit::after { position:absolute; border:1px solid rgba(255,255,255,.07); border-radius:50%; content:''; inset:13%; }
  .orbit::after { inset:27%; }
  .orbit span, .orbit i, .orbit b { position:absolute; border-radius:50%; background:var(--blue); }
  .orbit span { top:11%; left:15%; width:16px; height:16px; }
  .orbit i { right:25%; bottom:8%; width:8px; height:8px; background:var(--acid); }
  .orbit b { top:48%; left:48%; width:32px; height:32px; box-shadow:0 0 80px rgba(23,107,255,.8); }
  .run-card { position:relative; z-index:2; display:grid; grid-template-columns:auto 1fr auto; gap:16px; align-items:center; max-width:890px; margin-top:60px; border:1px solid rgba(255,255,255,.12); border-radius:17px; background:rgba(255,255,255,.06); padding:20px; backdrop-filter:blur(12px); }
  .live-dot { width:10px; height:10px; border-radius:50%; animation:pulse 1.5s ease infinite; }
  .run-card strong { font-size:14px; }
  .run-card p { margin:5px 0 0; color:#aeb3b0; font-size:12px; }
  .run-card code { color:#808682; font-size:9px; }
  .retry { position:relative; z-index:2; margin-top:18px; border-radius:999px; background:var(--acid); padding:10px 14px; }
  .receipt-stamp { display:flex; width:180px; height:180px; flex-direction:column; align-items:center; justify-content:center; border:1px solid #cdd0cc; border-radius:50%; text-align:center; }
  .receipt-stamp span { color:var(--blue); font-size:34px; font-weight:700; letter-spacing:-.08em; }
  .receipt-stamp strong, .receipt-stamp small { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:uppercase; }
  .receipt-stamp strong { margin-top:9px; font-size:9px; letter-spacing:.11em; }
  .receipt-stamp small { margin-top:6px; color:var(--muted); font-size:6px; letter-spacing:.09em; }
  .receipt-grid { display:grid; grid-template-columns:1.3fr .7fr .7fr; gap:1px; margin-top:65px; background:#d6d9d5; border:1px solid #d6d9d5; }
  .receipt-grid article { min-height:200px; background:white; padding:25px; }
  .receipt-grid article > span, .section-label h2, .next-card span { color:var(--blue); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; font-weight:700; letter-spacing:.11em; text-transform:uppercase; }
  .receipt-grid h2 { margin:40px 0 0; font-size:25px; font-weight:550; letter-spacing:-.035em; line-height:1.25; }
  .receipt-grid article > p { margin:40px 0 0; color:#5e635f; font-size:15px; line-height:1.55; }
  .proof-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:14px; }
  .proof-grid > section { border-radius:15px; background:white; padding:24px; }
  .section-label { display:flex; justify-content:space-between; align-items:center; padding-bottom:17px; border-bottom:1px solid #e4e6e3; }
  .section-label h2 { margin:0; }
  .section-label span { display:grid; width:24px; height:24px; place-items:center; border-radius:50%; background:var(--ink); color:white; font-size:9px; }
  .check-list article { display:grid; grid-template-columns:auto 1fr; gap:13px; padding:16px 0; border-bottom:1px solid #eceeeb; }
  .check-list i { display:grid; width:24px; height:24px; place-items:center; border-radius:50%; background:#ffe2df; color:#a32b22; font-size:10px; font-style:normal; }
  .check-list i.passed { background:#e5fbd0; color:#315e12; }
  .check-list strong, .check-list code, .check-list p { display:block; }
  .check-list strong { font-size:12px; }
  .check-list code, .check-list p { margin-top:5px; color:#747a76; font-size:9px; line-height:1.45; }
  .path-list { display:grid; gap:8px; padding-top:16px; }
  .path-list code { overflow-wrap:anywhere; border-radius:8px; background:#f0f2ef; padding:11px; color:#4e534f; font-size:10px; }
  .empty-proof { color:#858a86; font-size:12px; }
  .journey-card { margin-top:14px; border-radius:15px; background:white; padding:24px; }
  .journey-head { display:flex; justify-content:space-between; gap:32px; align-items:start; padding:18px 0; }
  .journey-head p { max-width:650px; margin:0; color:#686d69; font-size:12px; line-height:1.55; }
  .journey-head > strong { flex-shrink:0; border-radius:999px; background:#edf3ff; padding:8px 11px; color:var(--blue); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; text-transform:uppercase; }
  .journey-card ol { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:1px; margin:0; padding:0; background:#e4e6e3; list-style:none; }
  .journey-card li { display:flex; min-height:96px; gap:10px; align-items:start; background:#f8f9f6; padding:14px; }
  .journey-card li i { display:grid; width:22px; height:22px; flex:0 0 auto; place-items:center; border-radius:50%; background:#e5fbd0; color:#315e12; font-size:9px; font-style:normal; }
  .journey-card li.failed i { background:#ffe2df; color:#a32b22; }
  .journey-card li strong, .journey-card li small { display:block; }
  .journey-card li strong { font-size:10px; line-height:1.35; }
  .journey-card li small { margin-top:7px; color:#858a86; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:7px; }
  .next-card { margin-top:14px; border-radius:14px; background:var(--acid); padding:22px; }
  .next-card span { color:#3c4b22; }
  .next-card p { margin:10px 0 0; font-size:16px; }
  .error-message { position:fixed; right:20px; bottom:20px; z-index:10; max-width:440px; border-radius:12px; background:#fff0ee; padding:15px 18px; color:#9d271f; box-shadow:0 12px 35px rgba(70,20,15,.13); font-size:12px; }
  .journey-warning { position:fixed; left:20px; bottom:20px; z-index:10; max-width:440px; border-radius:12px; background:#fff7dc; padding:15px 18px; color:#775b05; box-shadow:0 12px 35px rgba(70,55,15,.1); font-size:12px; }
  .mock-flag { position:fixed; right:16px; top:92px; z-index:5; border-radius:999px; background:var(--acid); padding:7px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:7px; letter-spacing:.08em; text-transform:uppercase; }
  @keyframes pulse { 50% { opacity:.35; transform:scale(.75); } }
  @keyframes rotate { to { transform:rotate(360deg); } }
  @media (max-width:850px) {
    .agent-grid, .receipt-grid, .proof-grid, .journey-card ol { grid-template-columns:1fr; }
    .agent-card { min-height:auto; }
    .agent-card > strong { margin-top:34px; }
    .agent-card > p { min-height:auto; }
    .title-split, .receipt-hero { grid-template-columns:1fr; }
    .inventory-stat { border-left:0; border-top:1px solid #d5d8d4; padding:22px 0 0; }
    .presets { grid-template-columns:1fr; }
    .presets button { min-height:auto; }
    .receipt-stamp { width:140px; height:140px; }
    .journey-head { display:block; }
    .journey-head > strong { display:inline-block; margin-top:14px; }
  }
  @media (max-width:600px) {
    .activation-header { grid-template-columns:1fr auto; gap:14px; padding:0 16px; }
    .progress-copy span { display:none; }
    .progress-track { grid-column:1/-1; width:100%; margin-top:-17px; }
    .step-section { padding:58px 16px 70px; }
    h1 { font-size:clamp(53px,17vw,78px); }
    .inventory-head { display:none; }
    .inventory-list label { grid-template-columns:1fr auto; gap:10px; }
    .file-meta { grid-column:1; }
    .inventory-list input { grid-column:2; grid-row:1/3; }
    .step-actions { gap:20px; }
    .run-card { grid-template-columns:auto 1fr; }
    .run-card code { grid-column:2; }
  }
  @media (prefers-reduced-motion:reduce) { .orbit, .live-dot { animation:none; } .agent-card, .progress-track i { transition:none; } }
</style>
