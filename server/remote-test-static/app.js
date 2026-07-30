const base = new URL('.', location.href).pathname.replace(/\/$/, '');
const session = document.querySelector('#session');
const terminalPane = document.querySelector('#terminal');
const preview = document.querySelector('#preview');
const artifact = document.querySelector('#artifact');
const connection = document.querySelector('#connection');
const previewStatus = document.querySelector('#preview-status');
const previewControls = document.querySelector('#preview-controls');
let socket;
let latestArtifactId;
let terminal;
let reconnectTimer;

function setConnection(message = '') {
  connection.textContent = message;
  connection.hidden = !message;
}

function setPreviewStatus(state, message) {
  previewStatus.dataset.state = state;
  previewStatus.textContent = message;
}

function sendInput(data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', data }));
  }
}

function ensureTerminal() {
  if (terminal) return;
  if (typeof window.Terminal === 'function') {
    const compact = window.matchMedia('(max-width: 480px)').matches;
    terminal = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',
      fontSize: compact ? 13 : 14,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0.15,
      lineHeight: 1.18,
      scrollback: 5000,
      theme: {
        background: '#0b0d10',
        foreground: '#f3f4f1',
        cursor: '#67e8f9',
        cursorAccent: '#0b0d10',
        selectionBackground: '#21404a',
        black: '#88919d',
        brightBlack: '#a7b0bc',
        blue: '#7dd3fc',
        brightBlue: '#bae6fd',
        cyan: '#67e8f9',
        brightCyan: '#a5f3fc',
        green: '#86efac',
        brightGreen: '#bbf7d0',
        yellow: '#fde68a',
        brightYellow: '#fef3c7',
        red: '#fda4af',
        brightRed: '#fecdd3',
        magenta: '#c4b5fd',
        brightMagenta: '#ddd6fe',
        white: '#f3f4f1',
        brightWhite: '#ffffff'
      }
    });
    terminal.open(terminalPane);
    terminal.onData(sendInput);
    return;
  }
  terminalPane.classList.add('fallback');
  terminalPane.tabIndex = 0;
  terminalPane.addEventListener('keydown', (event) => {
    if (event.key.length === 1) sendInput(event.key);
    else if (event.key === 'Enter') sendInput('\r');
    else if (event.key === 'Backspace') sendInput('\u007f');
  });
  terminal = {
    focus: () => terminalPane.focus(),
    resize: () => {},
    write: (data) => {
      terminalPane.textContent += data;
      terminalPane.scrollTop = terminalPane.scrollHeight;
    }
  };
}

function showSession() {
  session.hidden = false;
  ensureTerminal();
  fitTerminal();
  terminal.focus();
  connect();
  refreshArtifact();
}

function connect() {
  if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(socket?.readyState)) return;
  setConnection('Reconnecting to HII…');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}${base}/ws`);
  socket.addEventListener('open', () => {
    clearTimeout(reconnectTimer);
    setConnection();
    fitTerminal();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'data') {
      terminal.write(message.data);
    }
    if (message.type === 'artifact') refreshArtifact();
    if (message.type === 'artifact-status') {
      if (message.status === 'updating') setPreviewStatus('updating', 'Updating…');
      if (message.status === 'ready') setPreviewStatus('ready', '✓ Preview verified');
      if (message.status === 'failed') {
        setPreviewStatus('failed', 'Browser check failed · Previous preview is still live');
      }
    }
    if (message.type === 'input-locked') {
      setConnection(message.message);
      setTimeout(() => {
        if (socket?.readyState === WebSocket.OPEN) setConnection();
      }, 1800);
    }
  });
  socket.addEventListener('close', () => {
    setConnection('Reconnecting to HII…');
    reconnectTimer = setTimeout(connect, 1000);
  });
}

function fitTerminal() {
  if (!terminal) return;
  const fontSize = window.matchMedia('(max-width: 480px)').matches ? 13 : 14;
  if (terminal.options) terminal.options.fontSize = fontSize;
  const columns = Math.max(20, Math.floor(terminalPane.clientWidth / (fontSize * 0.61)));
  const rows = Math.max(5, Math.floor(terminalPane.clientHeight / (fontSize * 1.3)));
  terminal.resize(columns, rows);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', columns, rows }));
  }
}

window.addEventListener('resize', fitTerminal);

async function refreshArtifact(force = false) {
  const response = await fetch(`${base}/latest-ticket`, { method: 'POST' });
  if (response.status === 204) return;
  if (!response.ok) return;
  const latest = await response.json();
  if (force || latest.id !== latestArtifactId) {
    latestArtifactId = latest.id;
    if (typeof latest.background === 'string') {
      preview.style.background = latest.background;
      artifact.style.background = latest.background;
    }
    artifact.src = latest.url;
  }
  setPreviewStatus('ready', '✓ Preview verified');
}

previewControls.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'refresh') artifact.src = artifact.src;
  if (action === 'fullscreen') await preview.requestFullscreen?.();
  if (action === 'device') {
    preview.classList.toggle('mobile');
    const mobile = preview.classList.contains('mobile');
    button.textContent = mobile ? '▰' : '▯';
    button.title = mobile ? 'Desktop size' : 'Mobile size';
    button.setAttribute('aria-label', mobile ? 'Use desktop preview' : 'Use mobile preview');
  }
  if (action === 'latest') await refreshArtifact(true);
});

function fitVisualViewport() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  const keyboardOpen = height < window.screen.height * 0.62;
  document.documentElement.classList.toggle('keyboard-open', keyboardOpen);
  fitTerminal();
}

window.visualViewport?.addEventListener('resize', fitVisualViewport);
window.visualViewport?.addEventListener('scroll', fitVisualViewport);
fitVisualViewport();
showSession();
