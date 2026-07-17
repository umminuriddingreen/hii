<script lang="ts">
  import { onMount } from 'svelte';
  export let sessionId = crypto.randomUUID();
  export let cwd = '';
  let host: HTMLDivElement;

  onMount(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let terminal: import('@xterm/xterm').Terminal | null = null;
    let observer: ResizeObserver | null = null;
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links')]).then(([xterm, fitModule, links]) => {
      if (disposed) return;
      terminal = new xterm.Terminal({ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, cursorBlink:true, scrollback:5000, theme:{background:'#fff',foreground:'#171717',cursor:'#176bff',selectionBackground:'rgba(23,107,255,.18)'} });
      const fit = new fitModule.FitAddon(); terminal.loadAddon(fit); terminal.loadAddon(new links.WebLinksAddon()); terminal.open(host); fit.fit();
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'; socket = new WebSocket(`${protocol}://${location.host}/api/pty`);
      const send = (payload:Record<string,unknown>) => socket?.readyState===WebSocket.OPEN && socket.send(JSON.stringify({...payload,sessionId}));
      socket.onopen=()=>send({t:'attach',cols:terminal?.cols,rows:terminal?.rows});
      socket.onmessage=(event)=>{ try { const msg=JSON.parse(event.data); if(msg.sessionId!==sessionId)return; if(msg.t==='data'||msg.t==='scrollback')terminal?.write(msg.data||''); if(msg.t==='error'&&msg.message==='unknown session')send({t:'create',cwd,cols:terminal?.cols,rows:terminal?.rows}); if(msg.t==='exit')terminal?.write(`\r\n\x1b[90m[session exited (${msg.exitCode??'?'})]\x1b[0m\r\n`); } catch {} };
      terminal.onData((data)=>send({t:'input',data}));
      observer=new ResizeObserver(()=>{ fit.fit(); send({t:'resize',cols:terminal?.cols,rows:terminal?.rows}); }); observer.observe(host);
    });
    return () => { disposed=true; observer?.disconnect(); socket?.close(); terminal?.dispose(); };
  });
</script>

<div bind:this={host} class="xterm-host h-full w-full bg-white pl-2 pt-1"></div>
