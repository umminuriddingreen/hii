<script lang="ts">
  import { onMount } from 'svelte';
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
  export let onPatch: (patch: Partial<WorkspaceNode>) => void;

  type ArtifactResponse = {
    runId: string;
    artifact: string;
    path: string;
    name: string;
    extension: string;
    size: number;
    editable: boolean;
    content: string | null;
    revision: string;
    sourceReceipt?: string | null;
    edit?: { id?: string; editedAt?: string; revision?: string };
  };

  let artifact: ArtifactResponse | null = null;
  let content = '';
  let savedContent = '';
  let loading = true;
  let saving = false;
  let error = '';

  $: dirty = Boolean(artifact?.editable) && content !== savedContent;
  $: artifactPath = String(node.payload.artifactPath || node.payload.path || '');
  $: runId = String(node.payload.runId || node.object?.runId || '');

  async function apiJson(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || 'HII artifact request failed.'), { status: response.status });
    return body;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      artifact = await apiJson(`/api/workspace/artifacts?runId=${encodeURIComponent(runId)}&artifact=${encodeURIComponent(artifactPath)}`) as ArtifactResponse;
      content = artifact.content || '';
      savedContent = content;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not open the receipt artifact.';
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!artifact?.editable || !dirty || saving) return;
    saving = true;
    error = '';
    try {
      const result = await apiJson('/api/workspace/artifacts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          artifact: artifactPath,
          content,
          ifMatch: artifact.revision
        })
      }) as { artifact: ArtifactResponse };
      artifact = result.artifact;
      savedContent = content;
      const editId = String(result.artifact.edit?.id || '');
      const editedAt = String(result.artifact.edit?.editedAt || new Date().toISOString());
      onPatch({
        object: {
          ...node.object,
          kind: node.object?.kind || 'artifact',
          source: result.artifact.path,
          proofRefs: Array.from(new Set([
            ...(node.object?.proofRefs || []),
            result.artifact.sourceReceipt || '',
            editId ? `artifact-edit:${editId}` : ''
          ].filter(Boolean))),
          audit: [
            ...(node.object?.audit || []),
            {
              ts: editedAt,
              actor: 'human' as const,
              action: 'edited receipt-linked artifact in HII',
              note: editId ? `Human edit receipt ${editId}` : undefined
            }
          ].slice(-20)
        },
        payload: {
          ...node.payload,
          path: result.artifact.path,
          revision: result.artifact.revision,
          editReceiptId: editId,
          editedAt
        }
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save the receipt artifact.';
    } finally {
      saving = false;
    }
  }

  async function openNative() {
    error = '';
    try {
      await apiJson('/api/files/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: artifact?.path || artifactPath })
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not open the artifact in its native app.';
    }
  }

  onMount(() => {
    void load();
  });
</script>

<article class="flex h-full min-h-0 flex-col bg-white">
  <header class="flex shrink-0 items-center justify-between border-b px-3 py-2">
    <div class="min-w-0">
      <p class="truncate text-[12px] font-semibold text-neutral-900">{artifact?.name || String(node.payload.title || 'Run artifact')}</p>
      <p class="truncate font-mono text-[8px] uppercase tracking-[.08em] text-neutral-400">receipt-linked artifact · {artifact?.editable ? 'editable' : 'native file'}</p>
    </div>
    <span class={`ml-2 rounded-full px-2 py-1 font-mono text-[7px] uppercase ${dirty ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'}`}>{dirty ? 'unsaved' : 'saved'}</span>
  </header>

  {#if loading}
    <div class="grid min-h-0 flex-1 place-items-center font-mono text-[9px] uppercase text-neutral-400">Opening verified artifact…</div>
  {:else if artifact?.editable}
    <textarea bind:value={content} class="min-h-0 flex-1 resize-none bg-[#fffef8] p-4 font-mono text-[11px] leading-5 text-neutral-800 outline-none" aria-label={`Edit ${artifact.name}`}></textarea>
  {:else if artifact}
    <div class="grid min-h-0 flex-1 place-items-center p-6 text-center">
      <div>
        <span class="text-4xl">↗</span>
        <p class="mt-3 text-[13px] font-semibold">{artifact.name}</p>
        <p class="mt-2 font-mono text-[9px] text-neutral-400">{artifact.size} bytes · {artifact.extension || 'file'}</p>
        <button class="mt-4 rounded-full bg-neutral-950 px-4 py-2 font-mono text-[8px] uppercase tracking-[.1em] text-white" on:click={openNative}>Open in native app</button>
      </div>
    </div>
  {:else}
    <div class="grid min-h-0 flex-1 place-items-center p-5 text-center text-[11px] text-red-700">{error || 'Artifact unavailable.'}</div>
  {/if}

  <footer class="shrink-0 border-t bg-neutral-50 px-3 py-2">
    {#if error}<p class="mb-2 text-[10px] leading-4 text-red-700">{error}</p>{/if}
    <div class="flex items-center justify-between gap-2">
      <span class="min-w-0 truncate font-mono text-[8px] text-neutral-400">{artifact?.path || artifactPath}</span>
      <div class="flex shrink-0 gap-1.5">
        <button class="rounded-full border bg-white px-2.5 py-1 font-mono text-[8px] uppercase text-neutral-600" on:click={load}>Reload</button>
        {#if artifact?.editable}<button class="rounded-full bg-neutral-950 px-3 py-1 font-mono text-[8px] uppercase text-white disabled:opacity-30" disabled={!dirty || saving} on:click={save}>{saving ? 'Saving…' : 'Save edit'}</button>{/if}
      </div>
    </div>
    {#if node.payload.editReceiptId}<p class="mt-1 truncate font-mono text-[7px] uppercase tracking-[.08em] text-emerald-700">human edit receipt · {String(node.payload.editReceiptId)}</p>{/if}
  </footer>
</article>
