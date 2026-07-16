'use client';

import { useRef, useState } from 'react';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type NodeBodyProps = {
  node: WorkspaceNode;
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

type CropInset = { top: number; right: number; bottom: number; left: number };

function normalizeCrop(value: unknown): CropInset {
  const raw = value && typeof value === 'object' ? value as Partial<CropInset> : {};
  return {
    top: Math.min(45, Math.max(0, Number(raw.top) || 0)),
    right: Math.min(45, Math.max(0, Number(raw.right) || 0)),
    bottom: Math.min(45, Math.max(0, Number(raw.bottom) || 0)),
    left: Math.min(45, Math.max(0, Number(raw.left) || 0))
  };
}

export function ImageNode({ node, onPayload }: NodeBodyProps) {
  const url = node.payload.url;
  const isSessionOnly = node.payload.ephemeral === true;
  const [editingCrop, setEditingCrop] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const crop = normalizeCrop(node.payload.crop);
  if (typeof url !== 'string' || !url) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-400">
        image was session-only — re-drop to restore
      </div>
    );
  }

  const renderCrop = (action: 'extract' | 'export') => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const sourceX = Math.round(image.naturalWidth * crop.left / 100);
    const sourceY = Math.round(image.naturalHeight * crop.top / 100);
    const sourceWidth = Math.max(1, Math.round(image.naturalWidth * (100 - crop.left - crop.right) / 100));
    const sourceHeight = Math.max(1, Math.round(image.naturalHeight * (100 - crop.top - crop.bottom) / 100));
    const canvas = document.createElement('canvas');
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    canvas.getContext('2d')?.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const base = String(node.payload.name || 'image').replace(/\.[^.]+$/, '');
      const fileName = `${base}-crop.png`;
      if (action === 'extract') {
        window.dispatchEvent(new CustomEvent('hii:media-file', { detail: new File([blob], fileName, { type: 'image/png' }) }));
        return;
      }
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }, 'image/png');
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-[linear-gradient(45deg,#f7f7f5_25%,transparent_25%),linear-gradient(-45deg,#f7f7f5_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f7f7f5_75%),linear-gradient(-45deg,transparent_75%,#f7f7f5_75%)] bg-[length:16px_16px]">
      <img
        ref={imageRef}
        src={url}
        alt={String(node.payload.name ?? '')}
        draggable={false}
        className="h-full w-full object-contain"
        style={{ clipPath: `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)` }}
      />
      <SessionBadge show={isSessionOnly} />
      <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-neutral-950/85 p-1 opacity-0 shadow-lg backdrop-blur transition-opacity group-hover:opacity-100">
        <button type="button" onClick={() => setEditingCrop((value) => !value)} className="rounded-full px-2.5 py-1 font-mono text-[9px] text-white hover:bg-white/15">crop</button>
        <button type="button" onClick={() => renderCrop('extract')} className="rounded-full px-2.5 py-1 font-mono text-[9px] text-white hover:bg-white/15">extract</button>
        <button type="button" onClick={() => renderCrop('export')} className="rounded-full px-2.5 py-1 font-mono text-[9px] text-white hover:bg-white/15">export</button>
      </div>
      {editingCrop && (
        <div className="absolute right-2 top-2 w-44 rounded-lg bg-white/95 p-3 shadow-[0_8px_30px_rgba(23,23,23,0.18),0_0_0_1px_rgba(23,23,23,0.1)] backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-widest text-neutral-500">crop inset</span>
            <button type="button" onClick={() => onPayload({ crop: { top: 0, right: 0, bottom: 0, left: 0 } })} className="font-mono text-[9px] text-neutral-400 hover:text-neutral-800">reset</button>
          </div>
          {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
            <label key={edge} className="mb-1.5 grid grid-cols-[42px_1fr_25px] items-center gap-1 font-mono text-[9px] text-neutral-500">
              {edge}
              <input type="range" min="0" max="45" value={crop[edge]} onChange={(event) => onPayload({ crop: { ...crop, [edge]: Number(event.target.value) } })} className="h-1 accent-[var(--hii-electric-blue)]" />
              {crop[edge]}%
            </label>
          ))}
        </div>
      )}
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
