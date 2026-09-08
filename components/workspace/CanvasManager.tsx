'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  canvasManagerBoards,
  canvasManagerHits,
  type CanvasManagerBoard,
  type CanvasManagerHit
} from '@/lib/workspace/canvas-manager';
import type { WorkspaceNode } from '@/lib/workspace/types';
import styles from './CanvasManager.module.css';

/**
 * The view behind Escape: every board at once, one search field across all of
 * them, and the boards themselves as a scrollable feed.
 *
 * The body is a list of sections rather than a fixed layout. A section decides
 * for itself whether it has anything to show, so a new one — recents, shared
 * boards, agent activity — is added by appending a descriptor, not by editing
 * the shell.
 */

export type CanvasManagerContext = {
  query: string;
  nodes: WorkspaceNode[];
  boards: CanvasManagerBoard[];
  hits: CanvasManagerHit[];
  focusBoard: (board: CanvasManagerBoard) => void;
  focusNode: (node: WorkspaceNode) => void;
  close: () => void;
};

export type CanvasManagerSection = {
  id: string;
  title: string;
  /** Return null to take up no space at all. */
  render: (context: CanvasManagerContext) => ReactNode;
};

function relativeTime(iso: string) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(then).toLocaleDateString();
}

const searchSection: CanvasManagerSection = {
  id: 'search',
  title: 'Across every board',
  render: ({ query, hits, focusNode }) => {
    if (!query.trim()) return null;
    if (!hits.length) return <p className={styles.empty}>Nothing on any board matches “{query.trim()}”.</p>;
    return (
      <ul className={styles.hits}>
        {hits.map((hit) => (
          <li key={hit.node.id}>
            <button type="button" className={styles.hit} onClick={() => focusNode(hit.node)}>
              <span className={styles.hitTitle}>{hit.title}</span>
              <span className={styles.hitMeta}>{hit.node.type.replaceAll('-', ' ')}</span>
              <span className={styles.hitBoard}>{hit.boardTitle}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
};

function BoardPreview({ board }: { board: CanvasManagerBoard }) {
  if (!board.tiles.length) return <div className={styles.preview}><span className={styles.previewEmpty}>Empty board</span></div>;
  return (
    <div className={styles.preview}>
      {board.tiles.map((tile) => (
        <div
          key={tile.id}
          className={styles.tile}
          data-matched={tile.matched}
          style={{
            left: `${tile.x * 100}%`,
            top: `${tile.y * 100}%`,
            width: `${Math.max(tile.w * 100, 1.5)}%`,
            height: `${Math.max(tile.h * 100, 1.5)}%`
          }}
        >
          {tile.url ? <img className={styles.tileImage} src={tile.url} alt="" draggable={false} /> : null}
        </div>
      ))}
    </div>
  );
}

const feedSection: CanvasManagerSection = {
  id: 'feed',
  title: 'Your canvases',
  render: ({ boards, query, focusBoard, close }) => {
    if (!boards.length) {
      return query.trim() ? <p className={styles.empty}>No board holds a match.</p> : (
        <div className={styles.emptyState}>
          <p className={styles.empty}>Nothing here yet. Return to the canvas and add text or a file to get started.</p>
          <button type="button" className={styles.close} onClick={close}>Back to canvas</button>
        </div>
      );
    }
    return (
      <div className={styles.feed}>
        {boards.map((board) => (
          <button type="button" key={board.id} className={styles.card} onClick={() => focusBoard(board)}>
            <BoardPreview board={board} />
            <span className={styles.cardText}>
              <span className={styles.cardTitle}>
                {board.sequence ? <span className={styles.sequence}>{board.sequence}</span> : null}
                <span className={styles.cardName}>{board.title}</span>
              </span>
              <span className={styles.cardMeta}>
                {board.memberCount} object{board.memberCount === 1 ? '' : 's'} · {board.summary}
                {board.updatedAt ? ` · ${relativeTime(board.updatedAt)}` : ''}
              </span>
              {board.matches.length ? (
                <span className={styles.cardMatches}>
                  {board.matches.length} match{board.matches.length === 1 ? '' : 'es'}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    );
  }
};

export const CANVAS_MANAGER_SECTIONS: CanvasManagerSection[] = [searchSection, feedSection];

export function CanvasManager({
  nodes,
  onFocusBoard,
  onFocusNode,
  onClose,
  sections = CANVAS_MANAGER_SECTIONS
}: {
  nodes: WorkspaceNode[];
  onFocusBoard: (board: CanvasManagerBoard) => void;
  onFocusNode: (node: WorkspaceNode) => void;
  onClose: () => void;
  sections?: CanvasManagerSection[];
}) {
  const [query, setQuery] = useState('');
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setPortalRoot(document.body); }, []);

  useEffect(() => {
    if (!portalRoot) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) searchRef.current?.focus();
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [portalRoot]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const controls = [...(shellRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]'
        ) ?? [])].filter((element) => element.tabIndex >= 0 && !element.matches(':disabled')
          && !element.closest('[hidden], [inert]') && getComputedStyle(element).display !== 'none'
          && getComputedStyle(element).visibility !== 'hidden');
        const first = controls[0];
        const last = controls[controls.length - 1];
        const active = document.activeElement;
        if (!first || !shellRef.current?.contains(active) || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    // Capture so the canvas keymap underneath never sees this Escape.
    window.addEventListener('keydown', keydown, { capture: true });
    return () => window.removeEventListener('keydown', keydown, { capture: true });
  }, [onClose]);

  const boards = useMemo(() => canvasManagerBoards(nodes, query), [nodes, query]);
  const hits = useMemo(() => canvasManagerHits(nodes, query), [nodes, query]);

  const context: CanvasManagerContext = {
    query,
    nodes,
    boards,
    hits,
    focusBoard: onFocusBoard,
    focusNode: onFocusNode,
    close: onClose
  };

  const rendered = sections
    .map((section) => ({ section, content: section.render(context) }))
    .filter((entry) => entry.content !== null && entry.content !== undefined);

  if (!portalRoot) return null;

  // Escape the canvas stacking context and its touch-action: none so this
  // modal covers account controls and its feed can scroll on touch screens.
  return createPortal(
    <div ref={shellRef} className={styles.shell} role="dialog" aria-modal="true" aria-label="Canvas manager">
      <header className={styles.bar}>
        <span className={styles.title}>Canvases</span>
        <span className={styles.count}>{boards.length}</span>
        <div className={styles.spacer} />
        <input
          ref={searchRef}
          className={styles.search}
          value={query}
          placeholder="Search every board…"
          aria-label="Search every board"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const first = hits[0];
            if (first) onFocusNode(first.node);
            else if (boards[0]) onFocusBoard(boards[0]);
          }}
        />
        <button type="button" className={styles.close} onClick={onClose}>Close · Esc</button>
      </header>

      <div className={styles.body}>
        {rendered.map(({ section, content }) => (
          <section key={section.id} className={styles.section}>
            <h2 className={styles.sectionTitle}>{section.title}</h2>
            {content}
          </section>
        ))}
      </div>
    </div>,
    portalRoot
  );
}
