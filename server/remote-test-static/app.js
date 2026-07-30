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
let savedSourceArtifactId;
let savedUrl;
let terminal;
let reconnectTimer;
let activityTail = '';

function setSignal(state = 'idle') {
  session.dataset.signal = state;
}

function trackActivity(data) {
  activityTail = `${activityTail}${data}`
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .slice(-1600);
  const markers = [
    ['model', /\bMODEL\b/g],
    ['tool', /\b(?:BUILDING|CHECKING|RESEARCHING)\b/g],
    ['verify', /\bVERIFYING\b/g],
    ['proof', /\bDONE\b/g],
    ['error', /(?:! LOCAL PROBLEM|! INTERRUPTED|REPAIR STALLED|\bfailed\b)/g]
  ];
  let latest = { state: 'idle', index: -1 };
  for (const [state, pattern] of markers) {
    for (const match of activityTail.matchAll(pattern)) {
      if (match.index > latest.index) latest = { state, index: match.index };
    }
  }
  if (latest.index >= 0) setSignal(latest.state);
}

function setConnection(message = '') {
  connection.textContent = message;
  connection.hidden = !message;
  if (message) setSignal('reconnect');
}

function setPreviewStatus(state, message) {
  previewStatus.dataset.state = state;
  previewStatus.textContent = message;
  if (state === 'updating') setSignal('verify');
  if (state === 'ready') setSignal('proof');
  if (state === 'failed') setSignal('error');
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
        background: '#07080d',
        foreground: '#f3efe5',
        cursor: '#45d6e8',
        cursorAccent: '#07080d',
        selectionBackground: '#173d47',
        black: '#77808f',
        brightBlack: '#a6afbd',
        blue: '#6ab9e8',
        brightBlue: '#a9dcf5',
        cyan: '#45d6e8',
        brightCyan: '#9ceaf2',
        green: '#69d391',
        brightGreen: '#a8e7ba',
        yellow: '#d99a52',
        brightYellow: '#efc27f',
        red: '#f07178',
        brightRed: '#f6a1a6',
        magenta: '#a99adf',
        brightMagenta: '#cfc5ef',
        white: '#f3efe5',
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
  setSignal('idle');
  ensureTerminal();
  fitTerminal();
  terminal.focus();
  connect();
  refreshArtifact();
  refreshSaved();
}

function connect() {
  if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(socket?.readyState)) return;
  setConnection('Reconnecting to HII…');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}${base}/ws`);
  socket.addEventListener('open', () => {
    clearTimeout(reconnectTimer);
    setConnection();
    setSignal('idle');
    fitTerminal();
    void refreshArtifact();
    void refreshSaved();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'data') {
      trackActivity(message.data);
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
  if (response.status === 204) {
    latestArtifactId = undefined;
    artifact.src = 'about:blank';
    preview.style.background = '';
    artifact.style.background = '';
    setPreviewStatus('empty', 'Ready for your idea');
    updateSaveButton();
    return;
  }
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

function updateSaveButton() {
  const button = previewControls.querySelector('[data-action="save"]');
  const canOpen = savedUrl && savedSourceArtifactId === latestArtifactId;
  button.textContent = canOpen ? 'Open' : 'Save';
  button.title = canOpen ? 'Open saved preview' : 'Save verified preview';
  button.setAttribute('aria-label', button.title);
}

async function refreshSaved() {
  const response = await fetch(`${base}/latest-save`, { method: 'POST' });
  if (response.status === 204 || !response.ok) return updateSaveButton();
  const saved = await response.json();
  savedSourceArtifactId = saved.sourceArtifactId;
  savedUrl = saved.url;
  updateSaveButton();
}

async function saveOrOpen() {
  if (savedUrl && savedSourceArtifactId === latestArtifactId) {
    window.open(savedUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  setPreviewStatus('updating', 'Saving verified preview…');
  const response = await fetch(`${base}/save-latest`, { method: 'POST' });
  if (!response.ok) {
    setPreviewStatus('failed', 'Could not save preview');
    return;
  }
  await refreshSaved();
  setPreviewStatus('ready', '✓ Preview saved');
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
  if (action === 'save') await saveOrOpen();
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
