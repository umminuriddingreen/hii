<script lang="ts">
  import { onMount } from 'svelte';
  export let sessionId = crypto.randomUUID();
  export let cwd = '';
  export let program: '' | 'hii' = '';
  export let ariaLabel = 'Interactive terminal';
  export let onStatus: ((status: 'connecting' | 'ready' | 'exited' | 'error', detail?: string) => void) | undefined = undefined;
  let host: HTMLDivElement;

  onMount(() => {
    let disposed = false;
    let sessionReady = false;
    let socket: WebSocket | null = null;
    let terminal: import('@xterm/xterm').Terminal | null = null;
    let observer: ResizeObserver | null = null;
    const pendingCommands: string[] = [];
    const send = (payload:Record<string,unknown>) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({...payload,sessionId}));
      return true;
    };
    const runCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; command?: string }>).detail;
      const command = detail?.command?.trim();
      if (!command || detail.sessionId !== sessionId) return;
      const input = `${command}\r`;
      if (!sessionReady || !send({t:'input',data:input})) pendingCommands.push(input);
    };
    const flushCommands = () => {
      if (!sessionReady) return;
      for (const input of pendingCommands.splice(0)) send({t:'input',data:input});
    };
    window.addEventListener('hii:terminal-command', runCommand);
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links')]).then(([xterm, fitModule, links]) => {
      if (disposed) return;
      terminal = new xterm.Terminal({ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, cursorBlink:true, scrollback:5000, theme:{background:'#fff',foreground:'#171717',cursor:'#176bff',selectionBackground:'rgba(23,107,255,.18)'} });
      const fit = new fitModule.FitAddon(); terminal.loadAddon(fit); terminal.loadAddon(new links.WebLinksAddon()); terminal.open(host); fit.fit();
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'; socket = new WebSocket(`${protocol}://${location.host}/api/pty`);
      socket.onopen=()=>{
        onStatus?.('connecting');
        send({t:'attach',cols:terminal?.cols,rows:terminal?.rows});
      };
      socket.onmessage=(event)=>{ try { const msg=JSON.parse(event.data); if(msg.sessionId!==sessionId)return; if(msg.t==='data'||msg.t==='scrollback')terminal?.write(msg.data||''); if(msg.t==='created'||msg.t==='attached'){sessionReady=true;onStatus?.('ready');flushCommands();} if(msg.t==='error'&&msg.message==='unknown session')send({t:'create',cwd,program:program||undefined,cols:terminal?.cols,rows:terminal?.rows}); else if(msg.t==='error')onStatus?.('error',msg.message||'PTY error'); if(msg.t==='exit'){sessionReady=false;terminal?.write(`\r\n\x1b[90m[session exited (${msg.exitCode??'?'})]\x1b[0m\r\n`);onStatus?.('exited',String(msg.exitCode??'?'));} } catch {} };
      terminal.onData((data)=>send({t:'input',data}));
      observer=new ResizeObserver(()=>{ fit.fit(); send({t:'resize',cols:terminal?.cols,rows:terminal?.rows}); }); observer.observe(host);
    });
    return () => { disposed=true; window.removeEventListener('hii:terminal-command', runCommand); observer?.disconnect(); socket?.close(); terminal?.dispose(); };
  });
</script>

<div bind:this={host} class="xterm-host h-full w-full bg-white pl-2 pt-1" role="application" aria-label={ariaLabel}></div>
