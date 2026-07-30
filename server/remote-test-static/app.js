const base = new URL('.', location.href).pathname.replace(/\/$/, '');
const gate = document.querySelector('#gate');
const passcode = document.querySelector('#passcode');
const session = document.querySelector('#session');
const terminalPane = document.querySelector('#terminal');
const artifact = document.querySelector('#artifact');
let bearer = sessionStorage.getItem('hii-remote-bearer');
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
    terminal = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: { background: '#050505', foreground: '#eeeeee' }
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
  gate.hidden = true;
  session.hidden = false;
  ensureTerminal();
  fitTerminal();
  terminal.focus();
  connect();
  refreshArtifact();
}

async function authenticate(value) {
  const response = await fetch(`${base}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: value })
  });
  if (!response.ok) {
    passcode.value = '';
    passcode.focus();
    return;
  }
  bearer = (await response.json()).token;
  sessionStorage.setItem('hii-remote-bearer', bearer);
  showSession();
}

gate.addEventListener('submit', (event) => {
  event.preventDefault();
  authenticate(passcode.value);
});

passcode.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  authenticate(passcode.value);
});

function connect() {
  if (!bearer || socket?.readyState === WebSocket.OPEN) return;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}${base}/ws`, [`hii-token.${bearer}`]);
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
  const columns = Math.max(20, Math.floor(terminalPane.clientWidth / 8.4));
  const rows = Math.max(5, Math.floor(terminalPane.clientHeight / 18.9));
  terminal.resize(columns, rows);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', columns, rows }));
  }
}

window.addEventListener('resize', fitTerminal);

async function refreshArtifact() {
  if (!bearer) return;
  const response = await fetch(`${base}/latest-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` }
  });
  if (response.status === 401) {
    sessionStorage.removeItem('hii-remote-bearer');
    bearer = null;
    location.reload();
    return;
  }
  if (response.status === 204) return;
  if (!response.ok) return;
  const latest = await response.json();
  if (latest.id !== latestArtifactId) {
    latestArtifactId = latest.id;
    artifact.src = latest.url;
  }
}

if (bearer) showSession();
