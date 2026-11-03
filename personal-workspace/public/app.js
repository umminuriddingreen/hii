(() => {
  const $ = (selector) => document.querySelector(selector);
  const messages = $('#messages');
  const prompt = $('#prompt');
  const status = $('#status');
  const send = $('#send');
  const stop = $('#stop');
  const storageKey = 'hii-personal-chat-id';
  let chatId;
  let activeTurns = 0;
  let ready = false;
  try {
    chatId = localStorage.getItem(storageKey);
    if (!chatId || !/^[a-zA-Z0-9_-]{1,80}$/.test(chatId)) {
      chatId = crypto.randomUUID();
      localStorage.setItem(storageKey, chatId);
    }
  } catch {
    chatId = crypto.randomUUID();
  }
  const draftKey = `hii-personal-draft-${chatId}`;
  try { prompt.value = localStorage.getItem(draftKey) || ''; } catch { /* Storage can be unavailable in private browser modes. */ }

  function addMessage(role, text) {
    const article = document.createElement('article');
    article.className = `message ${role}`;
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'You' : 'HII';
    const body = document.createElement('div');
    body.textContent = text;
    article.append(label, body);
    messages.append(article);
    window.scrollTo(0, document.body.scrollHeight);
    return body;
  }

  function keepDraft(text) {
    if (prompt.value) return;
    prompt.value = text;
    try { localStorage.setItem(draftKey, text); } catch { /* Storage is optional. */ }
  }

  async function restore() {
    try {
      const response = await fetch(`/api/agent-chat/${encodeURIComponent(chatId)}`);
      if (!response.ok) throw Error(`HII is unavailable (${response.status})`);
      const chat = await response.json();
      for (const message of chat.messages || []) {
        if (['user', 'assistant'].includes(message.role) && typeof message.content === 'string') addMessage(message.role, message.content);
      }
      status.textContent = '';
      prompt.focus();
    } catch (error) {
      status.textContent = `${error.message}. Check that the local HII service is running.`;
    } finally {
      ready = true;
      send.disabled = false;
    }
  }

  async function submit(event) {
    event?.preventDefault();
    if (!ready) { status.textContent = 'Connecting to HII…'; return; }
    const goal = prompt.value.trim();
    if (!goal) return;
    prompt.value = '';
      try { localStorage.removeItem(draftKey); } catch { /* Storage is optional. */ }
    prompt.style.height = 'auto';
    addMessage('user', goal);
    const answer = addMessage('assistant', '');
    status.textContent = 'Sending to HII…';
    activeTurns += 1;
    stop.hidden = false;
    try {
      const response = await fetch('/api/agent-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, goal })
      });
      if (!response.ok) throw Error((await response.text()) || `HII request failed (${response.status})`);
      if (!response.body) throw Error('HII disconnected before sending a response.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let ended = false;
      let failed = false;
      while (!ended) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const events = pending.split(/\r?\n\r?\n/);
        pending = events.pop() || '';
        for (const frame of events) {
          const line = frame.split(/\r?\n/).find((part) => part.startsWith('data: '));
          if (!line) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          if (data.type === 'queued') status.textContent = data.position > 1 ? `Queued (${data.position})…` : 'HII is working…';
          if (data.type === 'diagnostic') status.textContent = data.text;
          if (data.type === 'answer') answer.textContent = data.text;
          if (data.type === 'error') {
            answer.textContent = data.message || 'HII could not complete this message.';
            status.textContent = 'Message stopped or failed.';
            keepDraft(goal);
            failed = true;
          }
          if (data.type === 'complete') { status.textContent = ''; ended = true; }
        }
        if (done) break;
      }
      if (!ended && !failed) {
        if (!answer.textContent) answer.textContent = 'Disconnected before HII completed this reply.';
        status.textContent = 'Disconnected. This turn may be interrupted; it was not retried.';
        keepDraft(goal);
      }
    } catch (error) {
      answer.textContent = error.message || 'Could not reach HII.';
      status.textContent = 'Connection ended. Check the local HII service.';
      keepDraft(goal);
    } finally {
      activeTurns = Math.max(0, activeTurns - 1);
      stop.hidden = activeTurns === 0;
      prompt.focus();
    }
  }

  $('#form').addEventListener('submit', submit);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit(event);
    }
  });
  prompt.addEventListener('input', () => {
    try { localStorage.setItem(draftKey, prompt.value); } catch { /* Storage is optional. */ }
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, window.innerHeight * 0.4)}px`;
  });
  stop.addEventListener('click', async () => {
    status.textContent = 'Stopping…';
    try {
      const response = await fetch(`/api/agent-chat/${encodeURIComponent(chatId)}/stop`, { method: 'POST' });
      if (!response.ok) throw Error(`HII stop request failed (${response.status})`);
      const result = await response.json();
      status.textContent = result.stopped ? 'Stop requested…' : 'No active turn to stop.';
    }
    catch { status.textContent = 'Could not reach HII to stop this turn.'; }
  });
  restore();
})();
