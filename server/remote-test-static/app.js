const base = new URL('.', location.href).pathname.replace(/\/$/, '');
const session = document.querySelector('#session');
const terminalPane = document.querySelector('#terminal');
const artifact = document.querySelector('#artifact');
let socket;
let latestArtifactId;
let terminal;

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
  if (socket?.readyState === WebSocket.OPEN) return;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}${base}/ws`);
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'data') {
      terminal.write(message.data);
    }
    if (message.type === 'artifact') refreshArtifact();
  });
  socket.addEventListener('close', () => setTimeout(connect, 1000));
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

async function refreshArtifact() {
  const response = await fetch(`${base}/latest-ticket`, { method: 'POST' });
  if (response.status === 204) return;
  if (!response.ok) return;
  const latest = await response.json();
  if (latest.id !== latestArtifactId) {
    latestArtifactId = latest.id;
    if (typeof latest.background === 'string') {
      artifact.style.background = latest.background;
    }
    artifact.src = latest.url;
  }
}

showSession();
