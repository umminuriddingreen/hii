'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, CaretDown as ChevronDown, Cpu, ChatCircle as MessageSquare, SidebarSimple as PanelLeftClose, SidebarSimple as PanelLeftOpen, Plus, SlidersHorizontal as Settings2, Stop as Square } from '@phosphor-icons/react';
import { chatApi as api } from '@/lib/desktop/chat';
import styles from './LocalChat.module.css';
import { RuntimePanel } from './RuntimePanel';
import type { Conversation, Generation, Message, RuntimeStatus, Settings, Snapshot } from '@/lib/desktop/chat-types';

const MessageView = memo(function MessageView({ message, generation }: { message: Message; generation?: Generation }) {
  return <article className={`message ${message.role}`} data-message-id={message.id} data-role={message.role} data-status={generation?.status}>
    <div className="message-label">{message.role === 'user' ? 'You' : 'Local model'}</div>
    <div className="message-body">{message.parts.map((part, i) => part.type === 'reasoning'
      ? <details key={i} className="reasoning"><summary>Reasoning</summary><div>{part.text}</div></details>
      : <div key={i} className="text-part">{part.text}</div>)}
      {generation?.status === 'streaming' && <span className="stream-cursor" aria-label="Generating" />}
    </div>
    {generation && <div className={`generation-status ${generation.status}`}>
      {generation.status === 'completed' ? <><Check size={12} />Saved{generation.finish_reason === 'length' ? ' / Output limit reached' : ''}</> : generation.status === 'streaming' ? 'Generating' : generation.status}
      {generation.error && <span>{generation.error}</span>}
    </div>}
  </article>;
});

export function LocalChatSurface() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [showRuntime, setShowRuntime] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const selectionVersion = useRef(0);
  const composer = useRef<HTMLTextAreaElement>(null);

  const accept = useCallback((snapshot: Snapshot) => {
    setSnapshots(previous => {
      const existing = previous[snapshot.conversation.id];
      if (existing && existing.conversation.revision >= snapshot.conversation.revision) return previous;
      return { ...previous, [snapshot.conversation.id]: snapshot };
    });
    setConversations(previous => {
      const existing = previous.find(c => c.id === snapshot.conversation.id);
      if (existing && existing.revision > snapshot.conversation.revision) return previous;
      return [snapshot.conversation, ...previous.filter(c => c.id !== snapshot.conversation.id)].sort((a, b) => b.updated_at - a.updated_at);
    });
  }, []);
  const refreshRuntime = useCallback(async () => { setRuntime(await api.runtime()); }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await api.subscribe(s => { if (!disposed) accept(s); }, error => { if (!disposed) setError(error); });
      if (disposed) { unlisten(); return; }
      const [list, config] = await Promise.all([api.list(), api.settings()]);
      if (disposed) return;
      setConversations(list); setSettings(config);
      if (list[0]) { const snapshot = await api.get(list[0].id); if (!disposed) { accept(snapshot); setSelected(list[0].id); } }
      if (!disposed) { setReady(true); void refreshRuntime().catch(e => setError(String(e))); }
    })().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; unlisten?.(); };
  }, [accept, refreshRuntime]);

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try { const status = await api.runtime(); if (!stopped) setRuntime(status); } catch { /* IPC error is surfaced by commands. */ }
      if (!stopped) timer = setTimeout(tick, 3000);
    }
    timer = setTimeout(tick, 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [ready]);

  const current = selected ? snapshots[selected] : undefined;
  const active = current?.generations.find(g => g.status === 'streaming');
  useEffect(() => { if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [current]);

  async function choose(id: string) {
    const version = ++selectionVersion.current;
    setNavigating(true);
    setSelected(id); setDraft(''); setError(''); follow.current = true;
    try { accept(await api.get(id)); } catch (e) { setError(String(e)); }
    finally { if (version === selectionVersion.current) setNavigating(false); }
  }
  async function create() {
    const version = ++selectionVersion.current;
    setError(''); setDraft(''); setNavigating(true);
    try { const snapshot = await api.create(); accept(snapshot); if (version === selectionVersion.current) { setSelected(snapshot.conversation.id); follow.current = true; } } catch (e) { setError(String(e)); }
    finally { if (version === selectionVersion.current) setNavigating(false); }
  }
  async function send() {
    if (!draft.trim() || sending || navigating || active || !ready) return;
    setSending(true); setError('');
    const text = draft;
    try {
      let snapshot = current;
      if (!snapshot) { snapshot = await api.create(); accept(snapshot); setSelected(snapshot.conversation.id); }
      await api.send(snapshot.conversation.id, snapshot.conversation.active_leaf_id, text);
      setDraft(''); follow.current = true;
      accept(await api.get(snapshot.conversation.id));
    } catch (e) { setError(String(e)); } finally { setSending(false); composer.current?.focus(); }
  }
  async function stop() { if (active) try { await api.stop(active.id); } catch (e) { setError(String(e)); } }

  return <div className={`${styles.root} app ${sidebar ? '' : 'sidebar-hidden'}`}>
    <aside className="sidebar">
      <div className="brand"><MessageSquare size={23} /><strong>HII Chat</strong><button className="icon" title="Hide sidebar" aria-label="Hide sidebar" onClick={() => setSidebar(false)}><PanelLeftClose size={18} /></button></div>
      <button className="new-chat" onClick={() => void create()} disabled={!ready || sending || navigating}><Plus size={18} />New conversation</button>
      <div className="sidebar-label">Conversations</div>
      <nav aria-label="Conversations">{conversations.map(c => <button key={c.id} disabled={sending} aria-label={`Open conversation: ${c.title}`} className={selected === c.id ? 'conversation-link selected' : 'conversation-link'} aria-current={selected === c.id ? 'page' : undefined} title={c.title} onClick={() => void choose(c.id)}><MessageSquare size={15} /><span>{c.title}</span></button>)}</nav>
      <button className="runtime-button" onClick={() => setShowRuntime(true)} disabled={!settings}><Cpu size={18} /><span>Local runtime<small>{runtime?.state ?? 'Checking'}</small></span><Settings2 size={16} /></button>
    </aside>
    <main>
      <header className="topbar"><div>{!sidebar && <button className="icon" title="Show sidebar" aria-label="Show sidebar" onClick={() => setSidebar(true)}><PanelLeftOpen size={19} /></button>}<span>{current?.conversation.title ?? 'New conversation'}</span></div>
        <button className="model-button" onClick={() => setShowRuntime(true)} disabled={!settings}><span className={`status-dot ${runtime?.state === 'ready' ? 'online' : ''}`} /><span>{settings?.model || 'Choose local model'}</span><ChevronDown size={15} /></button>
      </header>
      <div ref={scroller} className="conversation-scroll" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>
        <div className="transcript" aria-label="Conversation">
          {!current?.messages.length && <div className="empty"><MessageSquare size={38} strokeWidth={1.4} /><h1>What are you thinking about?</h1></div>}
          {current?.branch.map(id => { const message = current.messages.find(m => m.id === id); return message && <MessageView key={id} message={message} generation={current.generations.find(g => g.message_id === id)} />; })}
        </div>
      </div>
      <div className="composer-area">
        {error && <div role="alert" className="error">{error}</div>}
        <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          <textarea ref={composer} aria-label="Message" placeholder="Message your local model" value={draft} disabled={!ready || sending || navigating} onChange={e => setDraft(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            if (e.key === 'Escape') void stop();
          }} rows={3} />
          <div className="composer-bottom"><span><span className="status-dot online" />Local only</span>{active
            ? <button type="button" className="send" aria-label="Stop generation" title="Stop generation" onClick={() => void stop()}><Square size={16} fill="currentColor" /></button>
            : <button type="submit" className="send" aria-label="Send message" title="Send message" disabled={!ready || sending || !draft.trim() || !settings?.model}><ArrowUp size={21} /></button>}</div>
        </form>
        <div className="save-note" role="status">{active ? 'Generating locally' : current?.messages.length ? 'Saved on this device' : 'HII Chat'}</div>
      </div>
    </main>
    {showRuntime && settings && <RuntimePanel settings={settings} status={runtime} close={() => setShowRuntime(false)} saved={setSettings} refresh={refreshRuntime} />}
  </div>;
}
