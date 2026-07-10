'use client';

import type { CanvasNode } from '../../../lib/canvas/types';

type NodeBodyProps = {
  node: CanvasNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

function formatBytes(value: unknown) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let i = 1; amount >= 1024 && i < units.length; i += 1) {
    amount /= 1024;
    unit = units[i];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function SessionBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute right-2 top-2 rounded bg-white/90 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500 shadow-[0_0_0_1px_rgba(23,23,23,0.08)]">
      session-only
    </div>
  );
}

export function NoteNode({ node, onPayload }: NodeBodyProps) {
  return (
    <textarea
      value={String(node.payload.text ?? '')}
      onChange={(e) => onPayload({ text: e.target.value })}
      placeholder="note…"
      spellCheck={false}
      className="h-full w-full resize-none bg-transparent p-3 text-[13px] leading-relaxed text-[var(--hii-graphite)] outline-none placeholder:text-neutral-300"
    />
  );
}

export function TextNode({ node }: NodeBodyProps) {
  return (
    <pre className="scroll h-full w-full overflow-auto whitespace-pre p-3 font-mono text-[11px] leading-[1.55] text-[var(--hii-graphite)]">
      {String(node.payload.content ?? '')}
    </pre>
  );
}

export function LinkNode({ node }: NodeBodyProps) {
  const url = String(node.payload.url ?? '');
  const host = String(node.payload.host ?? '');
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block h-full w-full p-3.5 no-underline">
      <div className="text-[13px] font-semibold text-[var(--hii-graphite)]">🔗 {host || 'link'}</div>
      <div className="mt-1 break-all font-mono text-[11px] text-neutral-500">{url}</div>
    </a>
  );
}

export function FileNode({ node }: NodeBodyProps) {
  const size = formatBytes(node.payload.size);
  const mime = String(node.payload.mime || 'unknown type');
  const label = String(node.payload.label || node.payload.category || 'file');
  const description = String(node.payload.description || 'Preview not embedded; metadata only.');
  const extension = String(node.payload.extension || '').toUpperCase();
  return (
    <div className="flex h-full min-h-0 gap-3 p-4">
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-neutral-50 text-[24px] shadow-[inset_0_0_0_1px_rgba(23,23,23,0.06)]">
        {String(node.payload.emoji ?? '📄')}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[13px] font-medium text-[var(--hii-graphite)]">{String(node.payload.name ?? 'file')}</div>
          {extension && <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[9px] text-neutral-500">{extension}</span>}
        </div>
        <div className="mt-1 font-mono text-[10px] text-neutral-500">
          {[label, size, mime].filter(Boolean).join(' / ')}
        </div>
        <div className="mt-2 text-[11px] leading-snug text-neutral-500">{description}</div>
        <div className="mt-1 font-mono text-[10px] text-neutral-400">raw contents not saved</div>
      </div>
    </div>
  );
}

export function ImageNode({ node }: NodeBodyProps) {
  const url = node.payload.url;
  const isSessionOnly = node.payload.ephemeral === true;
  if (typeof url !== 'string' || !url) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-400">
        image was session-only — re-drop to restore
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <img src={url} alt={String(node.payload.name ?? '')} draggable={false} className="h-full w-full object-contain" />
      <SessionBadge show={isSessionOnly} />
    </div>
  );
}

export function MediaNode({ node }: NodeBodyProps) {
  const url = node.payload.url;
  const kind = String(node.payload.kind ?? 'video');
  const isSessionOnly = node.payload.ephemeral === true;
  if (typeof url !== 'string' || !url) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-400">
        media was session-only — re-drop to restore
      </div>
    );
  }
  if (kind === 'audio') {
    return (
      <div className="relative flex h-full flex-col justify-center gap-2 p-3">
        <div className="min-w-0 pr-28">
          <div className="truncate text-[13px] font-medium text-[var(--hii-graphite)]">{String(node.payload.name ?? 'audio')}</div>
          <div className="font-mono text-[10px] text-neutral-500">{[formatBytes(node.payload.size), String(node.payload.mime || 'audio')].filter(Boolean).join(' / ')}</div>
        </div>
        <audio src={url} controls preload="metadata" className="w-full" />
        <SessionBadge show={isSessionOnly} />
      </div>
    );
  }
  if (kind === 'pdf') {
    return (
      <div className="relative h-full w-full">
        <embed src={url} type="application/pdf" className="h-full w-full" />
        <SessionBadge show={isSessionOnly} />
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <video src={url} controls playsInline preload="metadata" className="h-full w-full bg-black object-contain" />
      <SessionBadge show={isSessionOnly} />
    </div>
  );
}

export function HtmlNode({ node }: NodeBodyProps) {
  return (
    <iframe
      srcDoc={String(node.payload.srcdoc ?? '')}
      sandbox=""
      title={String(node.payload.name ?? 'html snippet')}
      className="h-full w-full border-0 bg-white"
    />
  );
}

export function FontNode({ node }: NodeBodyProps) {
  const fam = node.payload.fam;
  const isSessionOnly = node.payload.ephemeral === true;
  if (typeof fam !== 'string' || !fam) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-400">
        font was session-only — re-drop to restore
      </div>
    );
  }
  return (
    <div className="relative h-full p-5" style={{ fontFamily: `'${fam}'` }}>
      <div className="text-[34px] leading-tight text-[var(--hii-graphite)]">Aa Bb Cc 0123</div>
      <div className="mt-1.5 text-[14px] text-neutral-500">The quick brown fox jumps over the lazy dog</div>
      <SessionBadge show={isSessionOnly} />
    </div>
  );
}
