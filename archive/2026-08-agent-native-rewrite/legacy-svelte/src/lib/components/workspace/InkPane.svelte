<script lang="ts">
  import { onMount } from 'svelte';
  import type { WorkspaceNode } from '@/lib/workspace/types';
  import { paintStrokes, readLegacyStroke, readStrokes } from '@/lib/workspace/ink';

  export let node:WorkspaceNode;

  let canvas:HTMLCanvasElement;
  $: strokes=(()=>{
    const current=readStrokes(node.payload.strokes);
    if(current.length)return current;
    const legacy=readLegacyStroke(node.payload);
    return legacy?[legacy]:[];
  })();

  /**
   * Ink is drawn to a canvas rather than to SVG paths. A sketch is easily
   * thousands of points, and one <path> element per stroke in the world layer
   * would put that straight into the DOM alongside every other node.
   */
  function paint(){
    if(!canvas)return;
    const context=canvas.getContext('2d');
    if(!context)return;
    // Back the canvas at device resolution so strokes are not soft on a retina
    // display, then draw in CSS pixels.
    const ratio=typeof devicePixelRatio==='number'?devicePixelRatio:1;
    const width=Math.max(1,Math.round(node.w));
    const height=Math.max(1,Math.round(node.h));
    if(canvas.width!==width*ratio||canvas.height!==height*ratio){
      canvas.width=width*ratio;
      canvas.height=height*ratio;
    }
    context.setTransform(ratio,0,0,ratio,0,0);
    context.clearRect(0,0,width,height);
    paintStrokes(context,strokes);
  }

  // Repaint whenever the strokes or the node size change.
  $: canvas,strokes,node.w,node.h,paint();
  onMount(paint);
</script>

<canvas
  bind:this={canvas}
  class="h-full w-full"
  style={`width:${node.w}px;height:${node.h}px`}
  aria-label={String(node.payload.title||'Ink drawing')}
></canvas>
