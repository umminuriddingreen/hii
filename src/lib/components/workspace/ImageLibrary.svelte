<script lang="ts">
  import { filterImageLibrary, type LibraryImage } from '@/lib/workspace/image-library';

  export let images:LibraryImage[]=[];
  export let onClose:()=>void;
  /** Place an image on the board at the given screen point. */
  export let onPlace:(image:LibraryImage,at:{clientX:number;clientY:number}|null)=>void;

  let query='';
  $: shown=filterImageLibrary(images,query);
  $: placedCount=images.filter(image=>image.onBoard).length;
</script>

<aside
  data-workspace-ui
  class="absolute bottom-0 right-0 top-0 z-40 flex w-[min(320px,80vw)] flex-col border-l border-neutral-900/10 bg-white/95 shadow-2xl backdrop-blur-xl"
  aria-label="Image library"
>
  <header class="border-b px-4 py-3">
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0">
        <strong class="block truncate text-[13px] text-neutral-950">Image library</strong>
        <small class="font-mono text-[8px] uppercase tracking-[.08em] text-neutral-400">
          {images.length} reference{images.length===1?'':'s'} · {placedCount} on the board
        </small>
      </div>
      <button class="rounded-full bg-neutral-100 px-2 py-1 font-mono text-[8px] uppercase text-neutral-500 hover:bg-neutral-200" on:click={onClose}>Close</button>
    </div>
    <input
      bind:value={query}
      class="mt-3 w-full rounded-lg border border-neutral-900/10 bg-white px-2.5 py-2 text-[11px] outline-none focus:border-blue-400"
      placeholder="Filter by name…" aria-label="Filter images"
    />
  </header>

  {#if !shown.length}
    <p class="p-4 text-[11px] leading-5 text-neutral-400">
      {images.length?'No image matches that filter.':'Drop images onto the canvas and they will collect here.'}
    </p>
  {:else}
    <!-- Masonry-ish two-up grid: the point of the panel is to browse visually. -->
    <div class="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-auto p-3" data-scrollable>
      {#each shown as image (image.sha256)}
        <button
          class="group relative overflow-hidden rounded-lg border border-neutral-900/10 bg-neutral-50 text-left transition-shadow hover:shadow-lg"
          title={`${image.name}\nDouble-click or drag onto the canvas`}
          draggable="true"
          on:dblclick={()=>onPlace(image,null)}
          on:dragend={(event)=>onPlace(image,{clientX:event.clientX,clientY:event.clientY})}
        >
          <img src={image.url} alt={image.name} class="block h-24 w-full object-cover" loading="lazy" />
          {#if image.onBoard}
            <span class="absolute right-1 top-1 rounded-full bg-emerald-600/90 px-1.5 py-0.5 font-mono text-[7px] uppercase text-white">placed</span>
          {/if}
          <span class="block truncate px-1.5 py-1 font-mono text-[8px] text-neutral-500">{image.name}</span>
        </button>
      {/each}
    </div>
  {/if}
</aside>
