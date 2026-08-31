// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { decryptChatMessage, encryptChatMessage, ensureLocalChatDevice, type ChatDevice, type ChatEnvelope, type LocalChatDevice } from '@/lib/web/chat-crypto';
import { feedSnapshotFromNode, type FeedItem, type FeedSnapshot } from '@/lib/web/feed-contract';
import styles from './HiiWebAccess.module.css';
import { RemoteDesktop } from '@/components/remote/RemoteDesktop';
import { LocalHiiChat } from '@/components/remote/LocalHiiChat';

export type WebPanel = 'chat' | 'feed' | 'models' | 'say-hi';

type Conversation = {
  id: string;
  state: 'active' | 'invited';
  otherHandle: string;
  otherState: 'active' | 'invited';
};

type TimelineMessage = { id: string; senderAccountId: string; text: string; createdAt: number; expiresAt: number };
const MAX_LIVE_CHAT_PAGES = 21;

async function request<T>(path: string, csrfToken: string, body?: unknown, method?: 'POST' | 'DELETE'): Promise<T> {
  const response = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body === undefined ? {} : { 'X-HII-CSRF': csrfToken }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request_failed');
  return payload;
}

function Snapshot({ snapshot }: { snapshot: FeedSnapshot }) {
  if (snapshot.kind === 'text') return <p className={styles.feedText}>{snapshot.text}</p>;
  if (snapshot.kind === 'sticker') return <p className={styles.feedSticker}>{snapshot.emoji}</p>;
  return <p className={styles.feedText}>drawing · {snapshot.strokes.reduce((count, stroke) => count + stroke.points.length / 2, 0)} points</p>;
}

function FeedPanel({ csrfToken, shareNode, onImport }: { csrfToken: string; shareNode: WorkspaceNode | null; onImport: (item: FeedItem) => void }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [message, setMessage] = useState('');
  const snapshot = shareNode ? feedSnapshotFromNode(shareNode) : null;
  const load = useCallback(async () => {
    try {
      const page = await request<{ items: Array<{ id: string; author: { handle: string }; snapshot: FeedSnapshot; provenance: FeedItem['provenance']; publishedAt: number; mine: boolean }> }>('/api/feed?limit=30', csrfToken);
      setItems(page.items.map((item) => ({ id: item.id, authorHandle: item.author.handle, snapshot: item.snapshot, provenance: item.provenance, createdAt: item.publishedAt, ownedByViewer: item.mine })));
    } catch { setMessage('could not load the feed.'); }
  }, [csrfToken]);
  useEffect(() => { void load(); }, [load]);
  const publish = async () => {
    if (!shareNode || !snapshot) return;
    setMessage('');
    try {
      const publishedSnapshot = snapshot.kind === 'ink'
        ? { kind: 'ink' as const, strokes: snapshot.strokes.map((stroke) => ({ points: stroke.points })) }
        : snapshot;
      await request('/api/feed/items', csrfToken, { clientRequestId: crypto.randomUUID(), sourceNodeId: shareNode.id, sourceUpdatedAt: shareNode.updatedAt, snapshot: publishedSnapshot });
      setMessage('shared.');
      await load();
    } catch { setMessage('could not share this item.'); }
  };
  const act = async (item: FeedItem, action: 'revoke' | 'report') => {
    try {
      await request(`/api/feed/items/${item.id}/${action}`, csrfToken, action === 'report' ? { reason: 'other' } : {});
      await load();
    } catch { setMessage(`could not ${action}.`); }
  };
  return <>
    {shareNode ? <section className={styles.sharePreview} aria-label="Share preview">
      <small>public preview</small>
      {snapshot ? <Snapshot snapshot={snapshot} /> : <p>this item cannot be shared.</p>}
      <button type="button" disabled={!snapshot} onClick={() => void publish()}>share to feed</button>
      <small>only this preview is published. canvas context stays private.</small>
    </section> : null}
    <div className={styles.list}>
      {items.map((item) => <article key={item.id}>
        <small>{item.authorHandle} · {new Date(item.createdAt).toLocaleString()}</small>
        <Snapshot snapshot={item.snapshot} />
        <div><button type="button" onClick={() => onImport(item)}>add to canvas</button>{item.ownedByViewer ? <button type="button" onClick={() => void act(item, 'revoke')}>revoke</button> : <button type="button" onClick={() => void act(item, 'report')}>report</button>}</div>
      </article>)}
    </div>
    <p role="status">{message}</p>
  </>;
}

function ChatPanel({ accountId, csrfToken }: { accountId: string; csrfToken: string }) {
  const [device, setDevice] = useState<LocalChatDevice | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [recipient, setRecipient] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('opening encrypted chat…');

  const loadConversations = useCallback(async () => {
    const page = await request<{ conversations: Conversation[] }>('/api/chat/conversations', csrfToken);
    setConversations(page.conversations);
    if (!active) setActive(page.conversations.find((entry) => entry.state === 'active' && entry.otherState === 'active')?.id ?? null);
  }, [active, csrfToken]);

  useEffect(() => {
    void ensureLocalChatDevice(accountId, (keys) => request('/api/chat/devices', csrfToken, keys))
      .then((value) => { setDevice(value); setStatus('messages disappear from HII web after 24 hours.'); return loadConversations(); })
      .catch((error: Error) => setStatus(error.message === 'passkey_step_up_required' ? 'log out and use your passkey again to add this browser.' : 'could not open encrypted chat.'));
  }, [accountId, csrfToken, loadConversations]);

  useEffect(() => { setMessages([]); }, [active]);
  useEffect(() => {
    const timer = window.setInterval(() => setMessages((current) => current.filter((message) => message.expiresAt > Date.now())), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const readTimeline = useCallback(async () => {
    if (!active || !device) return;
    try {
      const { devices } = await request<{ devices: ChatDevice[] }>(`/api/chat/conversations/${active}/devices`, csrfToken);
      const next: TimelineMessage[] = [];
      let after = 0;
      // Two members can each contribute at most 500 messages in each of the
      // two UTC buckets that overlap a 24-hour lifetime: at most 2,000 live
      // rows. One extra page proves exhaustion without leaving a cursor pinned.
      for (let pageIndex = 0; pageIndex < MAX_LIVE_CHAT_PAGES; pageIndex += 1) {
        const page = await request<{ messages: Array<{ seq: number; id: string; senderAccountId: string; senderDeviceId: string; envelope: ChatEnvelope; createdAt: number; expiresAt: number }>; nextAfter: number; hasMore: boolean }>(`/api/chat/conversations/${active}/messages?after=${after}&limit=100`, csrfToken);
        for (const message of page.messages) {
          const sender = devices.find((entry) => entry.id === message.senderDeviceId);
          if (!sender || message.expiresAt <= Date.now()) continue;
          try { next.push({ ...message, text: await decryptChatMessage(message.envelope, device, sender) }); } catch { /* advance beyond unauthenticated rows without rendering them */ }
        }
        if (!page.hasMore || page.nextAfter <= after) break;
        after = page.nextAfter;
      }
      setMessages(next);
    } catch { setStatus('could not refresh this chat.'); }
  }, [active, csrfToken, device]);
  useEffect(() => {
    void readTimeline();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void readTimeline(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [readTimeline]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try { await request('/api/chat/conversations', csrfToken, { recipientHandle: recipient }); setRecipient(''); await loadConversations(); } catch { setStatus('could not start that chat.'); }
  };
  const accept = async (id: string) => { await request(`/api/chat/conversations/${id}/accept`, csrfToken, {}); await loadConversations(); setActive(id); };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!active || !device || !draft.trim()) return;
    try {
      const { devices } = await request<{ devices: ChatDevice[] }>(`/api/chat/conversations/${active}/devices`, csrfToken);
      const envelope = await encryptChatMessage(draft.trim(), active, device, devices.filter((entry) => entry.active));
      await request(`/api/chat/conversations/${active}/messages`, csrfToken, { id: envelope.messageId, senderDeviceId: device.deviceId, envelope });
      setDraft('');
      await readTimeline();
    } catch { setStatus('could not send.'); }
  };

  return <>
    <form className={styles.inlineForm} onSubmit={create}><input aria-label="Name to chat with" placeholder="name" value={recipient} onChange={(event) => setRecipient(event.target.value)} pattern="[-A-Za-z0-9._]+" minLength={3} maxLength={48} required /><button>start chat</button></form>
    <nav className={styles.chatList} aria-label="Chats">{conversations.map((conversation) => <button key={conversation.id} type="button" onClick={() => conversation.state === 'invited' ? void accept(conversation.id) : setActive(conversation.id)} aria-current={active === conversation.id}>{conversation.otherHandle}{conversation.state === 'invited' ? ' · accept' : conversation.otherState === 'invited' ? ' · invited' : ''}</button>)}</nav>
    <div className={styles.messages}>{messages.map((message) => <p key={message.id} data-mine={message.senderAccountId === accountId}><small>{message.senderAccountId === accountId ? 'you' : 'them'} · {new Date(message.createdAt).toLocaleTimeString()}</small>{message.text}</p>)}</div>
    {active ? <form className={styles.inlineForm} onSubmit={send}><input aria-label="Message" placeholder="message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={8_000} required /><button>send</button></form> : null}
    <p role="status">{status}</p>
  </>;
}

export function HiiWebPanel({ panel, accountId, csrfToken, shareNode, onClose, onImport, onPanel }: { panel: WebPanel; accountId: string; csrfToken: string; shareNode: WorkspaceNode | null; onClose: () => void; onImport: (item: FeedItem) => void; onPanel: (panel: WebPanel) => void }) {
  return <aside className={styles.webPanel} aria-label={`HII ${panel}`} data-workspace-ui>
    <header><span>{panel === 'say-hi' ? 'say hi' : panel}</span><button type="button" onClick={onClose}>close</button></header>
    {panel === 'feed' ? <FeedPanel csrfToken={csrfToken} shareNode={shareNode} onImport={onImport} /> : null}
    {panel === 'chat' ? <ChatPanel accountId={accountId} csrfToken={csrfToken} /> : null}
    {panel === 'say-hi' ? <LocalHiiChat onOpenDevices={() => onPanel('models')} /> : null}
    {panel === 'models' ? <>
      <section className={styles.modelState}>
        <p>Devices &amp; local intelligence</p>
        <small>browser-canonical HII · authenticated outbound local link</small>
        <p>Pair this Mac once, then select the Codex application window and use HII typer from any signed-in browser.</p>
        <small>The browser never receives a raw local port or unrestricted shell. Each paired host is revocable.</small>
      </section>
      <RemoteDesktop embedded preferredBundleIdentifier="com.openai.codex" />
    </> : null}
  </aside>;
}
