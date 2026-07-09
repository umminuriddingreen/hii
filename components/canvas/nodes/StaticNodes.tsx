'use client';

import type { CanvasNode } from '../../../lib/canvas/types';

type NodeBodyProps = {
  node: CanvasNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

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
  const size = Number(node.payload.size ?? 0);
  return (
    <div className="flex h-full items-center gap-3 px-4">
      <div className="text-[28px]">{String(node.payload.emoji ?? '📄')}</div>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-[var(--hii-graphite)]">{String(node.payload.name ?? 'file')}</div>
        <div className="font-mono text-[10px] text-neutral-500">
          {String(node.payload.mime || 'unknown')} · {(size / 1024).toFixed(1)} KB
        </div>
      </div>
    </div>
  );
}

export function ImageNode({ node }: NodeBodyProps) {
  const url = node.payload.url;
  if (typeof url !== 'string' || !url) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-400">
        image was session-only — re-drop to restore
      </div>
    );
  }
  return <img src={url} alt={String(node.payload.name ?? '')} draggable={false} className="h-full w-full object-contain" />;
}

export function MediaNode({ node }: NodeBodyProps) {
  const url = node.payload.url;
  const kind = String(node.payload.kind ?? 'video');
  if (typeof url !== 'string' || !url) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-400">
        media was session-only — re-drop to restore
      </div>
    );
  }
  if (kind === 'audio') return <audio src={url} controls preload="metadata" className="w-full p-2" />;
  if (kind === 'pdf') return <embed src={url} type="application/pdf" className="h-full w-full" />;
  return <video src={url} controls playsInline preload="metadata" className="h-full w-full bg-black object-contain" />;
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
  if (typeof fam !== 'string' || !fam) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-400">
        font was session-only — re-drop to restore
      </div>
    );
  }
  return (
    <div className="p-5" style={{ fontFamily: `'${fam}'` }}>
      <div className="text-[34px] leading-tight text-[var(--hii-graphite)]">Aa Bb Cc 0123</div>
      <div className="mt-1.5 text-[14px] text-neutral-500">The quick brown fox jumps over the lazy dog</div>
    </div>
  );
}
