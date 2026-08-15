<script lang="ts">
  import type { PageData } from './$types';

  export let data: PageData;

  let tasks = data.tasks;
  const lanes = ['backlog', 'next', 'doing', 'blocked', 'done'] as const;
  let title = '';
  let message = '';
  let busy = false;
  type ProposalDraft = { title: string; notes: string; coordinate: string; acceptance: string };

  function reviewState(task: (typeof tasks)[number]) {
    return task.reviewState ?? 'approved';
  }

  function draftsFor(list: typeof tasks) {
    return Object.fromEntries(list.map((task) => [task.id, {
      title: task.title,
      notes: task.notes ?? '',
      coordinate: task.coordinate ?? '',
      acceptance: (task.acceptanceCriteria ?? []).join('\n')
    }])) as Record<string, ProposalDraft>;
  }

  let proposalDrafts = draftsFor(tasks);

  async function request(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
    const response = await fetch('/api/board/tasks', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Board update failed.');
    return result;
  }

  async function refresh() {
    tasks = (await (await fetch('/api/board/tasks?includeDone=1')).json()).tasks || [];
    proposalDrafts = draftsFor(tasks);
  }

  async function add() {
    if (!title.trim() || busy) return;
    busy = true;
    message = '';
    try {
      await request('POST', {
        title,
        origin: 'human',
        approvedBy: 'local operator'
      });
      title = '';
      message = 'Intent added to the backlog.';
      await refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Task was not added.';
    } finally {
      busy = false;
    }
  }

  async function move(id: string, lane: string) {
    message = '';
    try {
      await request('PATCH', { id, lane });
      await refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Task was not moved.';
    }
  }

  async function approve(task: (typeof tasks)[number]) {
    message = '';
    try {
      await request('PATCH', {
        id: task.id,
        lane: task.requestedLane === 'doing' ? 'doing' : 'next',
        reviewState: 'approved',
        approvedBy: 'local operator'
      });
      message = 'Proposal approved into active work.';
      await refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Proposal was not approved.';
    }
  }

  async function saveDefinition(task: (typeof tasks)[number]) {
    const draft = proposalDrafts[task.id];
    if (!draft) return;
    message = '';
    try {
      await request('PATCH', {
        id: task.id,
        title: draft.title,
        notes: draft.notes,
        coordinate: draft.coordinate,
        acceptanceCriteria: draft.acceptance.split('\n')
      });
      message = 'Proposal definition saved. Review “done when” before approval.';
      await refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Proposal definition was not saved.';
    }
  }

  async function archive(task: (typeof tasks)[number]) {
    message = '';
    try {
      await request('PATCH', { id: task.id, lane: 'done' });
      message = 'Proposal archived without activation.';
      await refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Proposal was not archived.';
    }
  }
</script>

<div class="hii-page board-shell">
  <aside class="hii-side-nav">
    <a href="/boards" class="hii-side-link" data-active="true">Boards</a>
    <a href="/console" class="hii-side-link">Console</a>
    <a href="/knowledge" class="hii-side-link">Knowledge</a>
  </aside>

  <div class="board-main">
    <header class="hii-page-header board-header">
      <div>
        <p class="hii-kicker">hii board / governed work</p>
        <h1 class="hii-page-title">Proposals stay proposals until you approve them.</h1>
        <p class="hii-page-copy">
          Human intent, agent suggestions, and system-derived work share one local ledger without
          sharing the same authority.
        </p>
      </div>
      <div class="board-proof">
        <span>{tasks.filter((task) => reviewState(task) === 'proposed' && task.lane !== 'done').length}</span>
        <small>awaiting review</small>
      </div>
    </header>

    <div class="hii-terminal-frame board-store">
      <span>append-only task ledger</span>
      <code>{data.store}</code>
    </div>

    <section class="hii-card capture" aria-labelledby="capture-title">
      <div>
        <span>Human intent</span>
        <strong id="capture-title">Add a bounded outcome</strong>
        <small>Your addition is recorded as approved intent. Generated work enters as a proposal.</small>
      </div>
      <form on:submit|preventDefault={add}>
        <input
          class="hii-field"
          bind:value={title}
          placeholder="Example: verify the five-minute founder demo"
          aria-label="Task outcome"
        />
        <button class="hii-command-button" disabled={busy || !title.trim()}>
          {busy ? 'Adding…' : 'Add intent'}
        </button>
      </form>
    </section>

    {#if message}
      <p class="board-message" role="status">{message}</p>
    {/if}

    <div class="lanes">
      {#each lanes as lane}
        <section class="hii-card lane" data-lane={lane}>
          <header>
            <h2>{lane}</h2>
            <span>{tasks.filter((task) => task.lane === lane).length}</span>
          </header>

          <div class="lane-cards">
            {#each tasks.filter((task) => task.lane === lane) as task}
              <article class:proposal={reviewState(task) === 'proposed'}>
                <div class="task-state">
                  <span>{reviewState(task) === 'proposed' ? 'proposal' : task.priority}</span>
                  <code>{task.id.slice(0, 8)}</code>
                </div>
                <strong>{task.title}</strong>
                <p>{task.owner} · {task.origin ?? 'legacy'} · {task.source}</p>
                {#if task.coordinate}<code class="coordinate">{task.coordinate}</code>{/if}
                {#if task.notes}<p class="task-notes">{task.notes}</p>{/if}
                {#if task.acceptanceCriteria?.length}
                  <div class="acceptance">
                    <span>Done when</span>
                    <ul>
                      {#each task.acceptanceCriteria as criterion}<li>{criterion}</li>{/each}
                    </ul>
                  </div>
                {/if}
                {#if task.runStatus}
                  <div class="run-state">
                    <span>run {task.runStatus.replace('_', ' ')}</span>
                    {#if task.runId}<code>{task.runId.slice(0, 12)}</code>{/if}
                    {#if task.receiptRef}<strong>receipt linked</strong>{/if}
                  </div>
                {/if}
                {#if reviewState(task) === 'proposed' && task.lane !== 'done'}
                  <div class:ready={task.proposalQuality.ready} class="proposal-quality">
                    <strong>{task.proposalQuality.ready ? 'Definition ready' : 'Needs definition'}</strong>
                    {#each task.proposalQuality.issues as issue}<span>{issue}</span>{/each}
                  </div>
                  {#if proposalDrafts[task.id]}
                    <div class="proposal-definition">
                      <label>
                        Outcome
                        <input bind:value={proposalDrafts[task.id].title} aria-label={`Outcome for ${task.title}`} />
                      </label>
                      <label>
                        Why / context
                        <textarea bind:value={proposalDrafts[task.id].notes} aria-label={`Why and context for ${task.title}`} rows="3"></textarea>
                      </label>
                      <label>
                        Done when · one criterion per line
                        <textarea bind:value={proposalDrafts[task.id].acceptance} aria-label={`Done when for ${task.title}`} rows="3"></textarea>
                      </label>
                      <label>
                        Coordinate
                        <input bind:value={proposalDrafts[task.id].coordinate} aria-label={`Coordinate for ${task.title}`} />
                      </label>
                      <button type="button" on:click={() => saveDefinition(task)}>Save definition</button>
                    </div>
                  {/if}
                  <div class="proposal-actions">
                    <span>Requested {task.requestedLane ?? 'review'}</span>
                    <button type="button" class="archive" on:click={() => archive(task)}>Archive</button>
                    <button type="button" disabled={!task.proposalQuality.ready} on:click={() => approve(task)}>Approve to {task.requestedLane === 'doing' ? 'doing' : 'next'}</button>
                  </div>
                {:else if reviewState(task) === 'proposed'}
                  <div class="proposal-actions archived">
                    <span>Archived without activation</span>
                    <button type="button" on:click={() => move(task.id, 'backlog')}>Restore proposal</button>
                  </div>
                {:else}
                  <select
                    class="hii-select"
                    value={task.lane}
                    aria-label={`Move ${task.title}`}
                    on:change={(event) => move(task.id, event.currentTarget.value)}
                  >
                    {#each lanes as target}
                      <option value={target}>{target}</option>
                    {/each}
                  </select>
                {/if}
              </article>
            {/each}
            {#if tasks.filter((task) => task.lane === lane).length === 0}
              <p class="empty">No work here.</p>
            {/if}
          </div>
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .board-shell {
    display: grid;
    gap: 24px;
    grid-template-columns: 210px minmax(0, 1fr);
  }
  .board-main {
    min-width: 0;
  }
  .board-header {
    display: grid;
    align-items: end;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .board-header .hii-page-copy {
    max-width: 760px;
  }
  .board-proof {
    display: grid;
    min-width: 132px;
    gap: 4px;
    border-left: 3px solid var(--hii-electric-blue);
    padding: 8px 0 8px 18px;
  }
  .board-proof span {
    font-size: 44px;
    font-weight: 650;
    letter-spacing: -0.06em;
    line-height: 0.9;
  }
  .board-proof small,
  .capture span,
  .capture small,
  .board-store,
  .lane header,
  .task-state,
  .proposal-actions,
  .run-state,
  .coordinate {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .board-proof small,
  .capture span,
  .lane header,
  .task-state {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .board-store {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    margin-top: 22px;
    padding: 12px 14px;
    font-size: 10px;
  }
  .board-store code {
    overflow: hidden;
    color: #73787f;
    text-overflow: ellipsis;
  }
  .capture {
    display: grid;
    align-items: end;
    gap: 26px;
    grid-template-columns: minmax(210px, 0.55fr) minmax(320px, 1fr);
    margin-top: 14px;
    padding: 18px;
  }
  .capture > div {
    display: grid;
    gap: 5px;
  }
  .capture span {
    color: var(--hii-electric-blue);
  }
  .capture strong {
    font-size: 18px;
  }
  .capture small {
    max-width: 420px;
    color: #747981;
    font-size: 9px;
    line-height: 1.5;
  }
  .capture form {
    display: grid;
    gap: 8px;
    grid-template-columns: 1fr auto;
  }
  .capture input {
    min-width: 0;
    padding: 11px 13px;
  }
  .board-message {
    margin: 12px 0 0;
    border-left: 3px solid var(--hii-electric-blue);
    padding: 8px 12px;
    color: #50555d;
    font-size: 13px;
  }
  .lanes {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(5, minmax(190px, 1fr));
    margin-top: 16px;
    overflow-x: auto;
    padding-bottom: 12px;
  }
  .lane {
    min-height: 390px;
    padding: 14px;
  }
  .lane > header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid rgba(20, 20, 20, 0.11);
    padding-bottom: 10px;
  }
  .lane h2 {
    margin: 0;
    font: inherit;
  }
  .lane header span {
    display: grid;
    min-width: 24px;
    height: 24px;
    place-items: center;
    border-radius: 999px;
    background: #f0f1f3;
  }
  .lane-cards {
    display: grid;
    gap: 9px;
    margin-top: 10px;
  }
  .lane article {
    display: grid;
    gap: 10px;
    border: 1px solid rgba(20, 20, 20, 0.12);
    border-radius: 12px;
    background: white;
    padding: 12px;
  }
  .lane article.proposal {
    border-color: color-mix(in srgb, var(--hii-electric-blue) 44%, white);
    box-shadow: inset 3px 0 0 var(--hii-electric-blue);
  }
  .task-state {
    display: flex;
    justify-content: space-between;
    color: #767b82;
  }
  .proposal .task-state span {
    color: var(--hii-electric-blue);
  }
  .lane article > strong {
    font-size: 14px;
    line-height: 1.25;
  }
  .lane article > p {
    margin: 0;
    color: #70757d;
    font-size: 10px;
    line-height: 1.4;
  }
  .coordinate {
    overflow: hidden;
    color: #8b9096;
    font-size: 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-notes {
    white-space: pre-wrap;
  }
  .acceptance {
    display: grid;
    gap: 5px;
    border-left: 2px solid #16a34a;
    padding-left: 9px;
    color: #42474e;
    font-size: 10px;
  }
  .acceptance span,
  .proposal-quality,
  .proposal-definition label {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .acceptance span {
    color: #15803d;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .acceptance ul {
    display: grid;
    gap: 4px;
    margin: 0;
    padding-left: 16px;
  }
  .proposal-quality {
    display: grid;
    gap: 4px;
    border-radius: 8px;
    background: #fff7ed;
    padding: 8px;
    color: #9a3412;
    font-size: 9px;
    line-height: 1.4;
  }
  .proposal-quality.ready {
    background: #f0fdf4;
    color: #166534;
  }
  .proposal-definition {
    display: grid;
    gap: 8px;
    border-top: 1px solid rgba(20, 20, 20, 0.1);
    padding-top: 9px;
  }
  .proposal-definition label {
    display: grid;
    gap: 4px;
    color: #686d74;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .proposal-definition input,
  .proposal-definition textarea {
    width: 100%;
    resize: vertical;
    border: 1px solid rgba(20, 20, 20, 0.14);
    border-radius: 7px;
    background: #fafafa;
    padding: 7px 8px;
    color: #222;
    font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: normal;
    text-transform: none;
  }
  .proposal-definition button {
    border: 1px solid rgba(20, 20, 20, 0.16);
    border-radius: 999px;
    padding: 7px 9px;
    color: #25282c;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .lane select {
    width: 100%;
    margin-top: 2px;
    font-size: 11px;
  }
  .proposal-actions {
    display: grid;
    gap: 7px;
    border-top: 1px solid rgba(20, 20, 20, 0.1);
    padding-top: 9px;
  }
  .run-state {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    color: #737373;
    font-size: 9px;
    text-transform: uppercase;
  }
  .run-state strong {
    color: #047857;
    font-weight: 650;
  }
  .proposal-actions span {
    color: #777c83;
    font-size: 9px;
  }
  .proposal-actions button {
    border-radius: 999px;
    background: var(--hii-electric-blue);
    padding: 8px 10px;
    color: white;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .proposal-actions button.archive {
    border: 1px solid rgba(20, 20, 20, 0.14);
    background: white;
    color: #63666b;
  }
  .proposal-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }
  .proposal-actions.archived {
    color: #777c83;
  }
  .empty {
    margin: 12px 0;
    color: #95999f;
    font-size: 11px;
  }
  @media (max-width: 900px) {
    .board-shell {
      grid-template-columns: 1fr;
    }
    .board-shell > aside {
      display: none;
    }
    .board-header,
    .capture {
      grid-template-columns: 1fr;
    }
    .board-proof {
      width: max-content;
    }
    .capture form {
      grid-template-columns: 1fr;
    }
  }
</style>
