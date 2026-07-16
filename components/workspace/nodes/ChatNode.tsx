'use client';

import { useEffect, useRef, useState } from 'react';
import { storeWorkspaceAsset, type StoredWorkspaceAsset } from '../../../lib/workspace/ingest';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type ChatAttachment = StoredWorkspaceAsset;
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  runId?: string;
  attachments?: ChatAttachment[];
};

type ChatNodeProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((message): message is ChatMessage => {
    if (!message || typeof message !== 'object') return false;
    const item = message as Partial<ChatMessage>;
    return typeof item.id === 'string' && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string';
  }).slice(-80);
}

function attachmentLabel(attachment: ChatAttachment) {
  return attachment.mime.startsWith('image/') ? `image · ${attachment.name}` : attachment.name;
}

function cleanRunOutput(value: string) {
  const output = value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
  const afterUsage = output.match(/tokens used\s*\n[\d,]+\s*\n([\s\S]+)$/i)?.[1]?.trim();
  if (afterUsage) return afterUsage;
  const codexAnswer = output.match(/(?:^|\n)codex\s*\n([\s\S]*?)(?:\ntokens used|$)/i)?.[1]?.trim();
  return codexAnswer || output;
}

export default function ChatNode({ node, onPayload }: ChatNodeProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => normalizeMessages(node.payload.messages));
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const commitMessages = (next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
    onPayload({ messages: next });
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const stored = (await Promise.all(files.map(storeWorkspaceAsset))).filter((asset): asset is StoredWorkspaceAsset => asset !== null);
    setAttachments((current) => [...current, ...stored].slice(-12));
    setUploading(false);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!activeRun) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/daemon/runs/${encodeURIComponent(activeRun)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('run unavailable');
        const run = await response.json() as { status?: string; output?: string };
        if (cancelled) return;
        const status: NonNullable<ChatMessage['status']> = run.status === 'completed' ? 'completed' : run.status === 'failed' || run.status === 'stopped' ? 'failed' : run.status === 'running' ? 'running' : 'queued';
        const next = messagesRef.current.map((message) => message.runId === activeRun
          ? { ...message, status, text: status === 'failed'
            ? 'The managed HII run failed. Open hiid to inspect its logs.'
            : run.output?.trim() && status === 'completed'
              ? cleanRunOutput(run.output)
              : status === 'running' ? 'Working locally…' : status === 'queued' ? 'Queued with HII…' : 'No response was returned.' }
          : message);
        commitMessages(next);
        if (status === 'completed' || status === 'failed') {
          setActiveRun(null);
          return;
        }
      } catch {
        if (!cancelled) {
          const next = messagesRef.current.map((message) => message.runId === activeRun ? { ...message, status: 'failed' as const, text: 'The managed HII run could not be read.' } : message);
          commitMessages(next);
          setActiveRun(null);
        }
        return;
      }
      if (!cancelled) window.setTimeout(poll, 1800);
    };
    poll();
    return () => { cancelled = true; };
  }, [activeRun]);

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || activeRun) return;
    const now = new Date().toISOString();
    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, ts: now, attachments };
    const prompt = [
      'You are responding inside the local HII workspace chat.',
      'Answer clearly and concisely. Do not modify files or take external actions unless the user explicitly asks.',
      attachments.length ? `Local attachments:\n${attachments.map((item) => `- ${item.path} (${item.mime})`).join('\n')}` : '',
      `User message:\n${text || 'Inspect the attached media and describe what is useful.'}`
    ].filter(Boolean).join('\n\n');
    const assistantId = crypto.randomUUID();
    commitMessages([...messagesRef.current, user, { id: assistantId, role: 'assistant', text: 'Queueing with HII…', ts: now, status: 'queued' }]);
    setDraft('');
    setAttachments([]);
    try {
      const status = await fetch('/api/daemon', { cache: 'no-store' }).then((response) => response.json());
      if (!status.alive) {
        await fetch('/api/daemon', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
      }
      const response = await fetch('/api/daemon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'codex.run', prompt })
      });
      const data = await response.json();
      if (!response.ok || !data.result?.runId) throw new Error(data.error || 'Could not queue chat');
      const runId = String(data.result.runId);
      commitMessages(messagesRef.current.map((message) => message.id === assistantId ? { ...message, runId, status: 'queued' } : message));
      setActiveRun(runId);
    } catch (error) {
      commitMessages(messagesRef.current.map((message) => message.id === assistantId
        ? { ...message, status: 'failed', text: error instanceof Error ? error.message : 'Could not start HII chat.' }
        : message));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#fbfbfa]">
      <div ref={scrollRef} className="scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mx-auto mt-16 max-w-[260px] text-center">
            <div className="text-[20px] font-semibold tracking-[-0.03em] text-[var(--hii-graphite)]">Think with the workspace.</div>
            <p className="mt-2 text-[12px] leading-relaxed text-neutral-500">Type a question or paste media. Send queues an inspectable Codex run; prompts and attachments may go to your configured provider.</p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={message.role === 'user' ? 'ml-8 rounded-2xl rounded-br-md bg-neutral-900 px-3.5 py-3 text-white' : 'mr-4 px-1 py-2 text-[var(--hii-graphite)]'}>
            {message.attachments?.length ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {message.attachments.map((attachment) => <span key={attachment.path} className="max-w-full truncate rounded-full bg-white/15 px-2 py-1 font-mono text-[9px]">{attachmentLabel(attachment)}</span>)}
              </div>
            ) : null}
            <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed">{message.text}</pre>
            {message.status && message.status !== 'completed' ? <div className="mt-2 font-mono text-[9px] uppercase tracking-widest opacity-50">{message.status}</div> : null}
          </div>
        ))}
      </div>
      <div className="border-t border-neutral-900/10 bg-white p-3">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <button key={attachment.path} type="button" onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))} className="max-w-[190px] truncate rounded-full bg-neutral-100 px-2.5 py-1 font-mono text-[9px] text-neutral-600" title="Remove attachment">
                {attachmentLabel(attachment)} ×
              </button>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (!files.length) {
              for (const item of [...event.clipboardData.items]) {
                const file = item.kind === 'file' ? item.getAsFile() : null;
                if (file) files.push(file);
              }
            }
            if (!files.length) return;
            event.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Message HII or paste media…"
          className="h-20 w-full resize-none bg-transparent text-[12px] leading-relaxed text-[var(--hii-graphite)] outline-none placeholder:text-neutral-400"
        />
        <div className="flex items-center justify-between">
          <label className="cursor-pointer rounded-full px-2 py-1 font-mono text-[10px] text-neutral-500 hover:bg-neutral-100">
            + media
            <input type="file" multiple className="sr-only" onChange={(event) => addFiles([...(event.target.files || [])])} />
          </label>
          <button type="button" disabled={uploading || Boolean(activeRun) || (!draft.trim() && attachments.length === 0)} onClick={send} className="rounded-full bg-[var(--hii-electric-blue)] px-3 py-1.5 font-mono text-[10px] font-semibold text-white disabled:opacity-30">
            {uploading ? 'adding…' : activeRun ? 'working…' : 'send to Codex ↵'}
          </button>
        </div>
      </div>
    </div>
  );
}
